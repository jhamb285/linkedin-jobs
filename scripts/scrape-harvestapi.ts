/**
 * Run the vertical queries through harvestapi/linkedin-post-search actor.
 * Inserts results into the same leads DB.
 */
import { ApifyClient } from "apify-client";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const DB_PATH = "/Users/par1k/Desktop/par1k/lead-magnet/linkedin/lead-scrape-reply/data/leads.db";
const ROOT = "/Users/par1k/Desktop/par1k/lead-magnet/linkedin/lead-scrape-reply";

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const actorId = "harvestapi/linkedin-post-search";
const db = new Database(DB_PATH);

function normalizeUrl(url: string): string {
  return url.split("?")[0].split("#")[0].replace(/\/$/, "");
}

function postId(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16);
}

// Location filter sets (reuse logic from scraper.ts)
const EXCLUDED_REGIONS = [
  "india", "delhi", "mumbai", "bangalore", "bengaluru", "hyderabad", "chennai",
  "pune", "kolkata", "ahmedabad", "noida", "gurgaon", "gurugram", "jaipur",
  "pakistan", "lahore", "karachi", "islamabad", "rawalpindi",
  "bangladesh", "dhaka",
  "nigeria", "lagos", "kenya", "nairobi",
  "south africa", "johannesburg", "cape town",
  "egypt", "cairo", "morocco", "casablanca",
];

const INDIA_CONTENT_SIGNALS = [
  "in india", "india-based", "indian market", "indian candidates",
  "bangalore", "bengaluru", "hyderabad", "pune", "chennai",
  "mumbai", "delhi", "noida", "gurgaon", "inr", "₹", "lakh",
  "in pakistan", "lahore", "karachi",
  "south africa", "johannesburg",
];

function checkLocation(headline: string, content: string): boolean {
  const h = headline.toLowerCase();
  const c = content.toLowerCase();
  if (EXCLUDED_REGIONS.some((r) => h.includes(r))) return false;
  if (INDIA_CONTENT_SIGNALS.some((s) => c.includes(s))) return false;
  return true;
}

// Non-English detection
function isEnglish(content: string): boolean {
  const nonLatin = (content.match(/[\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u309F]/g) || []).length;
  return nonLatin < 20;
}

// Intent filter
const OFFERING_SIGNALS = [
  "i help startups", "i help companies", "i help businesses",
  "i'm an ai consultant", "i am an ai consultant",
  "i'm a freelance", "book a call with me", "work with me", "hire me",
  "referral partners", "partnership opportunity",
];
const FULLTIME_SIGNALS = [
  "full-time role", "full time role", "full-time position", "permanent role",
  "permanent hire", "direct hire", "w2 role", "w2 only",
];

function intentPass(content: string, headline: string): boolean {
  const lc = content.toLowerCase();
  const lh = headline.toLowerCase();
  if (OFFERING_SIGNALS.some((s) => lc.includes(s))) return false;
  if (FULLTIME_SIGNALS.some((s) => lc.includes(s))) return false;
  if (lh.includes("ai consultant at") || lh.includes("freelance ai consultant")) return false;
  return true;
}

// Load queries from verticals file
const queriesFile = join(ROOT, "config", "search-queries-verticals.json");
const queries = JSON.parse(readFileSync(queriesFile, "utf-8")) as Array<{
  query: string;
  maxResults: number;
  group: string;
  note?: string;
}>;

async function main() {
  console.log(`Running ${queries.length} queries through harvestapi...\n`);

  let totalNew = 0;
  let totalOld = 0;
  let totalGeo = 0;
  let totalIntent = 0;
  let totalDupes = 0;
  let totalNonEnglish = 0;

  for (const q of queries) {
    console.log(`[${q.group}] ${q.query}`);
    try {
      const run = await client.actor(actorId).call({
        searchQueries: [q.query],
        maxPosts: q.maxResults,
        sortBy: "date",
        postedLimit: "week",
      });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();

      let newCount = 0;
      for (const item of items) {
        const raw = item as Record<string, unknown>;
        const url = (raw.linkedinUrl as string) || "";
        const content = (raw.content as string) || "";
        const author = (raw.author ?? {}) as Record<string, unknown>;
        const authorName = (author.name as string) || "";
        const authorHeadline = (author.info as string) || "";
        const authorUrl = (author.linkedinUrl as string) || "";
        const postedAt = (raw.postedAt ?? {}) as Record<string, unknown>;
        const dateStr = (postedAt.date as string) || "";

        if (!url || !content) continue;

        // Date check: 7 days
        try {
          const postDate = new Date(dateStr);
          const ageHours = (Date.now() - postDate.getTime()) / (1000 * 60 * 60);
          if (ageHours > 168) {
            totalOld++;
            continue;
          }
        } catch {}

        if (!isEnglish(content)) {
          totalNonEnglish++;
          continue;
        }

        if (!checkLocation(authorHeadline, content)) {
          totalGeo++;
          continue;
        }

        if (!intentPass(content, authorHeadline)) {
          totalIntent++;
          continue;
        }

        const id = postId(url);

        // Author dedup: 1 per week
        const authorRow = db
          .prepare("SELECT id FROM posts WHERE author_url = ? AND scraped_at > datetime('now', '-7 days')")
          .get(authorUrl) as { id: string } | undefined;
        if (authorRow && authorRow.id !== id) {
          totalDupes++;
          continue;
        }

        // Try insert
        try {
          db.prepare(
            `INSERT OR IGNORE INTO posts (id, url, author_name, author_headline, author_url, content, engagement_count, scraped_at, query_used)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            id,
            url,
            authorName,
            authorHeadline,
            authorUrl,
            content.slice(0, 5000),
            0,
            dateStr || new Date().toISOString(),
            q.query
          );
          const inserted = db.prepare("SELECT 1 FROM posts WHERE id = ?").get(id);
          if (inserted) newCount++;
        } catch {}
      }

      totalNew += newCount;
      console.log(`  -> ${items.length} fetched, ${newCount} new`);
    } catch (err) {
      console.error(`  -> Error: ${(err as Error).message}`);
    }
  }

  console.log(`\nDone: ${totalNew} new | ${totalGeo} geo | ${totalIntent} intent | ${totalOld} old | ${totalNonEnglish} non-english | ${totalDupes} dupes`);
  db.close();
}

main().catch(console.error);
