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

      const rawTotal =
        parsed.relevance +
        adjustedFit +
        parsed.urgency +
        parsed.engagementPotential;

      // Tag-aware deterministic score adjustment.
      //
      // The LLM-produced rawTotal is a starting point. We then nudge it
      // based on what classifyAuthor (run during scrape) wrote to
      // contact_identities.metadata.tags. This makes the recruiter
      // penalty hard-deterministic instead of relying on the LLM to
      // re-interpret a prompt every single call.
      //
      // Penalties stack but the net adjustment is clamped to [-30, +15]
      // so a single misclassification can't slam a real lead to 0.
      const tags = await store.getAuthorTags(post.authorUrl);
      let adjustment = 0;
      const adjReasons: string[] = [];

      if (tags.includes("staffing-firm")) {
        adjustment -= 25;
        adjReasons.push("staffing-firm:-25");
      }
      if (tags.includes("recruiter") && !tags.includes("target-fit")) {
        adjustment -= 20;
        adjReasons.push("recruiter:-20");
      }
      if (tags.includes("agency-founder")) {
        adjustment -= 18;
        adjReasons.push("agency-founder:-18");
      }
      if (tags.includes("low-engagement")) {
        adjustment -= 10;
        adjReasons.push("low-engagement:-10");
      }
      if (
        tags.includes("company-page") &&
        !tags.includes("ai-engineering")
      ) {
        adjustment -= 8;
        adjReasons.push("generic-company:-8");
      }

      if (tags.includes("product-founder")) {
        adjustment += 12;
        adjReasons.push("product-founder:+12");
      }
      if (
        tags.includes("founder") &&
        tags.includes("target-fit") &&
        !tags.includes("agency-founder")
      ) {
        adjustment += 10;
        adjReasons.push("founder-target:+10");
      }
      if (tags.includes("executive") && tags.includes("target-fit")) {
        adjustment += 10;
        adjReasons.push("exec-target:+10");
      }
      if (
        tags.includes("founder") &&
        tags.includes("ai-engineering") &&
        !tags.includes("agency-founder")
      ) {
        adjustment += 6;
        adjReasons.push("founder-ai:+6");
      }

      adjustment = Math.max(-30, Math.min(15, adjustment));
      const total = Math.max(0, Math.min(40, rawTotal + adjustment));
      const tagReasoningSuffix =
        adjReasons.length > 0
          ? ` [raw=${rawTotal} adj=${adjustment >= 0 ? "+" : ""}${adjustment} tags=${adjReasons.join(",")}]`
          : ` [raw=${rawTotal} adj=0]`;
      const finalReasoning = adjustedReasoning + tagReasoningSuffix;

      const score: PostScore = {
        postId: post.id,
        ...parsed,
        fit: adjustedFit,
        reasoning: finalReasoning,
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
          rawTotal,
          tagAdjustment: adjustment,
          tagReasons: adjReasons,
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
