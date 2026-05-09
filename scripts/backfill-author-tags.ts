/**
 * One-shot backfill: classify every existing contact_identities row and
 * write tags + primary_role into its metadata column.
 *
 * Why: the live `classifyAuthor` integration only fires on NEW scrapes
 * (via runScraper.upsertContactFromPost). Authors fetched before the
 * tagging deploy have no tags. This script reads each row, runs the
 * classifier on stored display_name + headline (post content isn't
 * persisted on the identity row, so content-based tags like
 * `spam-signals` / `india-content` / `target-fit` are best-effort here
 * and will fill in next time the same author is re-scraped).
 *
 * Idempotent: re-running overwrites prior tag arrays with the latest
 * classifier output. Filter-rejection state on metadata is preserved.
 *
 * Run on prod:
 *   ssh mediaos 'cd /opt/automations/inbound/linkedin-jobs &&
 *     /usr/local/bin/bun run scripts/backfill-author-tags.ts'
 *
 * Read-only flag:
 *   --dry-run   classify but skip the UPDATE; print stats only.
 */

import { db } from "../src/db";
import { sql } from "drizzle-orm";
import { classifyAuthor } from "../src/author-classifier";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

type Row = {
  id: string;
  display_name_at_capture: string | null;
  headline: string | null;
  metadata: Record<string, unknown> | null;
};

async function main(): Promise<void> {
  const t0 = Date.now();
  let offset = 0;
  let totalProcessed = 0;
  let totalUpdated = 0;
  const tagTally: Record<string, number> = {};
  const roleTally: Record<string, number> = {};

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = (await db.execute(sql`
      SELECT id, display_name_at_capture, headline, metadata
      FROM contact_identities
      ORDER BY first_seen_at NULLS LAST
      LIMIT ${BATCH_SIZE} OFFSET ${offset}
    `)).rows as Row[];

    if (rows.length === 0) break;

    for (const r of rows) {
      const { tags, primaryRole } = classifyAuthor(
        r.display_name_at_capture ?? "",
        r.headline ?? "",
        "", // no post content available at the identity row
      );

      for (const t of tags) tagTally[t] = (tagTally[t] ?? 0) + 1;
      if (primaryRole) roleTally[primaryRole] = (roleTally[primaryRole] ?? 0) + 1;

      if (!DRY_RUN) {
        // Merge: keep prior keys (filter_rejected etc.), overwrite tags + primary_role.
        const next: Record<string, unknown> = { ...(r.metadata ?? {}) };
        if (tags.length > 0) next.tags = tags;
        if (primaryRole) next.primary_role = primaryRole;
        const merged = Object.keys(next).length > 0 ? next : null;
        await db.execute(sql`
          UPDATE contact_identities
          SET metadata = ${merged}
          WHERE id = ${r.id}
        `);
        totalUpdated++;
      }
      totalProcessed++;
    }

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  const elapsedMs = Date.now() - t0;
  console.log(
    `\nProcessed ${totalProcessed} contact_identities rows in ${elapsedMs}ms` +
      (DRY_RUN ? " (DRY RUN — no writes)" : ` — ${totalUpdated} updated`),
  );
  console.log("\n=== Primary role distribution ===");
  for (const [r, n] of Object.entries(roleTally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(20)} ${n}`);
  }
  console.log("\n=== Tag distribution (top 20) ===");
  const sortedTags = Object.entries(tagTally).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [t, n] of sortedTags) {
    console.log(`  ${t.padEnd(28)} ${n}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
