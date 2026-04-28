import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AppConfig } from "./types";
import type { Store } from "./store";
import { loadPrompt } from "./config";
import { recordEvent } from "./events";
import { fetchExpertiseMatches, type Persona } from "./expertise";

interface SinglePersonaContent {
  summary: string;
  comment: string;
  connectionNote: string;
  dm: string;
  emailSubject: string | null;
  email: string | null;
}

function parseSinglePersonaContent(text: string): SinglePersonaContent | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.comment || !parsed.connectionNote || !parsed.dm) return null;
    return {
      summary: parsed.summary || "",
      comment: parsed.comment || "",
      connectionNote: parsed.connectionNote || "",
      dm: parsed.dm || "",
      emailSubject:
        typeof parsed.emailSubject === "string" && parsed.emailSubject
          ? parsed.emailSubject
          : null,
      email: typeof parsed.email === "string" && parsed.email ? parsed.email : null,
    };
  } catch {
    return null;
  }
}

/**
 * Strip Twitter-style "@AuthorName" mentions from outreach text. We
 * still allow real email addresses (anything matching ".+@.+\..+") to
 * pass through, since the email body legitimately contains contact
 * addresses.
 *
 * Match pattern: @ followed by a word char, optionally with .-_ and
 * more word chars, but NOT preceded by a word char or `.` (so
 * "user@example.com" stays intact — the @ there has a word char before it).
 */
const AT_MENTION_RE = /(?<![\w.])@\w+(?:[._-]\w+)*/g;

function stripAtMentions(s: string): string {
  return s.replace(AT_MENTION_RE, "").replace(/\s{2,}/g, " ").trim();
}

function sanitize(content: SinglePersonaContent): SinglePersonaContent {
  return {
    summary: stripAtMentions(content.summary),
    comment: stripAtMentions(content.comment),
    connectionNote: stripAtMentions(content.connectionNote),
    dm: stripAtMentions(content.dm),
    emailSubject: content.emailSubject
      ? stripAtMentions(content.emailSubject)
      : null,
    email: content.email ? stripAtMentions(content.email) : null,
  };
}

/**
 * Per-persona, RAG-grounded content generation. For each batched-and-
 * assigned post:
 *   1. Look up the assigned persona ('aj' | 'pk')
 *   2. Query that persona's Expertise API for the top 3 relevant past
 *      projects
 *   3. Build the persona's prompt with {rag_context}, {post_content},
 *      etc.
 *   4. Call Gemini, parse JSON, strip @ mentions
 *   5. Insert a single engagement_drafts row for (post, persona)
 *
 * Posts not in the active batch (i.e. without an assigned_user_id) are
 * skipped — the lead-split feature deliberately limits content gen to
 * the batched set, keeping AJ and PK queues disjoint.
 */
export async function runGenerator(
  config: AppConfig,
  store: Store,
  dryRun: boolean = false,
): Promise<void> {
  const leads = await store.getBatchedAssignedUncommented(config.scoringThreshold);

  if (leads.length === 0) {
    console.log("No batched-and-assigned posts pending content gen.");
    return;
  }

  console.log(
    `Generating per-persona RAG-grounded content for ${leads.length} leads...\n`,
  );

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: config.geminiModel });
  const promptByPersona: Record<Persona, string> = {
    pk: loadPrompt("lead-prompt-pk"),
    aj: loadPrompt("lead-prompt-aj"),
  };

  let generated = 0;
  let skipped = 0;
  let ragOk = 0;
  let ragFail = 0;

  for (const lead of leads) {
    const persona: Persona = lead.assignedPersona;

    if (await store.wasAuthorCommentedRecently(lead.author_url ?? "")) {
      console.log(
        `  [skip] Already engaged with ${lead.author_name} recently`,
      );
      skipped++;
      continue;
    }

    // RAG grounding for this persona. Soft-fails — if the API is down or
    // returns nothing, we fall back to a no-context prompt.
    const matches = await fetchExpertiseMatches(persona, lead.content, 3);
    if (matches.ok && matches.matchCount > 0) ragOk++;
    else ragFail++;
    const ragContext = matches.context || "(no matches available)";

    const prompt = promptByPersona[persona]
      .replace("{post_content}", lead.content.slice(0, 2000))
      .replace("{author_name}", lead.author_name)
      .replace("{author_headline}", lead.author_headline)
      .replace("{positioning}", lead.positioning)
      .replace("{rag_context}", ragContext);

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = parseSinglePersonaContent(text);

      if (!parsed) {
        console.log(`  [skip] Bad generation for ${lead.id}`);
        continue;
      }

      const sanitized = sanitize(parsed);

      if (dryRun) {
        console.log(
          `  [dry-run] ${lead.author_name} → ${persona.toUpperCase()}:`,
        );
        console.log(`    Comment: "${sanitized.comment.slice(0, 100)}..."`);
        console.log();
      } else {
        await store.insertPersonaDraft(lead.id, persona, {
          comment: sanitized.comment,
          connectionNote: sanitized.connectionNote,
          dm: sanitized.dm,
          email: sanitized.email,
          emailSubject: sanitized.emailSubject,
        });

        await recordEvent({
          eventType: "draft.generated",
          workflow: "linkedin_jobs",
          actor: "linkedin-jobs.commenter",
          payload: {
            postId: lead.id,
            persona,
            scoreTotal: lead.total,
            positioning: lead.positioning,
            ragMatched: matches.matchCount,
            ragOk: matches.ok,
            hasEmail: Boolean(sanitized.email),
          },
        });

        console.log(
          `  [queued] ${lead.author_name} → ${persona.toUpperCase()} draft (RAG: ${matches.ok ? matches.matchCount + " matches" : "fallback"})`,
        );
      }

      generated++;
    } catch (err) {
      console.error(
        `  [!] Error for ${lead.id} (${persona}): ${(err as Error).message}`,
      );
    }
  }

  console.log(
    `\nGeneration complete: ${generated} ${dryRun ? "(dry-run)" : "drafts written"}, ${skipped} skipped (dedup). RAG: ${ragOk} grounded / ${ragFail} fallback.`,
  );
}
