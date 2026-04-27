/**
 * Test 5 diverse queries, 3 results each. Wider net.
 */
import { ApifyClient } from "apify-client";
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "data", "leads.db");
mkdirSync(join(import.meta.dir, "..", "data"), { recursive: true });

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const actorId = "apimaestro/linkedin-posts-search-scraper-no-cookies";

const queries = [
  '"freelance" "ai engineer"',
  '"hiring" "ai engineer" remote',
  '"contract" "ai developer"',
  '"looking for" "ai consultant"',
  '"need" "ai engineer" freelance',
];

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, author_name TEXT, author_headline TEXT,
  author_url TEXT, content TEXT, engagement_count INTEGER DEFAULT 0,
  scraped_at TEXT NOT NULL, query_used TEXT
)`);

function postId(url: string, content: string): string {
  return createHash("sha256").update(url + content).digest("hex").slice(0, 16);
}

async function main() {
  let totalNew = 0;

  for (const query of queries) {
    console.log(`\n[Q] ${query}`);

    const run = await client.actor(actorId).call({
      keyword: query,
      limit: 3,
      sortBy: "date_posted",
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    for (const item of items) {
      const raw = item as Record<string, unknown>;
      const text = (raw.text ?? "") as string;
      const postUrl = (raw.post_url ?? "") as string;
      const author = (raw.author ?? {}) as Record<string, unknown>;
      const postedAt = raw.posted_at as Record<string, unknown> | undefined;
      const dateStr = postedAt?.date ? String(postedAt.date) : "";
      const display = (postedAt?.display_text ?? "") as string;

      if (!text || !postUrl) continue;

      const id = postId(postUrl, text);
      const authorName = (author.name ?? "") as string;
      const headline = (author.headline ?? "") as string;

      const stats = (raw.stats ?? {}) as Record<string, unknown>;
      const engagement = ((stats.total_reactions ?? 0) as number) + ((stats.comments ?? 0) as number);

      try {
        db.prepare(`INSERT OR IGNORE INTO posts VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(id, postUrl, authorName, headline, author.profile_url ?? "", text.slice(0, 5000), engagement, dateStr, query);

        console.log(`  [${display}] ${authorName.slice(0, 25).padEnd(25)} | ${headline.slice(0, 40)}`);
        console.log(`       "${text.slice(0, 100)}..."`);
        totalNew++;
      } catch {}
    }
  }

  console.log(`\n=== ${totalNew} posts stored. Run: bun run score && bun run generate ===`);
  db.close();
}

main().catch(console.error);
