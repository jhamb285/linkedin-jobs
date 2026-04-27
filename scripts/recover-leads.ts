/**
 * Recover leads from historical Google Sheet revisions (CSV dumps).
 * Reads CSVs from /tmp/sheet-recovery/, parses them, merges into leads.db.
 * Skips posts already in DB (by post URL match).
 */

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const DB_PATH = "/Users/par1k/Desktop/par1k/lead-magnet/linkedin/lead-scrape-reply/data/leads.db";
const RECOVERY_DIR = "/tmp/sheet-recovery";

const db = new Database(DB_PATH);

// Parse CSV row respecting quotes
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(content: string): Record<string, string>[] {
  // Handle multi-line quoted values
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      if (inQuotes && content[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "\n" && !inQuotes) {
      if (current.trim()) rows.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) rows.push(current);

  if (rows.length === 0) return [];
  const headers = parseCsvLine(rows[0]);
  return rows.slice(1).map((row) => {
    const values = parseCsvLine(row);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = values[i] || ""));
    return obj;
  });
}

function postId(url: string, content: string): string {
  return createHash("sha256").update(url + content).digest("hex").slice(0, 16);
}

const files = readdirSync(RECOVERY_DIR).filter((f) => f.endsWith(".csv"));
console.log(`Found ${files.length} recovery files:`, files);

let totalRecovered = 0;
let totalSkipped = 0;

for (const file of files) {
  console.log(`\n--- Processing ${file} ---`);
  const content = readFileSync(join(RECOVERY_DIR, file), "utf-8");
  const rows = parseCsv(content);
  console.log(`  ${rows.length} rows`);

  for (const row of rows) {
    const author = row.Author || row["Author"] || "";
    const headline = row.Headline || row["Headline"] || "";
    const profileUrl = row["Profile URL"] || "";
    const postUrl = row["Post URL"] || "";
    const summary = row["What They Need"] || "";
    const score = parseInt(row.Score || "0", 10);
    const relevance = parseInt(row.R || "0", 10);
    const fit = parseInt(row.F || "0", 10);
    const urgency = parseInt(row.U || "0", 10);
    const engagement = parseInt(row.E || "0", 10);
    const positioning = row.Positioning || "consulting";
    const reasoning = row["Why This Score"] || "";
    const comment = row["Our Comment"] || "";
    const connectionNote = row["Connection Note"] || "";
    const dm = row["DM Message"] || "";
    const queryUsed = row["Query Used"] || "";
    const date = row.Date || new Date().toISOString();

    if (!postUrl || !author) continue;

    const id = postId(postUrl, summary);

    // Check if already in DB
    const existing = db
      .prepare("SELECT id FROM posts WHERE url = ? OR id = ?")
      .get(postUrl, id);

    if (existing) {
      totalSkipped++;
      continue;
    }

    // Insert post
    db.prepare(
      `INSERT OR IGNORE INTO posts (id, url, author_name, author_headline, author_url, content, engagement_count, scraped_at, query_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, postUrl, author, headline, profileUrl, summary, 0, date, queryUsed);

    // Insert score (only if positive)
    if (score > 0) {
      db.prepare(
        `INSERT OR REPLACE INTO scores (post_id, relevance, fit, urgency, engagement_potential, total, positioning, reasoning, scored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, relevance, fit, urgency, engagement, score, positioning, reasoning, date);
    }

    // Insert lead_content if approved
    if (score >= 25 && fit > 0 && comment) {
      db.prepare(
        `INSERT OR REPLACE INTO lead_content (post_id, summary, comment, connection_note, dm, generated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, summary, comment, connectionNote, dm, date);

      // Also insert comment row
      db.prepare(
        `INSERT OR IGNORE INTO comments (post_id, comment_text, status, generated_at)
         VALUES (?, ?, 'pending', ?)`
      ).run(id, comment, date);
    }

    totalRecovered++;
    console.log(`  + recovered: ${author}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Recovered: ${totalRecovered}`);
console.log(`Skipped (already in DB): ${totalSkipped}`);

const stats = {
  total: (db.prepare("SELECT count(*) as c FROM posts").get() as any).c,
  scored: (db.prepare("SELECT count(*) as c FROM scores").get() as any).c,
  approved: (db.prepare("SELECT count(*) as c FROM scores WHERE total >= 25 AND fit > 0").get() as any).c,
  content: (db.prepare("SELECT count(*) as c FROM lead_content").get() as any).c,
};
console.log(`DB now has: ${stats.total} posts, ${stats.scored} scored, ${stats.approved} approved, ${stats.content} with content`);

db.close();
