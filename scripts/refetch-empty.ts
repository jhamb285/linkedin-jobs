/**
 * Re-fetch empty-content posts by extracting keywords from their URL slugs
 * and searching Apify for the exact post (matching by URL).
 */
import { ApifyClient } from "apify-client";
import { Database } from "bun:sqlite";

const DB_PATH = "/Users/par1k/Desktop/par1k/lead-magnet/linkedin/lead-scrape-reply/data/leads.db";
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const actorId = "apimaestro/linkedin-posts-search-scraper-no-cookies";
const db = new Database(DB_PATH);

// Extract keywords from URL slug
// e.g. "hiring-aiengineer-dataengineer-activity-..." → "hiring ai engineer"
function extractKeywords(url: string): string {
  const match = url.match(/\/posts\/[^/]+?_([a-z0-9-]+?)-activity/i);
  if (!match) return "";
  return match[1]
    .replace(/-/g, " ")
    .replace(/aiengineer/g, "ai engineer")
    .replace(/aidev/g, "ai dev")
    .replace(/genai/g, "gen ai")
    .replace(/artificialintelligence/g, "artificial intelligence")
    .replace(/freelancejobs/g, "freelance jobs")
    .replace(/hiringnow/g, "hiring now")
    .split(" ")
    .slice(0, 5) // max 5 words
    .join(" ");
}

async function refetchPost(id: string, author: string, url: string): Promise<boolean> {
  const keywords = extractKeywords(url);
  if (!keywords) {
    console.log(`  [skip] ${author}: couldn't extract keywords from URL`);
    return false;
  }

  console.log(`  [fetching] ${author}: "${keywords}"`);
  try {
    const run = await client.actor(actorId).call({
      keyword: keywords,
      limit: 20,
      sortBy: "date_posted",
    });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // Match by URL (ignore query params)
    const baseUrl = url.split("?")[0];
    for (const item of items) {
      const raw = item as Record<string, unknown>;
      const postUrl = (raw.post_url as string) || "";
      const itemBase = postUrl.split("?")[0];

      if (itemBase === baseUrl) {
        const text = (raw.text as string) || "";
        const headline = ((raw.author as Record<string, unknown>)?.headline as string) || "";
        db.prepare("UPDATE posts SET content = ?, author_headline = ? WHERE id = ?").run(
          text.slice(0, 5000),
          headline,
          id
        );
        console.log(`    ✓ updated (${text.length} chars)`);
        return true;
      }
    }

    // If no URL match, try matching by author name
    for (const item of items) {
      const raw = item as Record<string, unknown>;
      const itemAuthor = ((raw.author as Record<string, unknown>)?.name as string) || "";
      if (itemAuthor.toLowerCase() === author.toLowerCase()) {
        const text = (raw.text as string) || "";
        const headline = ((raw.author as Record<string, unknown>)?.headline as string) || "";
        const itemPostUrl = (raw.post_url as string) || "";
        db.prepare("UPDATE posts SET content = ?, author_headline = ?, url = ? WHERE id = ?").run(
          text.slice(0, 5000),
          headline,
          itemPostUrl,
          id
        );
        console.log(`    ✓ matched by author, updated (${text.length} chars)`);
        return true;
      }
    }

    console.log(`    ✗ no match found`);
    return false;
  } catch (err) {
    console.error(`    ! error: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  const empty = db
    .prepare("SELECT id, author_name, url FROM posts WHERE length(content) = 0")
    .all() as Array<{ id: string; author_name: string; url: string }>;

  console.log(`Found ${empty.length} empty-content posts to refetch\n`);

  let recovered = 0;
  for (const post of empty) {
    const ok = await refetchPost(post.id, post.author_name, post.url);
    if (ok) recovered++;
    await new Promise((r) => setTimeout(r, 500)); // rate limit
  }

  console.log(`\n=== Refetch complete: ${recovered}/${empty.length} recovered ===`);

  const remaining = (db.prepare("SELECT count(*) as c FROM posts WHERE length(content) = 0").get() as any).c;
  console.log(`Still empty: ${remaining} posts`);

  db.close();
}

main().catch(console.error);
