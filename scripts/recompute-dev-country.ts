/**
 * One-off rescore: re-apply the post-LLM tag adjustment to scored
 * LinkedIn posts using the updated dev-country detector in matcher.ts
 * (commit b5d0119, 2026-05-21).
 *
 * Use case: when matcher.ts:148 widens the dev-country detection (now
 * trusts parsed.fit>=8 and includes US states / approved-market
 * countries / cities), every already-scored post that was unfairly
 * penalized by recruiter:-20, staffing-firm:-25, or agency-founder:-18
 * needs its total recomputed without re-calling Gemini.
 *
 * What it changes:
 *   - scores.total      (recomputed)
 *   - scores.reasoning  (new [raw=X adj=Y tags=...] suffix)
 *
 * What it does NOT change:
 *   - scores.relevance / fit / urgency / engagement_potential (those
 *     are LLM outputs; recompute would require re-calling Gemini)
 *   - posts.metadata
 *   - contact_identities.metadata.tags
 *
 * Usage:
 *   bun run scripts/recompute-dev-country.ts --dry      # preview only
 *   bun run scripts/recompute-dev-country.ts            # apply
 *
 * Idempotent: re-running produces the same suffix when logic is
 * unchanged, so it's safe to run twice.
 */
import { sql, eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { Store } from "../src/store";

const store = new Store();

const DRY = process.argv.includes("--dry");

// Mirror of the matcher.ts dev-country detector (b5d0119). Keep in sync.
const DEV_COUNTRY_MARKERS = [
  "united states", " usa", " u.s.", "us-based", "us based", " us ",
  "uk-based", "uk based", "united kingdom", " uk ", "britain", "british",
  "europe-based", "europe based", " eu ", "european union", "eea",
  "australia", "australian", " au ", " aus ",
  "new zealand", " nz ", "kiwi",
  "singapore", " sg ", "s'pore",
  "uae", "emirates", "abu dhabi", "dubai",
  "saudi", "ksa", "riyadh", "jeddah",
  "norway", "norwegian", "oslo",
  "malaysia", "malaysian", "kuala lumpur",
  "canada", "canadian", "toronto", "vancouver", "montreal",
  "germany", "german", "berlin", "munich", "frankfurt",
  "france", " french", "paris",
  "netherlands", "amsterdam", "rotterdam",
  "switzerland", "swiss", "zurich", "geneva",
  "sweden", "stockholm", "denmark", "copenhagen",
  "finland", "helsinki", "ireland", "dublin",
  "spain", "madrid", "barcelona",
  "italy", "italian", "rome", "milan",
  "belgium", "brussels", "portugal", "lisbon",
  "austria", "vienna",
  " ca ", " ny ", " nyc ", " tx ", " fl ", " wa ", " ma ", " il ",
  " ga ", " va ", " nc ", " nj ", " co ", " or ", " mi ", " oh ",
  " pa ", " md ", " az ", " nv ", " mn ", " ct ", " wi ", " mo ",
  " new york", " california", " texas", " florida", " washington",
  " massachusetts", " illinois", " virginia", " new jersey",
  " colorado", " georgia", "san francisco", "los angeles", "bay area",
  "chicago", "boston", "seattle", "austin", "atlanta", "denver",
  "miami", "washington dc", " d.c.", "houston", "dallas",
  "london", "manchester", "birmingham", "edinburgh", "glasgow", "bristol",
  "sydney", "melbourne", "brisbane", "perth", "auckland", "wellington",
  "in the us", "in the usa", "in the uk", "in europe", "in the eu",
  "across the us", "across europe",
  "remote us", "remote (us", "remote uk", "remote (uk", "remote eu",
  "remote, us", "remote, uk", "remote – us", "remote – uk",
  "us only", "uk only", "eu only", "us-only", "uk-only",
  "us citizens", "us residents", "us work auth", "us-based candidates",
  " usd", "usd ", "usd/", "/usd", "/hr usd", "per hour usd",
  "$/hr", "$/hour", "/hour usd",
  "£", "£/hr", "gbp", "eur/hr", "€", " eur ", "€/hr",
  "aud", "nzd", "sgd", "aed", "sar", "nok", "chf", "cad",
  "$100k", "$120k", "$150k", "$200k", "$250k",
  " est ", " pst ", " cst ", " edt ", " pdt ", " mst ", " mdt ", " et ", " pt ",
  "eastern time", "pacific time", "central time", "mountain time",
  "us shift", "us hours",
  " bst ", " gmt ", " cet ", " cest ",
  "h1b", "h-1b", "uscis", " ead ", "green card", "tn visa", " gc ",
  "us work authorization",
];
const INDIA_ROLE_MARKERS = [
  "in india", "india-based role", "based in india", "remote within india",
  "ist hours", "ist time", "ist shift", "indian standard time",
  " inr ", " inr,", " inr.", "₹", "lakh", "lakhs", "lpa", "ctc:",
  "indian candidates", "candidates from india",
];
const INDIA_CITY_RE = /(bangalore|bengaluru|hyderabad|mumbai|delhi|chennai|pune|kolkata|noida|gurgaon|gurugram)/i;

interface ScoredPost {
  postId: string;
  authorName: string;
  authorHeadline: string;
  authorUrl: string;
  content: string;
  relevance: number;
  fit: number;
  urgency: number;
  engagementPotential: number;
  total: number;
  reasoning: string;
}

function recomputeAdjustment(
  post: ScoredPost,
  tags: string[],
): { adjustment: number; reasons: string[] } {
  const bodyLower = post.content.toLowerCase();
  const headlineLower = (post.authorHeadline ?? "").toLowerCase();
  const headlineHasIndiaCity = INDIA_CITY_RE.test(headlineLower);
  const bodyHasDevCountry = DEV_COUNTRY_MARKERS.some((m) => bodyLower.includes(m));
  const bodyHasIndiaRole =
    INDIA_ROLE_MARKERS.some((m) => bodyLower.includes(m)) || headlineHasIndiaCity;
  const roleLooksDevCountry =
    !bodyHasIndiaRole && (post.fit >= 8 || bodyHasDevCountry);

  let adjustment = 0;
  const reasons: string[] = [];

  if (tags.includes("staffing-firm")) {
    if (roleLooksDevCountry) {
      adjustment -= 5;
      reasons.push("staffing-firm-dev:-5");
    } else {
      adjustment -= 25;
      reasons.push("staffing-firm:-25");
    }
  }
  if (tags.includes("recruiter") && !tags.includes("target-fit")) {
    if (roleLooksDevCountry) {
      reasons.push("recruiter-dev:0");
    } else {
      adjustment -= 20;
      reasons.push("recruiter:-20");
    }
  }
  if (tags.includes("agency-founder")) {
    if (roleLooksDevCountry) {
      adjustment -= 5;
      reasons.push("agency-founder-dev:-5");
    } else {
      adjustment -= 18;
      reasons.push("agency-founder:-18");
    }
  }
  if (tags.includes("low-engagement")) {
    adjustment -= 10;
    reasons.push("low-engagement:-10");
  }
  if (tags.includes("company-page") && !tags.includes("ai-engineering")) {
    adjustment -= 8;
    reasons.push("generic-company:-8");
  }

  // Positive boosts left as-is (already conservative; rerunning them
  // requires the hiring-intent re-scan from matcher.ts which we'd want
  // to keep aligned with whatever the live scorer does next time).
  // For this recompute we only un-block false negatives — we don't
  // resurrect previously-applied positive boosts.

  adjustment = Math.max(-30, Math.min(25, adjustment));
  return { adjustment, reasons };
}

function extractRawTotal(reasoning: string): number | null {
  const m = reasoning.match(/\[raw=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function stripSuffix(reasoning: string): string {
  return reasoning.replace(/\s*\[raw=\d+.*\]\s*$/, "");
}

async function main() {
  console.log(`[recompute] mode=${DRY ? "DRY" : "APPLY"}`);

  const rows = (
    await db.execute(sql`
      SELECT
        p.id        AS "postId",
        p.author_name AS "authorName",
        p.author_headline AS "authorHeadline",
        p.author_url AS "authorUrl",
        p.content,
        s.relevance,
        s.fit,
        s.urgency,
        s.engagement_potential AS "engagementPotential",
        s.total,
        s.reasoning
      FROM scores s
      JOIN posts p ON p.id = s.post_id
      WHERE p.source = 'linkedin_jobs'
        AND s.scored_at > now() - interval '14 days'
    `)
  ).rows as ScoredPost[];

  console.log(`[recompute] loaded ${rows.length} scored posts from last 14d`);

  let updated = 0;
  let liftedOverThreshold = 0;
  let netChange = 0;

  for (const post of rows) {
    const rawTotal = extractRawTotal(post.reasoning);
    if (rawTotal === null) {
      continue; // can't recompute without raw
    }

    const tags = await store.getAuthorTags(post.authorUrl);
    const { adjustment, reasons } = recomputeAdjustment(post, tags);
    const newTotal = Math.max(0, Math.min(40, rawTotal + adjustment));

    if (newTotal === post.total) continue;

    const suffix =
      reasons.length > 0
        ? ` [raw=${rawTotal} adj=${adjustment >= 0 ? "+" : ""}${adjustment} tags=${reasons.join(",")}]`
        : ` [raw=${rawTotal} adj=0]`;
    const newReasoning = stripSuffix(post.reasoning) + suffix;

    const delta = newTotal - post.total;
    netChange += delta;
    if (post.total < 20 && newTotal >= 20) liftedOverThreshold++;

    console.log(
      `  ${delta > 0 ? "+" : ""}${delta}  ${post.total}->${newTotal}  ${post.authorName.slice(0, 25).padEnd(25)}  ${reasons.join(",") || "no-tags"}`,
    );

    if (!DRY) {
      await db
        .update(schema.scores)
        .set({ total: newTotal, reasoning: newReasoning })
        .where(eq(schema.scores.postId, post.postId));
    }
    updated++;
  }

  console.log("");
  console.log(`[recompute] ${DRY ? "would update" : "updated"} ${updated} scores`);
  console.log(`[recompute] ${liftedOverThreshold} posts crossed the threshold (now >= 20)`);
  console.log(`[recompute] net total delta = ${netChange >= 0 ? "+" : ""}${netChange}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
