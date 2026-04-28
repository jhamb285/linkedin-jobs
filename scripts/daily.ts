/**
 * End-to-end daily pipeline for the LinkedIn Jobs inbound workflow.
 *
 * Stages, in order:
 *   1. scrape   — Apify search → posts table
 *   2. score    — Gemini scoring → scores table
 *   3. batch    — close any existing 'active' batch, open a new one,
 *                 assign top-N high-scoring posts that don't have an
 *                 engagement_drafts row yet
 *   4. generate — Gemini content gen → engagement_drafts (AJ + PK each)
 *
 * Stages run sequentially, fail-loud (any throw aborts the run). On the
 * happy path every stage emits its own platform_events rows; this script
 * also emits `daily.run.started` / `daily.run.completed` umbrella events.
 *
 * Run with:
 *   bun run daily            # full run
 *   bun run daily --dry-run  # scrape+score only, no batch/generate
 *   bun run daily --skip-scrape   # useful when iterating downstream
 */

import { loadConfig } from "../src/config";
import { Store } from "../src/store";
import { db, schema } from "../src/db";
import { recordEvent } from "../src/events";
import { runScraper } from "../src/scraper";
import { runScorer } from "../src/matcher";
import { runGenerator } from "../src/commenter";
import { eq, sql } from "drizzle-orm";

const BATCH_TARGET_SIZE = 50;

interface StageResult {
  stage: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

function parseFlags(): {
  dryRun: boolean;
  skipScrape: boolean;
  skipScore: boolean;
  skipBatch: boolean;
  skipGenerate: boolean;
} {
  const argv = process.argv.slice(2);
  return {
    dryRun: argv.includes("--dry-run"),
    skipScrape: argv.includes("--skip-scrape"),
    skipScore: argv.includes("--skip-score"),
    skipBatch: argv.includes("--skip-batch"),
    skipGenerate: argv.includes("--skip-generate"),
  };
}

async function runStage(
  stage: string,
  fn: () => Promise<void>,
): Promise<StageResult> {
  const t0 = Date.now();
  try {
    await fn();
    return { stage, durationMs: Date.now() - t0, ok: true };
  } catch (err) {
    return {
      stage,
      durationMs: Date.now() - t0,
      ok: false,
      error: (err as Error).message,
    };
  }
}

async function rotateBatch(): Promise<{
  batchId: string;
  assigned: number;
  closed: string | null;
}> {
  // Close any currently-active batch.
  const active = await db
    .select({ id: schema.leadBatches.id })
    .from(schema.leadBatches)
    .where(eq(schema.leadBatches.status, "active"));
  let closedId: string | null = null;
  if (active.length > 0) {
    closedId = active[0].id;
    await db
      .update(schema.leadBatches)
      .set({ status: "completed" })
      .where(eq(schema.leadBatches.status, "active"));
  }

  // Open a new active batch.
  const created = await db
    .insert(schema.leadBatches)
    .values({ status: "active", totalAssigned: 0 })
    .returning({ id: schema.leadBatches.id });
  const batchId = created[0].id;

  // Pick top-N scored posts not already in any batch_assignment.
  const candidates = (await db.execute(sql`
    SELECT p.id AS post_id, s.total AS total
      FROM posts p
      JOIN scores s ON s.post_id = p.id
     WHERE p.source = 'linkedin_jobs'
       AND s.fit > 0
       AND s.total >= 20
       AND p.id NOT IN (SELECT post_id FROM batch_assignments)
     ORDER BY s.total DESC, p.scraped_at DESC
     LIMIT ${BATCH_TARGET_SIZE}
  `)).rows as Array<{ post_id: string; total: number }>;

  if (candidates.length === 0) {
    return { batchId, assigned: 0, closed: closedId };
  }

  const now = new Date();
  for (let i = 0; i < candidates.length; i++) {
    await db.insert(schema.batchAssignments).values({
      batchId,
      postId: candidates[i].post_id,
      assignmentOrder: i + 1,
      dayNumber: 1,
      status: "pending",
      assignedAt: now,
    });
  }
  await db
    .update(schema.leadBatches)
    .set({ totalAssigned: candidates.length })
    .where(eq(schema.leadBatches.id, batchId));

  return { batchId, assigned: candidates.length, closed: closedId };
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const startedAt = new Date();
  console.log(
    `\n=== daily pipeline @ ${startedAt.toISOString()} ===` +
      (flags.dryRun ? " (dry-run)" : ""),
  );

  await recordEvent({
    eventType: "daily.run.started",
    workflow: "linkedin_jobs",
    actor: "linkedin-jobs.daily",
    payload: {
      dryRun: flags.dryRun,
      skipScrape: flags.skipScrape,
      skipScore: flags.skipScore,
      skipBatch: flags.skipBatch,
      skipGenerate: flags.skipGenerate,
    },
  });

  const config = loadConfig();
  const store = new Store();
  const stageResults: StageResult[] = [];
  type BatchSummary = { batchId: string; assigned: number; closed: string | null };
  let batchSummary: BatchSummary | null = null;

  try {
    if (!flags.skipScrape) {
      const r = await runStage("scrape", () => runScraper(config, store));
      console.log(`  [scrape] ${r.ok ? "OK" : "FAIL"} (${r.durationMs}ms)`);
      stageResults.push(r);
      if (!r.ok) throw new Error(`scrape: ${r.error}`);
    } else {
      console.log("  [scrape] skipped");
    }

    if (!flags.skipScore) {
      const r = await runStage("score", () => runScorer(config, store));
      console.log(`  [score]  ${r.ok ? "OK" : "FAIL"} (${r.durationMs}ms)`);
      stageResults.push(r);
      if (!r.ok) throw new Error(`score: ${r.error}`);
    } else {
      console.log("  [score]  skipped");
    }

    if (flags.dryRun) {
      console.log("\n[dry-run] stopping before batch + generate.");
    } else {
      if (!flags.skipBatch) {
        let summary: BatchSummary | null = null;
        const r = await runStage("batch", async () => {
          summary = await rotateBatch();
          await recordEvent({
            eventType: "batch.created",
            workflow: "linkedin_jobs",
            actor: "linkedin-jobs.daily",
            payload: {
              batchId: summary.batchId,
              assigned: summary.assigned,
              previousActiveBatchId: summary.closed,
            },
          });
        });
        batchSummary = summary;
        const assigned: number =
          (summary as BatchSummary | null)?.assigned ?? 0;
        console.log(
          `  [batch]  ${r.ok ? "OK" : "FAIL"} (${r.durationMs}ms) — assigned ${assigned}`,
        );
        stageResults.push(r);
        if (!r.ok) throw new Error(`batch: ${r.error}`);
      } else {
        console.log("  [batch]  skipped");
      }

      if (!flags.skipGenerate) {
        const r = await runStage("generate", () =>
          runGenerator(config, store, false),
        );
        console.log(
          `  [gen]    ${r.ok ? "OK" : "FAIL"} (${r.durationMs}ms)`,
        );
        stageResults.push(r);
        if (!r.ok) throw new Error(`generate: ${r.error}`);
      } else {
        console.log("  [gen]    skipped");
      }
    }

    await recordEvent({
      eventType: "daily.run.completed",
      workflow: "linkedin_jobs",
      actor: "linkedin-jobs.daily",
      payload: {
        ok: true,
        dryRun: flags.dryRun,
        durationMs: Date.now() - startedAt.getTime(),
        stages: stageResults,
        batch: batchSummary,
      },
    });

    console.log(
      `\nDaily pipeline OK · ${
        Date.now() - startedAt.getTime()
      }ms total\n`,
    );
  } catch (err) {
    await recordEvent({
      eventType: "daily.run.failed",
      workflow: "linkedin_jobs",
      actor: "linkedin-jobs.daily",
      payload: {
        ok: false,
        durationMs: Date.now() - startedAt.getTime(),
        stages: stageResults,
        error: (err as Error).message,
      },
    });
    console.error("\nDaily pipeline FAILED:", (err as Error).message);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main();
