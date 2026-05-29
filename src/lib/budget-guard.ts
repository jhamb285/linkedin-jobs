/**
 * Daily Apify budget guard for linkedin-jobs.
 *
 * Sums `apify_runs.total_cost_usd` over a rolling 24h window for the LinkedIn
 * actor and refuses the next run once the cap is met. This is the unified
 * guard contract shared with reddit-intent and x-intent.
 *
 * Cap resolves to APIFY_LINKEDIN_DAILY_CAP, then the shared
 * APIFY_DAILY_CAP_USD, then 1.00. harvestapi/linkedin-post-search bills per
 * fetched post AFTER the run completes, so this is a between-run guard: it
 * blocks fresh starts once spend is at/over the line but cannot abort a run
 * mid-flight. Per-run cost is bounded separately by the item budget
 * (config.dailyScrapeCap).
 */
import { pool } from "../db";

// Must match the actor string written by store.startScrapeRun(), which is
// hardcoded there (NOT derived from APIFY_ACTOR_ID). Keep these in sync.
const RECORDED_ACTOR = "harvestapi/linkedin-post-search";

export function getDailyCap(): number {
  const raw =
    process.env.APIFY_LINKEDIN_DAILY_CAP ?? process.env.APIFY_DAILY_CAP_USD;
  const parsed = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1.0;
}

export interface BudgetStatus {
  spentToday: number;
  cap: number;
  remaining: number;
  blocked: boolean;
}

/**
 * Sum LinkedIn-actor spend over the rolling last 24h. Returns 0.00 when no
 * rows exist or when total_cost_usd is null on every row (e.g. in-flight
 * 'running' rows that haven't been finished yet).
 */
export async function getSpentToday(): Promise<number> {
  const res = await pool.query<{ spent: string }>(
    `SELECT COALESCE(SUM(total_cost_usd), 0)::text AS spent
       FROM apify_runs
      WHERE actor = $1 AND started_at >= now() - interval '24 hours'`,
    [RECORDED_ACTOR],
  );
  return parseFloat(res.rows[0]?.spent ?? "0");
}

export async function getBudgetStatus(): Promise<BudgetStatus> {
  const spent = await getSpentToday();
  const cap = getDailyCap();
  return {
    spentToday: spent,
    cap,
    remaining: Math.max(0, cap - spent),
    blocked: spent >= cap,
  };
}
