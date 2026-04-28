/**
 * Postgres connection for the linkedin-jobs CLI.
 *
 * The schema is owned by the `platform` repo (single source of truth) and
 * imported via a relative path. The CLI must point at the SAME Postgres
 * instance that platform/web reads from — set DATABASE_URL accordingly.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config as loadDotenv } from "dotenv";
import * as schema from "./schema";

// Pull DATABASE_URL from .env.local at the repo root if it isn't already in
// the process env. Bun does this automatically for `bun run`, but we re-do
// it here so direct invocations (`bun src/foo.ts`) also work.
loadDotenv({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Point .env.local at the platform Postgres " +
      "(e.g. postgresql://platform:platform@localhost:5432/platform).",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });
export const db = drizzle(pool, { schema });
export { schema };
export type Database = typeof db;
