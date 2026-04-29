/**
 * Re-analyze the 948 raw posts from the 2026-04-29 Strategy C run, by
 * pulling the Apify dataset back (free — already paid) and running each
 * item through the same filter chain. Outputs a grouped breakdown with
 * samples per group, so we can design filter patches with evidence.
 *
 * Usage:
 *   bun scripts/analyze-test-c.ts
 *
 * Writes:
 *   data/analyze-test-c.jsonl    one row per post: {decision, reason, …key fields}
 *   data/analyze-test-c-summary.md   human-readable buckets + sample posts
 */

import { ApifyClient } from "apify-client";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  checkLocation,
  quickIntentFilter,
  isRecentPost,
  normalizeApifyResult,
} from "../src/scraper";

const DATASET_ID = process.env.DATASET_ID ?? "bwN1rdHuxnMqQ7Phj";

async function main() {
  if (!process.env.APIFY_TOKEN) {
    throw new Error("APIFY_TOKEN not set");
  }
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  console.log(`fetching dataset ${DATASET_ID}…`);
  const { items } = await client.dataset(DATASET_ID).listItems();
  console.log(`fetched ${items.length} raw items`);

  type Decision =
    | "pass"
    | "rej_date"
    | "rej_normalize"
    | "rej_geo"
    | "rej_intent";
  interface Row {
    decision: Decision;
    reason: string;
    authorName: string;
    authorHeadline: string;
    contentSample: string;
    url: string;
  }
  const rows: Row[] = [];

  for (const raw of items as Array<Record<string, unknown>>) {
    const postedAt = (raw.postedAt ?? raw.posted_at) as
      | Record<string, unknown>
      | undefined;
    if (!isRecentPost(postedAt, 48)) {
      const author = (raw.author ?? {}) as Record<string, unknown>;
      rows.push({
        decision: "rej_date",
        reason: "older-than-48h",
        authorName: (author.name as string) ?? "",
        authorHeadline: ((author.info ?? author.headline) as string) ?? "",
        contentSample: ((raw.content ?? raw.text) as string)?.slice(0, 100) ?? "",
        url: (raw.linkedinUrl as string) ?? "",
      });
      continue;
    }
    const post = normalizeApifyResult(raw, "test-C-baseline");
    if (!post) {
      rows.push({
        decision: "rej_normalize",
        reason: "missing-content-or-url",
        authorName: "",
        authorHeadline: "",
        contentSample: "",
        url: "",
      });
      continue;
    }
    const geo = checkLocation(post.authorHeadline, post.content, post.authorName);
    if (!geo.pass) {
      rows.push({
        decision: "rej_geo",
        reason: geo.reason,
        authorName: post.authorName,
        authorHeadline: post.authorHeadline,
        contentSample: post.content.slice(0, 100),
        url: post.url,
      });
      continue;
    }
    // Track whether the geo gate passed via the contract-rescue path
    // so we can audit how many posts the rescue rule lets through.
    const geoPassReason = geo.reason;
    const intent = quickIntentFilter(post.content, post.authorHeadline);
    if (!intent.pass) {
      rows.push({
        decision: "rej_intent",
        reason: intent.reason,
        authorName: post.authorName,
        authorHeadline: post.authorHeadline,
        contentSample: post.content.slice(0, 100),
        url: post.url,
      });
      continue;
    }
    rows.push({
      decision: "pass",
      reason: geoPassReason,
      authorName: post.authorName,
      authorHeadline: post.authorHeadline,
      contentSample: post.content.slice(0, 200),
      url: post.url,
    });
  }

  // Persist
  const dataDir = join(__dirname, "..", "data");
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(dataDir, "analyze-test-c.jsonl"), jsonl);

  // Summarize
  const groups: Record<string, Row[]> = {};
  for (const r of rows) {
    const key = `${r.decision}/${r.reason || "(none)"}`;
    (groups[key] ??= []).push(r);
  }

  const summary: string[] = [];
  summary.push(`# analyze-test-c — filter pass over ${rows.length} raw items\n`);
  summary.push(`_Dataset ${DATASET_ID} (the test-C-baseline Apify run from 2026-04-29)_\n`);
  summary.push("## Aggregate decision breakdown\n");
  const counts = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  summary.push("| decision/reason | count | % |");
  summary.push("| --- | ---: | ---: |");
  for (const [k, v] of counts) {
    summary.push(`| \`${k}\` | ${v.length} | ${((v.length / rows.length) * 100).toFixed(1)}% |`);
  }
  summary.push("");
  summary.push("## Samples per group (up to 8 each)\n");
  for (const [k, v] of counts) {
    summary.push(`### ${k} — ${v.length} items\n`);
    for (const r of v.slice(0, 8)) {
      const name = r.authorName || "(no name)";
      const headline = r.authorHeadline.slice(0, 80) || "(no headline)";
      const content = r.contentSample.replace(/\n/g, " ").slice(0, 140);
      summary.push(`- **${name}** — _${headline}_ — "${content}"`);
    }
    summary.push("");
  }

  writeFileSync(
    join(dataDir, "analyze-test-c-summary.md"),
    summary.join("\n"),
  );
  console.log(`wrote data/analyze-test-c.jsonl (${rows.length} rows)`);
  console.log(`wrote data/analyze-test-c-summary.md`);
  console.log("");
  console.log("aggregate breakdown:");
  for (const [k, v] of counts) {
    console.log(`  ${v.length.toString().padStart(4)} ${k}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
