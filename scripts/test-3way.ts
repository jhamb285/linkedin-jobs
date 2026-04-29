/**
 * ⚠️ KNOWN BUG (2026-04-29): This runner sends `searchQueries: [<all queries>]`
 * with a single `maxPosts` value, expecting harvestapi to treat maxPosts as a
 * total cap. harvestapi treats it as PER-QUERY. Strategy C with 20 queries +
 * maxPosts=250 fetched 948 posts ($1.8960), not 250 ($0.50). Do not re-run
 * any strategy until either (a) the runner is changed to loop one query per
 * call like production scraper.ts:589-733, or (b) maxPosts is divided by
 * len(queries) so the per-query ceiling × number-of-queries respects the
 * total budget.
 *
 * See docs/3way-test-results.md for full incident write-up.
 *
 * 3-way LinkedIn-Jobs sourcing test runner — one-off, $1.50 budget split
 * across four strategies (C baseline, A apimaestro pre-filter, B1 curated
 * companies, B2 curated individuals).
 *
 * Design constraints (see /Users/par1k/.claude/plans/compiled-cooking-storm.md):
 *
 * 1. SHARES the production `posts` table + the `checkLocation` /
 *    `quickIntentFilter` filter chain. Tags every inserted row with a
 *    `test_run_id` so post-test cleanup is a single DELETE and the daily
 *    queue can filter test rows out.
 *
 * 2. DOES NOT WRITE to `scrape_run_queries`. That table feeds
 *    `Store.getTodayScrapeFetched()` (store.ts:744) which the production
 *    cron uses to enforce the IST-day scrape budget — writing here would
 *    shrink tomorrow's live budget.
 *
 * 3. Writes ONE `apify_runs` row per strategy (via direct db client —
 *    Store.startScrapeRun hardcodes the actor name) so cost shows up on
 *    the founder dashboard, tagged `actor: "test-3way-<strategy>"`.
 *
 * 4. Per-post cost is an explicit CLI flag — config.ts default
 *    ($0.0015/post) is stale (harvestapi raised to $2/1k). Runner does
 *    not read it from config.
 *
 * 5. Replicates scraper.ts:587 48h `dateCutoff` exactly.
 *
 * Usage:
 *   bun scripts/test-3way.ts --strategy=C --dry-run
 *   bun scripts/test-3way.ts --strategy=A --per-post-cost=0.0012 --max-cost=0.50
 *   bun scripts/test-3way.ts --strategy=B1 --per-post-cost=0.002 --max-cost=0.50
 *   bun scripts/test-3way.ts --strategy=B2 --per-post-cost=0.002 --max-cost=0.05  # gated probe first
 *
 * Rollback:
 *   psql "$DATABASE_URL" -f scripts/test-3way-rollback.sql
 */

import { ApifyClient } from "apify-client";
import { readFileSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { Store } from "../src/store";
import { db, schema } from "../src/db";
import {
  checkLocation,
  quickIntentFilter,
  isRecentPost,
  normalizeApifyResult,
} from "../src/scraper";
import {
  fetchArticleBody,
  extractArticleLink,
  looksTruncated,
  mergeTeaserAndArticle,
} from "../src/article-fetch";
import type { ScrapedPost } from "../src/types";

// ─── strategies ───────────────────────────────────────────────────────────

type Strategy = "A" | "B1" | "B2" | "C";

const TEST_RUN_ID: Record<Strategy, string> = {
  A: "test-A-apimaestro",
  B1: "test-B1-curated-co",
  B2: "test-B2-curated-ind",
  C: "test-C-baseline",
};

const DEFAULT_ACTOR: Record<Strategy, string> = {
  A: "apimaestro/linkedin-posts-search-scraper-no-cookies",
  B1: "harvestapi/linkedin-post-search",
  B2: "harvestapi/linkedin-post-search",
  C: "harvestapi/linkedin-post-search",
};

// ─── flag parsing ─────────────────────────────────────────────────────────

interface Flags {
  strategy: Strategy;
  dryRun: boolean;
  maxCost: number;
  perPostCost: number;
  actor: string;
  targetsFile: string;
  apimaestroFiltersFile: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (k: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : undefined;
  };
  const strategyRaw = get("strategy");
  if (!strategyRaw || !["A", "B1", "B2", "C"].includes(strategyRaw)) {
    throw new Error(
      "--strategy=<A|B1|B2|C> is required (A=apimaestro, B1=curated companies, B2=curated individuals, C=baseline)",
    );
  }
  const strategy = strategyRaw as Strategy;
  const perPostCost = parseFloat(get("per-post-cost") ?? "");
  if (Number.isNaN(perPostCost) || perPostCost <= 0) {
    throw new Error(
      "--per-post-cost=<float> is required (don't read from config.ts — value is stale; harvestapi=0.002, apimaestro≈0.0012)",
    );
  }
  return {
    strategy,
    dryRun: argv.includes("--dry-run"),
    maxCost: parseFloat(get("max-cost") ?? "0.50"),
    perPostCost,
    actor: get("actor") ?? DEFAULT_ACTOR[strategy],
    targetsFile:
      get("targets-file") ??
      join(__dirname, "..", "config", "test-3way-targets.json"),
    apimaestroFiltersFile:
      get("apimaestro-filters-file") ??
      join(__dirname, "..", "config", "test-3way-apimaestro-filters.json"),
  };
}

// ─── inputs per strategy ──────────────────────────────────────────────────

interface Target {
  name: string;
  type: string;
  country: string;
  linkedinIdentifier: string;
  isCompany: boolean;
  linkedinUrl?: string;
  reason?: string;
  confidence?: string;
}

function loadTargets(path: string): Target[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array at ${path}, got ${typeof parsed}`);
  }
  return parsed as Target[];
}

interface ApimaestroFilters {
  /** Industry URNs to INCLUDE (AI/software/tech-startups). */
  authorIndustryUrns?: string[];
  /** Industry URNs to EXCLUDE (IT services / staffing). */
  authorExcludeIndustryUrns?: string[];
  /** Job-title patterns to require on the author. */
  authorJobTitle?: string[];
  /** Company URNs to filter by (verified-supported per Apify search snippet). */
  authorCompanyUrns?: string[];
  /** Comma-separated keywords to search. */
  keywords: string[];
}

function loadApimaestroFilters(path: string): ApimaestroFilters {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed.keywords || !Array.isArray(parsed.keywords)) {
    throw new Error(
      `Expected { keywords: string[], ... } at ${path}; populate after live-verifying the apimaestro input schema (see plan §3 gate #2)`,
    );
  }
  return parsed as ApimaestroFilters;
}

function buildActorInput(
  flags: Flags,
  maxPosts: number,
  dateCutoff: string,
): Record<string, unknown> {
  switch (flags.strategy) {
    case "C": {
      // Baseline: production v1 queries combined into ONE call.
      const queriesFile = join(
        __dirname,
        "..",
        "config",
        "search-queries.json",
      );
      const queries = JSON.parse(readFileSync(queriesFile, "utf-8")) as Array<{
        query: string;
      }>;
      return {
        searchQueries: queries.map((q) => q.query),
        maxPosts,
        sortBy: "date",
        postedLimitDate: dateCutoff,
      };
    }
    case "B1": {
      const targets = loadTargets(flags.targetsFile).filter(
        (t) => t.isCompany && (t.confidence ?? "verified") !== "unverified",
      );
      if (targets.length === 0) {
        throw new Error(
          `No company-page targets in ${flags.targetsFile} — populate the curated list first`,
        );
      }
      // Use the production v1 search queries SO B1 ↔ C is apples-to-apples
      // on the search-space dimension, with the author filter the only
      // independent variable. (The actor REQUIRES searchQueries.)
      const queriesFile = join(
        __dirname,
        "..",
        "config",
        "search-queries.json",
      );
      const queries = JSON.parse(readFileSync(queriesFile, "utf-8")) as Array<{
        query: string;
      }>;
      return {
        searchQueries: queries.map((q) => q.query),
        maxPosts,
        sortBy: "date",
        postedLimitDate: dateCutoff,
        authorsCompanyPublicIdentifiers: targets.map(
          (t) => t.linkedinIdentifier,
        ),
      };
    }
    case "B2": {
      const targets = loadTargets(flags.targetsFile).filter(
        (t) => !t.isCompany && (t.confidence ?? "verified") !== "unverified",
      );
      if (targets.length === 0) {
        throw new Error(
          `No individual-profile targets in ${flags.targetsFile} — populate the curated list first`,
        );
      }
      // GATE #3: the harvestapi field name for "scrape posts BY a specific
      // person" is implied but not pinned. authorsProfilePublicIdentifiers
      // is the symmetric guess. If the actor 400s, fall back to a search
      // with post-hoc filtering on author.publicIdentifier.
      const queriesFile = join(
        __dirname,
        "..",
        "config",
        "search-queries.json",
      );
      const queries = JSON.parse(readFileSync(queriesFile, "utf-8")) as Array<{
        query: string;
      }>;
      return {
        searchQueries: queries.map((q) => q.query),
        maxPosts,
        sortBy: "date",
        postedLimitDate: dateCutoff,
        authorsProfilePublicIdentifiers: targets.map(
          (t) => t.linkedinIdentifier,
        ),
      };
    }
    case "A": {
      // apimaestro: keyword + limit + sortBy:"date_posted" + postedLimitDate
      // + (gated) author URN/title filters. The test fans out by issuing
      // ONE call per keyword and accumulates items up to maxPosts.
      const filters = loadApimaestroFilters(flags.apimaestroFiltersFile);
      // Single call per first-keyword for the request body printer; the
      // executor below loops keywords if multiple are provided.
      const firstKeyword = filters.keywords[0] ?? "ai engineer contract";
      return {
        keyword: firstKeyword,
        limit: maxPosts,
        sortBy: "date_posted",
        postedLimitDate: dateCutoff,
        // The next three fields are HYPOTHETICAL — verified in dry-run
        // against the live actor schema. If unsupported, abort Strategy A.
        ...(filters.authorIndustryUrns && {
          authorIndustryUrns: filters.authorIndustryUrns,
        }),
        ...(filters.authorJobTitle && {
          authorJobTitle: filters.authorJobTitle,
        }),
        ...(filters.authorCompanyUrns && {
          authorCompanyUrns: filters.authorCompanyUrns,
        }),
      };
    }
  }
}

// ─── apify_runs row write (direct, bypasses Store.startScrapeRun) ─────────

async function writeApifyRunsRow(
  flags: Flags,
  startedAt: Date,
): Promise<string> {
  const inserted = await db
    .insert(schema.apifyRuns)
    .values({
      runId: `test-3way-${flags.strategy}-${Date.now()}`,
      actor: `test-3way-${flags.strategy}`,
      startedAt,
      status: "running",
    })
    .returning({ id: schema.apifyRuns.id });
  return inserted[0].id;
}

async function finishApifyRunsRow(
  runUuid: string,
  costUsd: number,
): Promise<void> {
  await db
    .update(schema.apifyRuns)
    .set({
      completedAt: new Date(),
      totalCostUsd: String(costUsd.toFixed(4)),
      status: "completed",
    })
    .where(eq(schema.apifyRuns.id, runUuid));
}

// ─── main ─────────────────────────────────────────────────────────────────

interface Counters {
  fetched: number;
  rejectedDate: number;
  rejectedNormalize: number;
  rejectedDedupContent: number;
  rejectedGeo: number;
  rejectedIntent: number;
  rejectedDedupDb: number;
  rejectedDupePostId: number;
  inserted: number;
  geoReasons: Record<string, number>;
  intentReasons: Record<string, number>;
}

function emptyCounters(): Counters {
  return {
    fetched: 0,
    rejectedDate: 0,
    rejectedNormalize: 0,
    rejectedDedupContent: 0,
    rejectedGeo: 0,
    rejectedIntent: 0,
    rejectedDedupDb: 0,
    rejectedDupePostId: 0,
    inserted: 0,
    geoReasons: {},
    intentReasons: {},
  };
}

async function processItems(
  items: Array<Record<string, unknown>>,
  query: string,
  testRunId: string,
  store: Store,
  counters: Counters,
  seenFingerprints: Set<string>,
): Promise<void> {
  const { createHash } = await import("crypto");
  const contentFingerprint = (authorName: string, content: string): string => {
    const normalized = (authorName + content).replace(/\s+/g, " ").trim().slice(0, 200);
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  };

  for (const raw of items) {
    counters.fetched++;
    const postedAt = (raw.postedAt ?? raw.posted_at) as
      | Record<string, unknown>
      | undefined;
    if (!isRecentPost(postedAt, 48)) {
      counters.rejectedDate++;
      continue;
    }
    const post = normalizeApifyResult(raw, query);
    if (!post) {
      counters.rejectedNormalize++;
      continue;
    }
    // Article enrichment with 5s timeout to bound the test window.
    if (looksTruncated(post.content)) {
      const link = extractArticleLink(raw);
      if (link) {
        try {
          const body = await Promise.race([
            fetchArticleBody(link),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
          if (body && body.length > post.content.length) {
            post.content = mergeTeaserAndArticle(post.content, body);
          }
        } catch {
          // ignore — best-effort enrichment
        }
      }
    }
    const fp = contentFingerprint(post.authorName, post.content);
    if (seenFingerprints.has(fp)) {
      counters.rejectedDedupContent++;
      continue;
    }
    seenFingerprints.add(fp);

    const geo = checkLocation(post.authorHeadline, post.content, post.authorName);
    if (!geo.pass) {
      counters.rejectedGeo++;
      counters.geoReasons[geo.reason] =
        (counters.geoReasons[geo.reason] ?? 0) + 1;
      continue;
    }
    const intent = quickIntentFilter(post.content, post.authorHeadline);
    if (!intent.pass) {
      counters.rejectedIntent++;
      counters.intentReasons[intent.reason] =
        (counters.intentReasons[intent.reason] ?? 0) + 1;
      continue;
    }

    post.testRunId = testRunId;
    try {
      const inserted = await store.insertPost(post);
      if (inserted) {
        counters.inserted++;
      } else {
        counters.rejectedDedupDb++;
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("posts_linkedin_post_id_uniq")) {
        counters.rejectedDupePostId++;
      } else {
        throw err;
      }
    }
  }
}

function printSummary(strategy: Strategy, counters: Counters, costUsd: number) {
  const passedFilters =
    counters.fetched -
    counters.rejectedDate -
    counters.rejectedNormalize -
    counters.rejectedDedupContent -
    counters.rejectedGeo -
    counters.rejectedIntent;

  const lines: string[] = [];
  lines.push("");
  lines.push(`══ Strategy ${strategy} (${TEST_RUN_ID[strategy]}) ══`);
  lines.push(`fetched              : ${counters.fetched}`);
  lines.push(`  rejected date      : ${counters.rejectedDate}`);
  lines.push(`  rejected normalize : ${counters.rejectedNormalize}`);
  lines.push(`  rejected fp-dedup  : ${counters.rejectedDedupContent}`);
  lines.push(`  rejected geo       : ${counters.rejectedGeo}`);
  lines.push(`  rejected intent    : ${counters.rejectedIntent}`);
  lines.push(`  rejected url-dupe  : ${counters.rejectedDedupDb}`);
  lines.push(`  rejected pid-dupe  : ${counters.rejectedDupePostId}`);
  lines.push(`passed filters       : ${passedFilters}`);
  lines.push(`inserted (new rows)  : ${counters.inserted}`);
  lines.push(`actual cost          : $${costUsd.toFixed(4)}`);
  if (Object.keys(counters.geoReasons).length) {
    lines.push(`top geo-reject reasons:`);
    for (const [k, v] of Object.entries(counters.geoReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)) {
      lines.push(`  ${v}× ${k}`);
    }
  }
  if (Object.keys(counters.intentReasons).length) {
    lines.push(`top intent-reject reasons:`);
    for (const [k, v] of Object.entries(counters.intentReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)) {
      lines.push(`  ${v}× ${k}`);
    }
  }
  lines.push(
    `(scoring: run \`bun run scripts/test-3way.ts --strategy=${strategy} --score-only\` separately to compute qualified ≥20)`,
  );
  console.log(lines.join("\n"));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const maxPosts = Math.floor(flags.maxCost / flags.perPostCost);
  if (maxPosts < 1) {
    throw new Error(
      `max-cost / per-post-cost = ${maxPosts} posts (must be >= 1)`,
    );
  }
  const dateCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  console.log(`══ test-3way runner ══`);
  console.log(`strategy        : ${flags.strategy} (${TEST_RUN_ID[flags.strategy]})`);
  console.log(`actor           : ${flags.actor}`);
  console.log(`max cost        : $${flags.maxCost.toFixed(2)}`);
  console.log(`per-post cost   : $${flags.perPostCost.toFixed(4)}`);
  console.log(`max posts       : ${maxPosts}`);
  console.log(`date cutoff     : ${dateCutoff} (48h)`);
  console.log(`dry-run         : ${flags.dryRun}`);
  console.log(
    `bypassing daily IST scrape budget — runner does NOT write to scrape_run_queries`,
  );

  const actorInput = buildActorInput(flags, maxPosts, dateCutoff);
  console.log(`\nactor input:`);
  console.log(JSON.stringify(actorInput, null, 2));
  const estimatedCost = maxPosts * flags.perPostCost;
  console.log(
    `\nestimated cost @ maxPosts=${maxPosts}: $${estimatedCost.toFixed(4)}`,
  );
  if (estimatedCost > flags.maxCost + 1e-9) {
    throw new Error(
      `estimated cost $${estimatedCost.toFixed(4)} exceeds --max-cost $${flags.maxCost}`,
    );
  }

  if (flags.dryRun) {
    console.log(`\n[dry-run] aborting before actor call.`);
    return;
  }

  if (!process.env.APIFY_TOKEN) {
    throw new Error("APIFY_TOKEN not set");
  }
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const store = new Store();
  const counters = emptyCounters();
  const seenFingerprints = new Set<string>();
  const startedAt = new Date();
  const runUuid = await writeApifyRunsRow(flags, startedAt);
  console.log(`\napify_runs row : ${runUuid} (actor: test-3way-${flags.strategy})\n`);

  let actualCostUsd = 0;
  try {
    if (flags.strategy === "A") {
      // apimaestro: one keyword per call. Loop keywords from the filters
      // file, accumulating up to maxPosts across calls.
      const filters = loadApimaestroFilters(flags.apimaestroFiltersFile);
      let budget = maxPosts;
      for (const kw of filters.keywords) {
        if (budget <= 0) break;
        const callInput = {
          ...actorInput,
          keyword: kw,
          limit: budget,
        };
        console.log(`[A/${kw}] limit=${budget}`);
        const run = await client.actor(flags.actor).call(callInput);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        actualCostUsd += items.length * flags.perPostCost;
        await processItems(
          items as Array<Record<string, unknown>>,
          kw,
          TEST_RUN_ID[flags.strategy],
          store,
          counters,
          seenFingerprints,
        );
        budget -= items.length;
      }
    } else {
      // B1, B2, C — single combined call.
      const run = await client.actor(flags.actor).call(actorInput);
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      actualCostUsd = items.length * flags.perPostCost;
      const queryUsed =
        flags.strategy === "C"
          ? "test-C-baseline-combined"
          : flags.strategy === "B1"
            ? "test-B1-curated-co"
            : "test-B2-curated-ind";
      await processItems(
        items as Array<Record<string, unknown>>,
        queryUsed,
        TEST_RUN_ID[flags.strategy],
        store,
        counters,
        seenFingerprints,
      );
    }
    await finishApifyRunsRow(runUuid, actualCostUsd);
  } catch (err) {
    await finishApifyRunsRow(runUuid, actualCostUsd);
    console.error(`\n[!] strategy ${flags.strategy} failed:`, (err as Error).message);
    throw err;
  } finally {
    printSummary(flags.strategy, counters, actualCostUsd);
    await store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
