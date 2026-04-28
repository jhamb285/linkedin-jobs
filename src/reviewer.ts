import type { Store } from "./store";

/**
 * REPLACED in Phase 6.
 *
 * The interactive comment-review TUI lived here in the SQLite era — it
 * walked through pending rows in the `comments` table and let an
 * operator approve / edit / reject each one in the terminal. The new
 * platform's review flow is the Today UI; this command is left as a
 * helpful redirect so old muscle-memory ("bun run review") still does
 * something sensible.
 */
export async function runReviewer(_store: Store): Promise<void> {
  console.log(
    "Comment review now lives in the platform Today UI " +
      "(http://localhost:3000/staff/today). Sign in as Srikant; " +
      "drafts come from `engagement_drafts` (one row per post × persona).",
  );
}
