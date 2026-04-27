/**
 * Test harvestapi/linkedin-post-search — compare response format to apimaestro
 */
import { ApifyClient } from "apify-client";

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const actorId = "harvestapi/linkedin-post-search";

async function main() {
  console.log(`Testing ${actorId}...\n`);

  try {
    const run = await client.actor(actorId).call({
      searchQueries: ["\"ai consultant\" freelance"],
      maxPosts: 3,
      sortBy: "date",
      postedLimit: "week",
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.log(`Got ${items.length} items\n`);

    if (items[0]) {
      console.log("=== FIELD KEYS ===");
      console.log(Object.keys(items[0]).join(", "));
      console.log("\n=== FIRST ITEM (truncated) ===");
      console.log(JSON.stringify(items[0], null, 2).slice(0, 3000));
    }
  } catch (err) {
    console.error("Error:", (err as Error).message);
  }
}

main().catch(console.error);
