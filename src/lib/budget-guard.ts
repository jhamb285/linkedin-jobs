/**
 * Daily Apify budget guard for linkedin-jobs.
 *
 * ONE cap for ALL LinkedIn Apify spend. Resolves to APIFY_LINKEDIN_DAILY_CAP,
 * then the shared APIFY_DAILY_CAP_USD, then 1.00.
 *
 * Two layers make the cap HARD (ported from reddit-intent / x-intent):
 *   1. This between-run guard sums settled charges over a rolling 24h window
 *      and refuses fresh starts at/over the line.
 *   2. The scraper passes the remaining headroom as `maxTotalChargeUsd` on
 *      each actor call, so Apify itself aborts the run at the ceiling.
 *
 * Spend is read from APIFY'S OWN BOOKS (per-actor run lists with settled
 * `usageTotalUsd`), not our apify_runs rows. Why: harvestapi/linkedin-post-search
 * migrated to PAY_PER_EVENT (2026-03-09) — it now charges a per-start fee and
 * $0.001 per 0-result query on top of per-post, so the old flat $1.50/1k
 * estimate no longer matches the bill. PPE charges also keep settling AFTER a
 * run reports SUCCEEDED, and manual console runs never reach our DB. Falls
 * back to the DB sum (which now records real usageTotalUsd) if the API fails.
 */
import { pool } from "../db";

/** Every Apify actor this pipeline charges through. Both count against the one
 *  LinkedIn cap, including manual console runs. APIFY_ACTOR_ID is the search
 *  actor; the profile-posts actor backs the profile-watch bucket. */
export const LINKEDIN_ACTORS = [
  process.env.APIFY_ACTOR_ID ?? "harvestapi/linkedin-post-search",
  "harvestapi/linkedin-profile-posts",
];

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

/** Settled spend for one actor over the rolling last 24h, from Apify's books. */
async function fetchActorSpend24h(
  actor: string,
  token: string,
): Promise<number> {
  const actorPath = actor.replace("/", "~");
  const res = await fetch(
    `https://api.apify.com/v2/acts/${actorPath}/runs?desc=1&limit=100&token=${token}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    // 404 = actor never run on this account; treat as $0, anything else throws
    // so the caller falls back to the DB sum.
    if (res.status === 404) return 0;
    throw new Error(`Apify API ${res.status} for ${actor}`);
  }
  const json = (await res.json()) as {
    data?: { items?: Array<{ startedAt?: string; usageTotalUsd?: number }> };
  };
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let spent = 0;
  for (const r of json.data?.items ?? []) {
    const started = r.startedAt ? Date.parse(r.startedAt) : NaN;
    if (Number.isFinite(started) && started >= cutoff) {
      spent += r.usageTotalUsd ?? 0;
    }
  }
  return spent;
}

/**
 * Fallback only: sum recorded LinkedIn spend from our own apify_runs rows over
 * the rolling 24h. Matches any LinkedIn actor (search + profile-posts).
 */
export async function getSpentTodayFromDb(): Promise<number> {
  const res = await pool.query<{ spent: string }>(
    `SELECT COALESCE(SUM(total_cost_usd), 0)::text AS spent
       FROM apify_runs
      WHERE actor ILIKE '%linkedin%' AND started_at >= now() - interval '24 hours'`,
  );
  return parseFloat(res.rows[0]?.spent ?? "0");
}

/** Settled LinkedIn-actor spend over the rolling last 24h, from Apify's books. */
export async function getSpentToday(): Promise<number> {
  const token = process.env.APIFY_TOKEN;
  if (token) {
    try {
      const spends = await Promise.all(
        LINKEDIN_ACTORS.map((a) => fetchActorSpend24h(a, token)),
      );
      return spends.reduce((sum, s) => sum + s, 0);
    } catch (e) {
      console.warn(
        `[budget-guard] Apify API unreachable (${(e as Error).message.slice(0, 80)}); falling back to DB sum`,
      );
    }
  }
  return getSpentTodayFromDb();
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
