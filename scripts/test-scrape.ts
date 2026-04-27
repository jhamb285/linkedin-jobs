/**
 * Test different input param combinations to find what actually works
 */
import { ApifyClient } from "apify-client";

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const actorId = "apimaestro/linkedin-posts-search-scraper-no-cookies";

async function test(label: string, input: Record<string, unknown>) {
  console.log(`\n=== ${label} ===`);
  console.log("Input:", JSON.stringify(input));

  const run = await client.actor(actorId).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  console.log(`Results: ${items.length}`);
  for (const item of items.slice(0, 2)) {
    const raw = item as Record<string, unknown>;
    const author = raw.author as Record<string, unknown>;
    const text = (raw.text as string || "").slice(0, 80);
    console.log(`  - ${author?.name} | "${text}..."`);
    console.log(`    search_input: "${raw.search_input}"`);
  }
}

async function main() {
  // Test 1: keyword field instead of searchQuery
  await test("keyword field", {
    keyword: "freelance ai engineer",
    limit: 2,
    sortBy: "date_posted",
  });

  // Test 2: searchUrl with LinkedIn URL
  await test("searchUrl", {
    searchUrl: "https://www.linkedin.com/search/results/content/?keywords=freelance%20ai%20engineer&sortBy=%22date_posted%22",
    limit: 2,
  });
}

main().catch(console.error);
