import { createVertexClient } from "./lib/vertex";
import { meteredGenerate } from "./lib/gemini-meter";
import type { AppConfig, PostScore, ScoringResult, ScrapedPost } from "./types";
import type { Store } from "./store";
import { loadPromptDbFirst } from "./config";
import { recordEvent } from "./events";

function buildScoringPrompt(
  template: string,
  post: ScrapedPost
): string {
  return template
    .replace("{post_content}", post.content.slice(0, 2000))
    .replace("{author_name}", post.authorName)
    .replace("{author_headline}", post.authorHeadline);
}

function parseScoringResponse(text: string): ScoringResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    const relevance = Math.min(10, Math.max(0, parsed.relevance ?? 0));
    const fit = Math.min(10, Math.max(0, parsed.fit ?? 0));
    const urgency = Math.min(10, Math.max(0, parsed.urgency ?? 0));
    const engagementPotential = Math.min(
      10,
      Math.max(0, parsed.engagementPotential ?? 0)
    );

    const validPositions = ["agent_dev", "consulting", "automation_agency"] as const;
    const positioning = validPositions.includes(parsed.positioning)
      ? parsed.positioning
      : "consulting";

    return {
      relevance,
      fit,
      urgency,
      engagementPotential,
      positioning,
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Score every unscored post with Gemini (via Vertex AI).
 *
 * 2026-06: Gemini is the SINGLE source of truth for scoring. The scrape
 * layer now only dedups — it no longer hard-rejects on geo/intent — so
 * every deduped post reaches this scorer. We also dropped the old
 * deterministic post-LLM layer (recruiter/founder tag adjustments + the
 * hybrid-day override). That layer double-counted signals the prompt
 * already weighs and repeatedly killed real leads (see git history,
 * 2026-05). All geo / remote-vs-onsite / competitor / gig-farm / dual-lead
 * judgment now lives in config/scoring-prompt.md — edit the rubric there,
 * not code, to tune lead quality.
 */
export async function runScorer(
  config: AppConfig,
  store: Store
): Promise<void> {
  const unscored = await store.getUnscoredPosts();
  if (unscored.length === 0) {
    console.log("No unscored posts found.");
    return;
  }

  console.log(`Scoring ${unscored.length} posts with Gemini (Vertex AI)...\n`);

  const model = createVertexClient({ model: config.geminiModel });
  const template = await loadPromptDbFirst("scoring-prompt");
  const meterCtx: import("./lib/gemini-meter").MeterContext = {
    pipeline: "linkedin",
  };

  let scored = 0;
  let highScore = 0;
  let errors = 0;

  for (const post of unscored) {
    const prompt = buildScoringPrompt(template, post);

    try {
      const result = await meteredGenerate(
        model,
        config.geminiModel,
        "matcher",
        prompt,
        meterCtx,
      );
      const text = result.response.text();

      const parsed = parseScoringResponse(text);

      if (!parsed) {
        console.error(`  [!] Failed to parse score for ${post.id}`);
        errors++;
        continue;
      }

      // Total is the straight sum of the four LLM dimensions, clamped to
      // [0, 40]. No deterministic nudges — what Gemini returns is the score.
      const total = Math.max(
        0,
        Math.min(
          40,
          parsed.relevance +
            parsed.fit +
            parsed.urgency +
            parsed.engagementPotential,
        ),
      );

      const score: PostScore = {
        postId: post.id,
        ...parsed,
        total,
        scoredAt: new Date().toISOString(),
      };

      await store.insertScore(score);
      scored++;

      await recordEvent({
        eventType: "score.completed",
        workflow: "linkedin_jobs",
        actor: "linkedin-jobs.matcher",
        payload: {
          postId: post.id,
          total,
          relevance: parsed.relevance,
          fit: parsed.fit,
          urgency: parsed.urgency,
          engagementPotential: parsed.engagementPotential,
          positioning: parsed.positioning,
          highScore: total >= config.scoringThreshold,
        },
      });

      const marker = total >= config.scoringThreshold ? ">>>" : "   ";
      console.log(
        `  ${marker} [${total}/40] ${post.authorName.slice(0, 20).padEnd(20)} | ${parsed.positioning} | ${parsed.reasoning.slice(0, 60)}`
      );

      if (total >= config.scoringThreshold) highScore++;
    } catch (err) {
      console.error(`  [!] API error for ${post.id}: ${(err as Error).message}`);
      errors++;
    }
  }

  console.log(
    `\nScoring complete: ${scored} scored, ${highScore} high-score (${config.scoringThreshold}+), ${errors} errors`
  );
}
