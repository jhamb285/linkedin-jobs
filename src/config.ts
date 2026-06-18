import { readFileSync } from "fs";
import { join } from "path";
import type { AppConfig, SearchQuery } from "./types";

const ROOT = join(import.meta.dir, "..");

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
}

// Optional: returns empty string when neither env nor fallback is set.
// Use for integrations that may be disabled in some environments (e.g. Google Sheets export).
function optionalEnv(key: string, fallback: string = ""): string {
  return process.env[key] ?? fallback;
}

export function loadConfig(): AppConfig {
  return {
    apifyToken: env("APIFY_TOKEN"),
    apifyActorId: env(
      "APIFY_ACTOR_ID",
      "harvestapi/linkedin-post-search"
    ),
    // Vertex AI Express Mode key. See lib/vertex for the request shape.
    geminiApiKey: process.env.VERTEX_API_KEY ?? "",
    geminiModel: env("GEMINI_MODEL", "gemini-2.5-flash-preview-04-17"),
    googleCredentialsPath: optionalEnv("GOOGLE_CREDENTIALS_PATH"),
    googleTokenPath: optionalEnv("GOOGLE_TOKEN_PATH"),
    spreadsheetId: optionalEnv("SPREADSHEET_ID"),
    dbPath: env("DB_PATH", join(ROOT, "data", "leads.db")),
    scoringThreshold: parseInt(env("SCORING_THRESHOLD", "20"), 10),
    maxCommentsPerDay: parseInt(env("MAX_COMMENTS_PER_DAY", "25"), 10),
    maxConnectionsPerDay: parseInt(env("MAX_CONNECTIONS_PER_DAY", "15"), 10),
    maxDmsPerDay: parseInt(env("MAX_DMS_PER_DAY", "50"), 10),
    dailyScrapeCap: parseInt(env("DAILY_SCRAPE_CAP", "250"), 10),
    // Settle-lag FALLBACK estimate only. The actor migrated to PAY_PER_EVENT
    // (2026-03-09) — real cost is read from Apify's settled usageTotalUsd (see
    // scraper finish + budget-guard), not this flat per-lead rate. ~$0.0015/post
    // stays a rough stand-in for the row when PPE charges haven't posted yet.
    apifyCostPerLead: parseFloat(env("APIFY_COST_PER_LEAD", "0.0015")),
  };
}

export function loadSearchQueries(): SearchQuery[] {
  // Allow override via env var to run alternate query sets
  const queryFile = process.env.QUERY_FILE || "search-queries.json";
  const raw = readFileSync(join(ROOT, "config", queryFile), "utf-8");
  return JSON.parse(raw) as SearchQuery[];
}

export function loadPrompt(name: string): string {
  return readFileSync(join(ROOT, "config", `${name}.md`), "utf-8");
}

/**
 * Maps the legacy file-based prompt name to its DB-namespaced equivalent.
 * Convention: <pipeline>.<persona-or-channel>. Phase 7 multi-pipeline
 * foresight — when pipeline #2 lands, those prompts get
 * "linkedin_kol.lead.aj" etc. without a code change here.
 */
const DB_PROMPT_KEY: Record<string, string> = {
  "lead-prompt-aj": "linkedin_jobs.lead.aj",
  "lead-prompt-pk": "linkedin_jobs.lead.pk",
  "lead-prompt": "linkedin_jobs.lead",
  "comment-prompt": "linkedin_jobs.comment",
  "dm-prompt": "linkedin_jobs.dm",
  "scoring-prompt": "linkedin_jobs.scoring",
};

/**
 * DB-first prompt loader: looks up content_prompts.content by the
 * namespaced key first; falls back to the on-disk .md file when the row
 * is missing or DB is unreachable. Async — callers must await.
 *
 * The platform's Settings → Prompts tab edits the same DB row, so once
 * staff customizes a prompt in the UI the next cron run picks it up
 * without requiring a redeploy.
 */
export async function loadPromptDbFirst(name: string): Promise<string> {
  const key = DB_PROMPT_KEY[name];
  if (key) {
    try {
      const { db, schema } = await import("./db");
      const { eq } = await import("drizzle-orm");
      const rows = await db
        .select({ content: schema.contentPrompts.content })
        .from(schema.contentPrompts)
        .where(eq(schema.contentPrompts.promptName, key))
        .limit(1);
      if (rows.length && rows[0].content) {
        return rows[0].content;
      }
    } catch (err) {
      console.warn(
        `[loadPromptDbFirst] DB lookup for ${key} failed; falling back to file. ${(err as Error).message}`,
      );
    }
  }
  return loadPrompt(name);
}

export function getWeekNumber(): number {
  const dbPath = join(ROOT, "data", "leads.db");
  try {
    const { statSync } = require("fs");
    const stat = statSync(dbPath);
    const ageMs = Date.now() - stat.birthtimeMs;
    return Math.floor(ageMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  } catch {
    return 1;
  }
}

export function getDailyLimit(config: AppConfig): number {
  const week = getWeekNumber();
  if (week <= 1) return 5;
  if (week <= 2) return 10;
  if (week <= 3) return 15;
  return config.maxCommentsPerDay;
}

export function randomDelay(minMs: number, maxMs: number): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}
