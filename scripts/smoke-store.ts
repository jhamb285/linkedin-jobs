/**
 * Phase 6 smoke test — proves the new Postgres-backed Store works end-to-
 * end (insert post → insert score → insert dual-persona drafts → re-fetch)
 * WITHOUT calling Apify or Gemini. Verifies the data lands in the same
 * Postgres that platform/web reads from.
 *
 * Usage:
 *   bun run smoke:store
 *
 * Reads DATABASE_URL from .env.local. Idempotent — uses a fixed sentinel
 * URL so re-runs upsert the same row.
 */

import { Store } from "../src/store";
import type { ScrapedPost, PostScore } from "../src/types";

const SENTINEL_URL =
  "https://www.linkedin.com/posts/phase-6-smoke-test/sentinel";

async function main() {
  const store = new Store();

  // 1) insertPost upserts by url and rewrites post.id to the canonical UUID.
  const post: ScrapedPost = {
    id: "smoke-post-id-(will-be-replaced)",
    url: SENTINEL_URL,
    authorName: "Phase 6 Smoke",
    authorHeadline: "Sentinel post for the linkedin-jobs CLI port",
    authorUrl: "https://www.linkedin.com/in/phase-6-smoke",
    content:
      "This is a synthetic post written by the Phase 6 smoke script. " +
      "It exercises the CLI's new Postgres Store without spending Apify " +
      "or Gemini credits. Safe to delete.",
    engagementCount: 0,
    scrapedAt: new Date().toISOString(),
    queryUsed: "smoke-test",
  };
  const inserted = await store.insertPost(post);
  console.log(`[1] insertPost → newRow=${inserted}, id=${post.id}`);

  // 2) insertScore for that post.
  const score: PostScore = {
    postId: post.id,
    relevance: 8,
    fit: 7,
    urgency: 6,
    engagementPotential: 9,
    total: 30,
    positioning: "consulting",
    reasoning: "Phase 6 smoke score — synthetic for testing the CLI port.",
    scoredAt: new Date().toISOString(),
  };
  await store.insertScore(score);
  console.log(`[2] insertScore → post_id=${post.id}, total=${score.total}`);

  // 3) insertLeadContent → 2 engagement_drafts rows.
  await store.insertLeadContent(post.id, "Phase 6 smoke summary", {
    commentAj: "AJ would say: thoughtful comment for the smoke post.",
    commentPk: "PK would say: technical comment for the smoke post.",
    connectionNoteAj: "AJ connection note (smoke).",
    connectionNotePk: "PK connection note (smoke).",
    dmAj: "AJ DM (smoke).",
    dmPk: "PK DM (smoke).",
  });
  console.log("[3] insertLeadContent → 2 engagement_drafts upserted");

  // 4) Re-fetch via getLeadsForExport to prove the join works.
  const leads = await store.getLeadsForExport({ fullExport: true });
  const ours = leads.find((l) => l.url === SENTINEL_URL);
  if (!ours) {
    console.error("[4] FAIL — sentinel post not found in getLeadsForExport");
    await store.close();
    process.exit(1);
  }
  console.log(
    `[4] getLeadsForExport → found sentinel; total=${ours.total}, AJ-comment-len=${ours.commentAj?.length ?? 0}, PK-comment-len=${ours.commentPk?.length ?? 0}`,
  );

  // 5) Re-run insertLeadContent to prove idempotency.
  await store.insertLeadContent(post.id, "Phase 6 smoke summary (re-run)", {
    commentAj: "AJ rewrite: thoughtful comment for the smoke post v2.",
    commentPk: "PK rewrite: technical comment for the smoke post v2.",
    connectionNoteAj: "AJ connection note (smoke v2).",
    connectionNotePk: "PK connection note (smoke v2).",
    dmAj: "AJ DM (smoke v2).",
    dmPk: "PK DM (smoke v2).",
  });
  const leads2 = await store.getLeadsForExport({ fullExport: true });
  const ours2 = leads2.find((l) => l.url === SENTINEL_URL);
  if (!ours2 || !ours2.commentPk?.includes("v2")) {
    console.error("[5] FAIL — re-run did not update the draft content");
    await store.close();
    process.exit(1);
  }
  console.log("[5] insertLeadContent re-run → drafts upserted (no duplicates)");

  // 6) getStats reflects the smoke row.
  const stats = await store.getStats();
  console.log(
    `[6] getStats → totalPosts=${stats.totalPosts} scored=${stats.scoredPosts} drafts=${stats.pendingComments}`,
  );

  await store.close();
  console.log("\nsmoke OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
