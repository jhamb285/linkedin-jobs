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
      // contact_identities.metadata.tags AND geo signals in the post
      // body. Penalty depth is GEO-AWARE: per 2026-05-19 user direction,
      // recruiters (Indian or otherwise) posting contract roles for
      // developed-country clients are valid leads — the staffing-firm
      // tag alone shouldn't crush them. We only apply the heavy penalty
      // when the role itself looks India-located (IST hours, INR pay,
      // "in India").
      //
      // Penalties net is clamped to [-30, +25].
      const tags = await store.getAuthorTags(post.authorUrl);
      const bodyLower = post.content.toLowerCase();
      const headlineLower = post.authorHeadline.toLowerCase();
      // Reuse the same target-region anchors used by the scraper rescue
      // logic to detect dev-country-located roles in body.
      const DEV_COUNTRY_MARKERS = [
        "united states", " usa ", " u.s.", "us-based", "us based",
        "uk-based", "uk based", "europe-based", "europe based",
        "australia", "australian", "singapore", "uae",
        "in the us", "in the usa", "in the uk", "in europe", "in the eu",
        "remote us", "remote (us", "remote uk", "remote (uk", "remote eu",
        " usd", "$/hr", "/hr usd", "per hour usd",
        "£/hr", "eur/hr", " eur ", "€/hr",
        " est ", " pst ", " cst ", " edt ", " pdt ",
        "eastern time", "pacific time", "central time",
        "us shift", "us hours",
      ];
      const INDIA_ROLE_MARKERS = [
        "in india", "india-based role", "based in india", "remote within india",
        "ist hours", "ist time", "ist shift", "indian standard time",
        " inr ", " inr,", " inr.", "₹", "lakh", "lakhs", "lpa", "ctc:",
        "indian candidates", "candidates from india",
      ];
      const headlineHasIndiaCity = /(bangalore|bengaluru|hyderabad|mumbai|delhi|chennai|pune|kolkata|noida|gurgaon|gurugram)/i.test(headlineLower);
      const bodyHasDevCountry = DEV_COUNTRY_MARKERS.some((m) => bodyLower.includes(m));
      const bodyHasIndiaRole = INDIA_ROLE_MARKERS.some((m) => bodyLower.includes(m)) || headlineHasIndiaCity;
      // "Role is in a dev country, recruiter just happens to be a
      // staffing firm" → soften the penalty. "Role is in India" → keep
      // the original hard penalty (we don't want IST/INR roles).
      const roleLooksDevCountry = bodyHasDevCountry && !bodyHasIndiaRole;

      let adjustment = 0;
      const adjReasons: string[] = [];

      if (tags.includes("staffing-firm")) {
        if (roleLooksDevCountry) {
          adjustment -= 5;
          adjReasons.push("staffing-firm-dev:-5");
        } else {
          adjustment -= 25;
          adjReasons.push("staffing-firm:-25");
        }
      }
      if (tags.includes("recruiter") && !tags.includes("target-fit")) {
        if (roleLooksDevCountry) {
          // Recruiter posting a dev-country contract is the buyer's
          // intermediary — score normally based on the role.
          adjReasons.push("recruiter-dev:0");
        } else {
          adjustment -= 20;
          adjReasons.push("recruiter:-20");
        }
      }
      if (tags.includes("agency-founder")) {
        if (roleLooksDevCountry) {
          adjustment -= 5;
          adjReasons.push("agency-founder-dev:-5");
        } else {
          adjustment -= 18;
          adjReasons.push("agency-founder:-18");
        }
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

      // Positive tag boosts are gated on rawTotal >= 8 — the LLM has
      // already vetted the post as not-REJECT. Otherwise a competitor /
      // thought-leadership / promo post that happens to be authored by a
      // product-founder gets its score rescued from 0 to 12+ by tags
      // alone. Observed 2026-05-19 on re-score: 5 REJECT posts climbed
      // back into the top-15 via product-founder:+12. The LLM's REJECT
      // verdict must win.
      const rawIsBuyer = rawTotal >= 8;
      if (rawIsBuyer && tags.includes("product-founder")) {
        adjustment += 12;
        adjReasons.push("product-founder:+12");
      }
      if (
        rawIsBuyer &&
        tags.includes("founder") &&
        tags.includes("target-fit") &&
        !tags.includes("agency-founder")
      ) {
        adjustment += 10;
        adjReasons.push("founder-target:+10");
      }
      if (
        rawIsBuyer &&
        tags.includes("executive") &&
        tags.includes("target-fit")
      ) {
        adjustment += 10;
        adjReasons.push("exec-target:+10");
      }
      if (
        rawIsBuyer &&
        tags.includes("founder") &&
        tags.includes("ai-engineering") &&
        !tags.includes("agency-founder")
      ) {
        adjustment += 6;
        adjReasons.push("founder-ai:+6");
      }

      // CEO / Founder direct-hire boost.
      //
      // The single highest-converting lead pattern is a product-company
      // CEO or Founder hiring a specific role themselves (not via a
      // recruiter). When the headline matches CEO/Founder/CTO AND the
      // body has explicit hiring intent AND we don't have an
      // agency-founder tag, push the score up significantly — these
      // are the easiest contracts to close.
      // Hiring-intent is stronger when multiple distinct phrases hit.
      // Single "needed" alone over-triggered (Andrew G. thought-leader
      // post got +12). Require ≥2 distinct matches OR an explicit
      // role-title hiring phrase. Also gate on rawIsBuyer (LLM already
      // judges it's a real hire) so a 0-rated REJECT can't be rescued.
      const HIRING_INTENT_STRONG = [
        "we are looking for", "i'm looking for", "i am looking for",
        "i need a", "we need a", "hiring a", "we're hiring",
        "i'm hiring", "looking to hire", "want to hire",
        "freelance developer", "contract developer",
        "looking for a developer", "looking for someone",
      ];
      const HIRING_INTENT_WEAK = [
        "needed", "wanted ", "open role", "open position",
        "freelancer needed", "developer needed",
      ];
      const strongHits = HIRING_INTENT_STRONG.filter((p) => bodyLower.includes(p)).length;
      const weakHits = HIRING_INTENT_WEAK.filter((p) => bodyLower.includes(p)).length;
      // Strong signal: at least one phrase that explicitly says hiring.
      // Or two weak phrases combined (e.g. "developer needed" + "open role").
      const hasHiringIntent = strongHits >= 1 || weakHits >= 2;
      const isFounderOrExec =
        tags.includes("founder") || tags.includes("executive");
      if (
        rawIsBuyer &&
        isFounderOrExec &&
        hasHiringIntent &&
        !tags.includes("agency-founder") &&
        !tags.includes("staffing-firm") &&
        !bodyHasIndiaRole
      ) {
        adjustment += 12;
        adjReasons.push("direct-hire-ceo:+12");
      }

      adjustment = Math.max(-30, Math.min(25, adjustment));
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
