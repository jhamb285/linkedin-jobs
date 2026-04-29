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
    geminiApiKey: env("GEMINI_API_KEY"),
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
    // harvestapi/linkedin-post-search bills $1.50/1000 posts → $0.0015/lead.
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
