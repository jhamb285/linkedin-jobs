// Backfill: re-enrich previously-stored short/truncated posts by looking up
// their article share via supreme_coder/linkedin-post and fetching the
// linked-out article body. Idempotent — safe to re-run.

import { ApifyClient } from "apify-client";
import { Database } from "bun:sqlite";
import type { AppConfig } from "./types";
import type { Store } from "./store";
import { fetchArticleBody, looksTruncated, mergeTeaserAndArticle } from "./article-fetch";

interface PostRow {
  id: string;
  url: string;
  content: string;
}

const SINGLE_POST_ACTOR = "supreme_coder/linkedin-post";

export async function runEnrichTruncated(config: AppConfig, _store: Store): Promise<void> {
  const db = new Database(config.dbPath, { readwrite: true });
  db.exec("PRAGMA journal_mode = WAL");

  const rows = db
    .query(
      `SELECT id, url, content FROM posts
       WHERE length(content) < 600
          OR content LIKE '%....'
       ORDER BY scraped_at DESC`
    )
    .all() as PostRow[];

  console.log(`Found ${rows.length} truncated posts to enrich.\n`);

  if (rows.length === 0) {
    db.close();
    return;
  }

  const client = new ApifyClient({ token: config.apifyToken });
  const updateStmt = db.query("UPDATE posts SET content = ? WHERE id = ?");

  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (!looksTruncated(row.content)) {
      skipped++;
      continue;
    }

    try {
      const run = await client
        .actor(SINGLE_POST_ACTOR)
        .call({ urls: [row.url] }, { timeout: 90 });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const item = items[0] as Record<string, unknown> | undefined;
      const article = item?.article as Record<string, unknown> | undefined;
      const articleUrl =
        (typeof article?.url === "string" && article.url) ||
        (typeof article?.link === "string" && article.link) ||
        null;

      if (!articleUrl) {
        console.log(`  - ${row.id.slice(0, 12)}: no article link, skipping`);
        skipped++;
        continue;
      }

      const body = await fetchArticleBody(articleUrl);
      if (!body || body.length <= row.content.length) {
        console.log(`  - ${row.id.slice(0, 12)}: article fetch returned nothing useful`);
        failed++;
        continue;
      }

      const merged = mergeTeaserAndArticle(row.content, body);
      updateStmt.run(merged, row.id);
      enriched++;
      console.log(
        `  + ${row.id.slice(0, 12)}: ${row.content.length} -> ${merged.length} chars (${articleUrl.slice(0, 60)})`
      );
    } catch (err) {
      failed++;
      console.log(`  ! ${row.id.slice(0, 12)}: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  console.log(`\nDone: ${enriched} enriched | ${skipped} skipped | ${failed} failed`);
  db.close();
}
