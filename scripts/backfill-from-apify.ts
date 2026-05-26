/**
 * One-off: backfill geo-rejected posts from Apify datasets.
 *
 * Re-pulls all dataset items from a recent window of LinkedIn Apify runs
 * (free — Apify retains datasets for ~30 days) and replays each item
 * through the CURRENT filter chain (normalize → checkLocation → quickIntent
 * → upsertPost). Posts that previously got dropped at the geo stage but
 * now pass the relaxed checkLocation get inserted; posts already in DB
 * are dedupped on URL.
 *
 * Usage:
 *   bun run scripts/backfill-from-apify.ts [hours_back]
 *
 *   hours_back defaults to 24 — covers today's runs.
 *
 * After this script finishes you should run:
 *   bun run daily --skip-scrape
 * to score + draft the newly-inserted posts.
 */

import { ApifyClient } from "apify-client";
import { Store } from "../src/store";
import { loadConfig } from "../src/config";
import {
  normalizeApifyResult,
  checkLocation,
  quickIntentFilter,
  isRecentPost,
} from "../src/scraper";
import { classifyAuthor } from "../src/author-classifier";

interface ApifyRunMeta {
  id: string;
  startedAt: string;
  defaultDatasetId: string;
  usageTotalUsd: number | null;
}

async function listRunsForActor(
  apifyToken: string,
  actorId: string,
  sinceMs: number,
): Promise<ApifyRunMeta[]> {
  const actorPath = actorId.replace("/", "~");
  const url = `https://api.apify.com/v2/acts/${actorPath}/runs?token=${apifyToken}&limit=200&desc=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Apify runs list ${res.status}`);
  const json = (await res.json()) as {
    data: { items: Array<Record<string, unknown>> };
  };
  return json.data.items
    .filter(
      (r) =>
        typeof r.startedAt === "string" &&
        new Date(r.startedAt as string).getTime() >= sinceMs,
    )
    .map((r) => ({
      id: String(r.id),
      startedAt: String(r.startedAt),
      defaultDatasetId: String(r.defaultDatasetId),
      usageTotalUsd:
        typeof r.usageTotalUsd === "number" ? (r.usageTotalUsd as number) : null,
    }));
}

async function fetchDataset(
  client: ApifyClient,
  datasetId: string,
): Promise<Array<Record<string, unknown>>> {
  const ds = await client.dataset(datasetId).listItems();
  return ds.items as Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const hoursBack = parseInt(process.argv[2] ?? "24", 10);
  const sinceMs = Date.now() - hoursBack * 60 * 60 * 1000;

  const config = loadConfig();
  const store = new Store();

  console.log(
    `[backfill] window: last ${hoursBack}h (since ${new Date(sinceMs).toISOString()})`,
  );
  console.log(`[backfill] actor: ${config.apifyActorId}`);

  const runs = await listRunsForActor(
    config.apifyToken,
    config.apifyActorId,
    sinceMs,
  );
  console.log(`[backfill] found ${runs.length} runs in window`);

  const client = new ApifyClient({ token: config.apifyToken });

  let totalItems = 0;
  let insertedNew = 0;
  let alreadyInDb = 0;
  let stillGeo = 0;
  let stillIntent = 0;
  let staleDate = 0;
  let normalizeDrop = 0;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    process.stdout.write(
      `[${i + 1}/${runs.length}] dataset ${run.defaultDatasetId}…`,
    );
    let items: Array<Record<string, unknown>>;
    try {
      items = await fetchDataset(client, run.defaultDatasetId);
    } catch (e) {
      console.log(` ERROR: ${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    totalItems += items.length;
    let runInserted = 0;

    for (const raw of items) {
      // We don't know the original query, but normalize doesn't need it
      // for filtering — only for query_used attribution. Use "backfill"
      // as a marker so we can spot these rows later.
      const post = normalizeApifyResult(raw, "<backfill>");
      if (!post) {
        normalizeDrop++;
        continue;
      }
      // Same 48h recency window as the scraper.
      const postedAt = (raw.postedAt ?? raw.posted_at) as
        | Record<string, unknown>
        | undefined;
      if (!isRecentPost(postedAt, 48)) {
        staleDate++;
        continue;
      }
      const geo = checkLocation(
        post.authorHeadline,
        post.content,
        post.authorName,
      );
      if (!geo.pass) {
        stillGeo++;
        continue;
      }
      const intent = quickIntentFilter(post.content, post.authorHeadline);
      if (!intent.pass) {
        stillIntent++;
        continue;
      }

      // Insert. The store handles URL-uniqueness via onConflictDoUpdate —
      // returns true if newly inserted, false if it already existed.
      const scrapedAtDate = post.scrapedAt
        ? new Date(post.scrapedAt)
        : new Date();
      const wasInserted = await store.insertPost({
        ...post,
        scrapedAt: scrapedAtDate,
        queryUsed: "<backfill>",
      });
      const classification = classifyAuthor(
        post.authorName,
        post.authorHeadline,
        post.content,
      );
      await store.upsertContactFromPost({
        authorName: post.authorName,
        authorHeadline: post.authorHeadline,
        authorUrl: post.authorUrl,
        scrapedAt: scrapedAtDate,
        tags: classification.tags,
        primaryRole: classification.primaryRole,
      });
      if (wasInserted) {
        insertedNew++;
        runInserted++;
      } else {
        alreadyInDb++;
      }
    }
    console.log(` items=${items.length} new=${runInserted}`);
  }

  console.log("\n=== Backfill summary ===");
  console.log(`Total items fetched:     ${totalItems}`);
  console.log(`Posts NEWLY inserted:    ${insertedNew}`);
  console.log(`Already in DB:           ${alreadyInDb}`);
  console.log(`Still rejected: geo:     ${stillGeo}`);
  console.log(`Still rejected: intent:  ${stillIntent}`);
  console.log(`Dropped: too-old (>48h): ${staleDate}`);
  console.log(`Dropped: normalize:      ${normalizeDrop}`);
  console.log("\nNext step:");
  console.log("  bun run daily --skip-scrape");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] FATAL:", err);
    process.exit(1);
  });
