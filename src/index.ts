import type { Command } from "./types";
import { loadConfig } from "./config";
import { Store } from "./store";

const COMMANDS: Record<Command, string> = {
  scrape: "Run Apify search, store posts",
  score: "AI-score unscored posts",
  generate: "Generate comments for high-scoring posts",
  review: "Review queued comments (approve/edit/reject)",
  leads: "Export full lead dashboard → Google Sheets",
  export: "Export approved comments → Google Sheets",
  connect: "Export connection requests → Google Sheets",
  dm: "Generate & export DMs → Google Sheets (12h+ after connect)",
  status: "Show pipeline dashboard",
  "dry-run": "Full pipeline without posting",
  "enrich-truncated": "Backfill: re-fetch article body for short/truncated posts",
};

function printUsage(): void {
  console.log("\nLinkedIn Lead-Scrape & Reply\n");
  console.log("Usage: bun run src/index.ts <command>\n");
  console.log("Commands:");
  for (const [cmd, desc] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(12)} ${desc}`);
  }
  console.log();
  console.log("Pipeline:  scrape → score → generate → review → export → connect → dm");
  console.log("Output:    CSVs in data/exports/ → upload to Google Sheets → PhantomBuster\n");
}

function printStats(store: Store): void {
  const stats = store.getStats();
  const config = loadConfig();

  console.log("\n┌─────────────────────────────────────┐");
  console.log("│   LinkedIn Lead-Scrape & Reply      │");
  console.log("├─────────────────────────────────────┤");
  console.log(`│  Posts scraped:     ${String(stats.totalPosts).padStart(6)}        │`);
  console.log(`│  Posts scored:      ${String(stats.scoredPosts).padStart(6)}        │`);
  console.log(`│  High-score (25+):  ${String(stats.highScorePosts).padStart(6)}        │`);
  console.log("├─────────────────────────────────────┤");
  console.log(`│  Comments pending:  ${String(stats.pendingComments).padStart(6)}        │`);
  console.log(`│  Comments approved: ${String(stats.approvedComments).padStart(6)}        │`);
  console.log(`│  Comments posted:   ${String(stats.postedComments).padStart(6)}        │`);
  console.log(`│  Comments rejected: ${String(stats.rejectedComments).padStart(6)}        │`);
  console.log("├─────────────────────────────────────┤");
  console.log(`│  DMs pending:       ${String(stats.pendingDms).padStart(6)}        │`);
  console.log(`│  DMs sent:          ${String(stats.sentDms).padStart(6)}        │`);
  console.log("└─────────────────────────────────────┘\n");
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;

  if (!command || !(command in COMMANDS)) {
    printUsage();
    process.exit(command ? 1 : 0);
  }

  const config = loadConfig();
  const store = new Store(config.dbPath);

  try {
    switch (command) {
      case "scrape": {
        const { runScraper } = await import("./scraper");
        await runScraper(config, store);
        break;
      }
      case "score": {
        const { runScorer } = await import("./matcher");
        await runScorer(config, store);
        break;
      }
      case "generate": {
        const { runGenerator } = await import("./commenter");
        await runGenerator(config, store);
        break;
      }
      case "review": {
        const { runReviewer } = await import("./reviewer");
        await runReviewer(store);
        break;
      }
      case "leads": {
        const { exportLeads } = await import("./exporter");
        await exportLeads(store, config);
        break;
      }
      case "export": {
        const { exportComments } = await import("./exporter");
        await exportComments(store, config);
        break;
      }
      case "connect": {
        const { exportConnections } = await import("./exporter");
        await exportConnections(store, config);
        break;
      }
      case "dm": {
        const { exportDms } = await import("./exporter");
        await exportDms(store, config);
        break;
      }
      case "status": {
        printStats(store);
        break;
      }
      case "enrich-truncated": {
        const { runEnrichTruncated } = await import("./enrich-truncated");
        await runEnrichTruncated(config, store);
        break;
      }
      case "dry-run": {
        console.log("Running full pipeline in dry-run mode...\n");
        const { runScraper } = await import("./scraper");
        const { runScorer } = await import("./matcher");
        const { runGenerator } = await import("./commenter");

        await runScraper(config, store);
        await runScorer(config, store);
        await runGenerator(config, store, true);

        console.log("\nDry-run complete. No comments were posted.");
        printStats(store);
        break;
      }
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
