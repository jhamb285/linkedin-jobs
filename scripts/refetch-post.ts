/**
 * Re-fetch a specific post by targeted keyword search.
 * Useful when a recovered post is missing its original content.
 */
import { ApifyClient } from "apify-client";

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const actorId = "apimaestro/linkedin-posts-search-scraper-no-cookies";

const queries = [
  "\"AI developer\" \"full lifecycle\" \"LLM solutions\"",
  "\"Konstantina Kyrtsos\"",
];

async function main() {
  for (const query of queries) {
    console.log(`\n=== ${query} ===`);
    try {
      const run = await client.actor(actorId).call({
        keyword: query,
        limit: 5,
        sortBy: "date_posted",
      });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      for (const item of items) {
        const raw = item as Record<string, unknown>;
        const author = (raw.author ?? {}) as Record<string, unknown>;
        const text = (raw.text as string || "").slice(0, 1500);
        console.log(`\n--- ${author.name} ---`);
        console.log(`URL: ${raw.post_url}`);
        console.log(`TEXT:\n${text}\n`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    }
  }
}

main().catch(console.error);
