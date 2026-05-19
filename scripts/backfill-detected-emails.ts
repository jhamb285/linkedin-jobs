/**
 * One-off backfill: scan linkedin_jobs posts.content for emails and
 * persist detect_email into posts.metadata. Reused detectEmail() from
 * the live scraper so the strict TLD allow-list applies consistently.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });

import { Pool } from "pg";
import { detectEmail } from "../src/scraper";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query<{
    id: string;
    content: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, content, metadata
     FROM posts
     WHERE source = 'linkedin_jobs'
       AND (metadata->>'detected_email') IS NULL
       AND content ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'
     LIMIT 2000`,
  );
  console.log(`[backfill] inspecting ${rows.length} candidates…`);

  let updated = 0;
  let nullDetected = 0;
  for (const r of rows) {
    const email = detectEmail(r.content ?? "");
    if (!email) {
      nullDetected++;
      continue;
    }
    const nextMeta = { ...(r.metadata ?? {}), detected_email: email };
    await pool.query(`UPDATE posts SET metadata = $1::jsonb WHERE id = $2`, [
      JSON.stringify(nextMeta),
      r.id,
    ]);
    updated++;
  }

  console.log(
    `[backfill] updated=${updated} null-detected=${nullDetected} candidates=${rows.length}`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
