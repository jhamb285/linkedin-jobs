import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AppConfig, PostScore, ScoringResult, ScrapedPost } from "./types";
import type { Store } from "./store";
import { loadPromptDbFirst } from "./config";
import { analyzeRemoteDays } from "./hybrid-filter";
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

export async function runScorer(
  config: AppConfig,
  store: Store
): Promise<void> {
  const unscored = await store.getUnscoredPosts();
  if (unscored.length === 0) {
    console.log("No unscored posts found.");
    return;
  }

  console.log(`Scoring ${unscored.length} posts with Gemini Flash...\n`);

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: config.geminiModel });
  const template = await loadPromptDbFirst("scoring-prompt");

  let scored = 0;
  let highScore = 0;
  let errors = 0;

  for (const post of unscored) {
    const prompt = buildScoringPrompt(template, post);

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();

      const parsed = parseScoringResponse(text);

      if (!parsed) {
        console.error(`  [!] Failed to parse score for ${post.id}`);
        errors++;
        continue;
      }

      // Deterministic hybrid/remote filter — overrides AI if it found clear signal
      const hybridAnalysis = analyzeRemoteDays(post.content);
      let adjustedFit = parsed.fit;
      let adjustedReasoning = parsed.reasoning;

      if (hybridAnalysis.reject) {
        // Hard reject: too much onsite detected
        adjustedFit = 0;
        adjustedReasoning = `[AUTO-REJECT] ${hybridAnalysis.reason}. ${parsed.reasoning}`;
      } else if (hybridAnalysis.remoteDays !== null && hybridAnalysis.remoteDays >= 3) {
        // Force approve: 3+ days remote detected, upgrade fit if AI was too low
        if (adjustedFit < 5) adjustedFit = Math.max(adjustedFit, 6);
        adjustedReasoning = `[AUTO-APPROVE] ${hybridAnalysis.reason}. ${parsed.reasoning}`;
      }

      const total =
        parsed.relevance +
        adjustedFit +
        parsed.urgency +
        parsed.engagementPotential;

      const score: PostScore = {
        postId: post.id,
        ...parsed,
        fit: adjustedFit,
        reasoning: adjustedReasoning,
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
          fit: adjustedFit,
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
