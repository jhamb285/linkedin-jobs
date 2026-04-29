-- Single-command rollback for the 3-way LinkedIn-Jobs sourcing test.
-- Removes every row tagged by scripts/test-3way.ts and the scores derived
-- from them. After running, no test artifact remains in the posts/scores
-- tables.
--
-- Run with:
--   psql "$DATABASE_URL" -f scripts/test-3way-rollback.sql
--
-- The scrape_run_queries table is intentionally NOT touched — the runner
-- never writes there. The apify_runs rows tagged "test-3way-*" stay for
-- audit-trail purposes; remove the trailing block manually if you want
-- those gone too.

BEGIN;

-- Drop derived scores first (FK to posts).
DELETE FROM scores
 WHERE post_id IN (
   SELECT id FROM posts WHERE test_run_id LIKE 'test-%'
 );

-- Drop the test posts.
DELETE FROM posts WHERE test_run_id LIKE 'test-%';

COMMIT;

-- Sanity check.
SELECT count(*) AS remaining_test_posts
  FROM posts
 WHERE test_run_id LIKE 'test-%';

-- Optional: drop the apify_runs audit rows too.
-- DELETE FROM apify_runs WHERE actor LIKE 'test-3way-%';

-- Optional: drop the column entirely once the test is fully wound down.
-- ALTER TABLE posts DROP COLUMN test_run_id;
