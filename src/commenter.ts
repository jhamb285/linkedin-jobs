import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AppConfig } from "./types";
import type { Store } from "./store";
import { loadPrompt } from "./config";

interface LeadContent {
  summary: string;
  commentAj: string;
  commentPk: string;
  connectionNoteAj: string;
  connectionNotePk: string;
  dmAj: string;
  dmPk: string;
}

function parseLeadContent(text: string): LeadContent | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.summary || !parsed.commentAj || !parsed.commentPk) return null;
    return {
      summary: parsed.summary || "",
      commentAj: parsed.commentAj || "",
      commentPk: parsed.commentPk || "",
      connectionNoteAj: parsed.connectionNoteAj || "",
      connectionNotePk: parsed.connectionNotePk || "",
      dmAj: parsed.dmAj || "",
      dmPk: parsed.dmPk || "",
    };
  } catch {
    return null;
  }
}

/**
 * Generate outreach content for each lead with both AJ and PK personas.
 * Each lead gets 6 pieces: comment_aj, comment_pk, connection_aj, connection_pk, dm_aj, dm_pk.
 */
export async function runGenerator(
  config: AppConfig,
  store: Store,
  dryRun: boolean = false
): Promise<void> {
  const leads = store.getHighScoringUncommented(config.scoringThreshold);

  if (leads.length === 0) {
    console.log("No high-scoring posts without comments.");
    return;
  }

  console.log(`Generating dual-persona content for ${leads.length} leads with Gemini...\n`);

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: config.geminiModel });
  const template = loadPrompt("lead-prompt");

  let generated = 0;
  let skipped = 0;

  for (const lead of leads) {
    if (store.wasAuthorCommentedRecently(lead.author_url ?? "")) {
      console.log(`  [skip] Already engaged with ${lead.author_name} recently`);
      skipped++;
      continue;
    }

    const prompt = template
      .replace("{post_content}", lead.content.slice(0, 2000))
      .replace("{author_name}", lead.author_name)
      .replace("{author_headline}", lead.author_headline)
      .replace("{positioning}", lead.positioning);

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const content = parseLeadContent(text);

      if (!content) {
        console.log(`  [skip] Bad generation for ${lead.id}`);
        continue;
      }

      if (dryRun) {
        console.log(`  [dry-run] ${lead.author_name} (${lead.positioning}):`);
        console.log(`    AJ Comment: "${content.commentAj.slice(0, 100)}..."`);
        console.log(`    PK Comment: "${content.commentPk.slice(0, 100)}..."`);
        console.log();
      } else {
        // Store primary comment (PK version) in comments table for existing flows
        store.insertComment(lead.id, content.commentPk);

        // Store full dual-persona content in lead_content table
        store.insertLeadContent(lead.id, content.summary, {
          commentAj: content.commentAj,
          commentPk: content.commentPk,
          connectionNoteAj: content.connectionNoteAj,
          connectionNotePk: content.connectionNotePk,
          dmAj: content.dmAj,
          dmPk: content.dmPk,
        });

        console.log(
          `  [queued] ${lead.author_name} → AJ + PK comments + connection notes + DMs`
        );
      }

      generated++;
    } catch (err) {
      console.error(
        `  [!] Error for ${lead.id}: ${(err as Error).message}`
      );
    }
  }

  console.log(
    `\nGeneration complete: ${generated} leads ${dryRun ? "(dry-run)" : "queued with dual personas"}, ${skipped} skipped (dedup)`
  );
}
