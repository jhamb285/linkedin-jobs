/**
 * Deduplicate posts in the DB by normalized URL.
 * Keeps the post with the longest content for each base URL.
 * Deletes duplicate scores, comments, lead_content, dms.
 */
import { Database } from "bun:sqlite";

const DB_PATH = "/Users/par1k/Desktop/par1k/lead-magnet/linkedin/lead-scrape-reply/data/leads.db";
const db = new Database(DB_PATH);

function normalizeUrl(url: string): string {
  return url.split("?")[0].split("#")[0].replace(/\/$/, "");
}

const all = db
  .prepare("SELECT id, url, length(content) as content_len, author_name FROM posts")
  .all() as Array<{ id: string; url: string; content_len: number; author_name: string }>;

// Group by normalized URL
const byUrl = new Map<string, typeof all>();
for (const post of all) {
  const key = normalizeUrl(post.url);
  if (!byUrl.has(key)) byUrl.set(key, []);
  byUrl.get(key)!.push(post);
}

const toDelete: string[] = [];

for (const [baseUrl, group] of byUrl) {
  if (group.length === 1) continue;

  // Sort by content length desc, keep the first (longest content)
  group.sort((a, b) => b.content_len - a.content_len);
  const keeper = group[0];
  const losers = group.slice(1);

  console.log(`  ${keeper.author_name}: keep ${keeper.id} (${keeper.content_len} chars), delete ${losers.length} dupes`);
  for (const loser of losers) {
    toDelete.push(loser.id);
  }
}

console.log(`\nDeleting ${toDelete.length} duplicate posts...\n`);

db.exec("BEGIN");
for (const id of toDelete) {
  db.prepare("DELETE FROM lead_content WHERE post_id = ?").run(id);
  db.prepare("DELETE FROM comments WHERE post_id = ?").run(id);
  db.prepare("DELETE FROM dms WHERE post_id = ?").run(id);
  db.prepare("DELETE FROM scores WHERE post_id = ?").run(id);
  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
}
db.exec("COMMIT");

const stats = {
  total: (db.prepare("SELECT count(*) as c FROM posts").get() as any).c,
  approved: (db.prepare("SELECT count(*) as c FROM scores WHERE total >= 25 AND fit > 0").get() as any).c,
};

console.log(`\n=== Done ===`);
console.log(`Total posts: ${stats.total}`);
console.log(`Approved: ${stats.approved}`);

db.close();
