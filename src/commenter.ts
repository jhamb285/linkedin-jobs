import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AppConfig, ScrapedPost } from "./types";
import type { Store } from "./store";
import { loadPromptDbFirst } from "./config";
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
 * Strip Twitter-style "@AuthorName" mentions from outreach text.
 *
 * 2026-04-30: SELECTIVE re-introduction — the COMMENT keeps its @-tag
 * (the LinkedIn feed uses it to notify the author), but DMs, connection
 * notes, follow-up DMs, and emails must NEVER contain @-mentions
 * because they're private channels and look robotic. Despite explicit
 * prompt rules, Gemini was still emitting "@FirstName" in DMs — so we
 * strip at the code level as a hard backstop.
 *
 * Match pattern: @ followed by a word char, optionally with .-_ and
 * more word chars, but NOT preceded by a word char or `.` (so
 * "user@example.com" stays intact — the @ there has a word char before it).
 */
function stripAtMentions(text: string | null): string | null {
  if (!text) return text;
  return text.replace(/(^|[^\w.])@(\w[\w.-]*)/g, (_m, before) => before);
}

// ---------------------------------------------------------------------------
// RAG footer — appended to every comment / connection note / DM / email so
// the prospect always has the founder's portfolio link to click through to.
// Connection notes have a hard 300-char LinkedIn limit; we trim the LLM body
// to fit the footer rather than dropping the URL.
// ---------------------------------------------------------------------------

function getRagUrl(persona: Persona): string | null {
  const url =
    persona === "pk"
      ? process.env.RAG_BASE_URL_PK
      : process.env.RAG_BASE_URL_AJ;
  const trimmed = url?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function withRagFooter(
  text: string,
  persona: Persona,
  opts: { separator?: string; maxLen?: number } = {},
): string {
  const url = getRagUrl(persona);
  if (!url) return text;
  const sep = opts.separator ?? "\n\n";
  const footer = `${sep}More: ${url}`;
  if (opts.maxLen === undefined) return text + footer;
  if (text.length + footer.length <= opts.maxLen) return text + footer;
  const room = Math.max(0, opts.maxLen - footer.length);
  return text.slice(0, room).trimEnd() + footer;
}

function withRagFooterOpt(
  text: string | null,
  persona: Persona,
  opts?: { separator?: string; maxLen?: number },
): string | null {
  if (!text) return text;
  return withRagFooter(text, persona, opts);
}

function appendRagFooter(
  content: SinglePersonaContent,
  persona: Persona,
): SinglePersonaContent {
  return {
    ...content,
    comment: withRagFooter(content.comment, persona),
    // LinkedIn caps connection notes at 300 chars — trim body to fit.
    connectionNote: withRagFooter(content.connectionNote, persona, {
      separator: "\n",
      maxLen: 300,
    }),
    dm: withRagFooter(content.dm, persona),
    email: withRagFooterOpt(content.email, persona),
  };
}

function sanitize(content: SinglePersonaContent): SinglePersonaContent {
  return {
    ...content,
    // 2026-05-19: strip @ from comments too. User feedback: starting
    // every comment with "@Author" looks robotic and the LinkedIn feed
    // notification works without it (the post owner gets notified
    // either way when their post receives a reply).
    comment: linkedinFormat(stripAtMentions(content.comment) ?? ""),
    connectionNote: stripAtMentions(content.connectionNote) ?? "",
    dm: linkedinFormat(stripAtMentions(content.dm) ?? ""),
    email: stripAtMentions(content.email),
    emailSubject: stripAtMentions(content.emailSubject),
  };
}

// LinkedIn doesn't render markdown — `**bold**` shows up literally as
// asterisks in the feed. The platform Unicode equivalent is
// Mathematical Sans-Serif Bold (𝗯𝗼𝗹𝗱), which LinkedIn does display
// bold. This converts **text** spans to Unicode bold so the LLM can
// keep writing markdown and we get the visual effect we want.
const BOLD_LATIN_LOWER_OFFSET = 0x1d5ee - "a".charCodeAt(0); // 𝗮 - a
const BOLD_LATIN_UPPER_OFFSET = 0x1d5d4 - "A".charCodeAt(0); // 𝗔 - A
const BOLD_DIGIT_OFFSET = 0x1d7ec - "0".charCodeAt(0); // 𝟬 - 0
function toUnicodeBold(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x61 && code <= 0x7a) {
      out += String.fromCodePoint(code + BOLD_LATIN_LOWER_OFFSET);
    } else if (code >= 0x41 && code <= 0x5a) {
      out += String.fromCodePoint(code + BOLD_LATIN_UPPER_OFFSET);
    } else if (code >= 0x30 && code <= 0x39) {
      out += String.fromCodePoint(code + BOLD_DIGIT_OFFSET);
    } else {
      out += ch;
    }
  }
  return out;
}

function linkedinFormat(text: string): string {
  if (!text) return text;
  // Convert **bold** → Unicode sans-serif bold. Non-greedy to avoid
  // joining two separate bold runs across a sentence.
  return text.replace(/\*\*([^*]+?)\*\*/g, (_m, inner) => toUnicodeBold(inner));
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
  // DB-first: pulls the latest prompt from content_prompts (edited via the
  // platform UI), falls back to the on-disk .md file if the DB row is
  // missing or unreachable.
  const promptByPersona: Record<Persona, string> = {
    pk: await loadPromptDbFirst("lead-prompt-pk"),
    aj: await loadPromptDbFirst("lead-prompt-aj"),
  };

  let generated = 0;
  let skippedDedup = 0;
  let parseFailed = 0;
  let apiError = 0;
  let ragOk = 0;
  let ragFail = 0;

  for (const lead of leads) {
    const persona: Persona = lead.assignedPersona;

    if (await store.wasAuthorCommentedRecently(lead.author_url ?? "")) {
      console.log(
        `  [skip] Already engaged with ${lead.author_name} recently`,
      );
      skippedDedup++;
      await recordEvent({
        eventType: "draft.skipped",
        workflow: "linkedin_jobs",
        actor: "linkedin-jobs.commenter",
        payload: {
          postId: lead.id,
          persona,
          scoreTotal: lead.total,
          reason: "author-commented-recently",
        },
      });
      continue;
    }

    // RAG grounding for this persona. Soft-fails — if the API is down or
    // returns nothing, we fall back to a no-context prompt.
    const matches = await fetchExpertiseMatches(persona, lead.content, 3);
    if (matches.ok && matches.matchCount > 0) ragOk++;
    else ragFail++;
    const ragContext = matches.context || "(no matches available)";

    // When the post body contains an explicit email address, force the
    // drafter to ALWAYS produce an email body addressed to that contact.
    // Without this directive the LLM treats email as optional (~48% rate
    // in prior runs); operator wants 100% coverage when an email is
    // present in the post.
    const detectedEmail =
      (lead as ScrapedPost & { detectedEmail?: string | null }).detectedEmail ??
      null;
    const emailDirective = detectedEmail
      ? `\n\n## EMAIL REQUIRED\nThe post contains the email "${detectedEmail}". You MUST produce a non-empty email + emailSubject in your response. Address the email to ${lead.author_name} at that address. Keep the email peer-to-peer, ≤180 words, with the same persona voice as the comment.`
      : "";

    const prompt =
      promptByPersona[persona]
        .replace("{post_content}", lead.content.slice(0, 2000))
        .replace("{author_name}", lead.author_name)
        .replace("{author_headline}", lead.author_headline)
        .replace("{positioning}", lead.positioning)
        .replace("{rag_context}", ragContext) + emailDirective;

    try {
      // 1 retry on bad parse — Gemini occasionally returns malformed JSON
      // even on identical input. Keeps a single transient hiccup from
      // dropping a real lead silently.
      let parsed: SinglePersonaContent | null = null;
      let lastText = "";
      for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
        const result = await model.generateContent(prompt);
        lastText = result.response.text();
        parsed = parseSinglePersonaContent(lastText);
        if (!parsed && attempt === 1) {
          console.log(
            `  [retry] Parse failed on first attempt for ${lead.author_name} (${persona}), retrying...`,
          );
        }
      }

      if (!parsed) {
        parseFailed++;
        await recordEvent({
          eventType: "draft.failed",
          workflow: "linkedin_jobs",
          actor: "linkedin-jobs.commenter",
          payload: {
            postId: lead.id,
            persona,
            scoreTotal: lead.total,
            reason: "parse-failed",
            // First 400 chars of the unparseable text so we can audit
            // recurring Gemini formatting issues from Settings analytics.
            rawSample: lastText.slice(0, 400),
          },
        });
        console.log(
          `  [drop] Parse failed (after retry) for ${lead.author_name} (${persona})`,
        );
        continue;
      }

      // sanitize first (strip @ mentions, etc.), THEN append RAG footer so
      // the URL is never accidentally stripped by the mention-cleanup regex.
      const sanitized = appendRagFooter(sanitize(parsed), persona);

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
      apiError++;
      const message = (err as Error).message ?? String(err);
      await recordEvent({
        eventType: "draft.failed",
        workflow: "linkedin_jobs",
        actor: "linkedin-jobs.commenter",
        payload: {
          postId: lead.id,
          persona,
          scoreTotal: lead.total,
          reason: "api-error",
          error: message.slice(0, 400),
        },
      });
      console.error(
        `  [!] API error for ${lead.author_name} (${persona}): ${message}`,
      );
    }
  }

  console.log(
    `\nGeneration complete: ${generated} ${dryRun ? "(dry-run)" : "drafts written"}, ${skippedDedup} skipped-dedup, ${parseFailed} parse-failed, ${apiError} api-error. RAG: ${ragOk} grounded / ${ragFail} fallback.`,
  );
}
