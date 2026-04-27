/**
 * Re-apply the deterministic hybrid filter to existing scored posts.
 * Updates fit scores based on explicit day counts in content.
 */
import { Database } from "bun:sqlite";
import { analyzeRemoteDays } from "../src/hybrid-filter";

const DB_PATH = "/Users/par1k/Desktop/par1k/lead-magnet/linkedin/lead-scrape-reply/data/leads.db";
const db = new Database(DB_PATH);

const posts = db.prepare(`
  SELECT p.id, p.author_name, p.content, s.fit, s.total, s.relevance, s.urgency, s.engagement_potential, s.reasoning
  FROM posts p JOIN scores s ON p.id = s.post_id
  WHERE length(p.content) > 0
`).all() as Array<{
  id: string;
  author_name: string;
  content: string;
  fit: number;
  total: number;
  relevance: number;
  urgency: number;
  engagement_potential: number;
  reasoning: string;
}>;

let changed = 0;
let newlyRejected = 0;
let newlyApproved = 0;

for (const post of posts) {
  const analysis = analyzeRemoteDays(post.content);
  let newFit = post.fit;
  let reason = post.reasoning;

  if (analysis.reject && post.fit > 0) {
    newFit = 0;
    reason = `[AUTO-REJECT] ${analysis.reason}. ${post.reasoning}`;
    newlyRejected++;
  } else if (
    analysis.remoteDays !== null &&
    analysis.remoteDays >= 3 &&
    post.fit < 5
  ) {
    newFit = 6;
    reason = `[AUTO-APPROVE] ${analysis.reason}. ${post.reasoning}`;
    newlyApproved++;
  }

  if (newFit !== post.fit) {
    const newTotal = post.relevance + newFit + post.urgency + post.engagement_potential;
    db.prepare(
      "UPDATE scores SET fit = ?, total = ?, reasoning = ? WHERE post_id = ?"
    ).run(newFit, newTotal, reason, post.id);
    console.log(`  ${post.author_name}: fit ${post.fit}→${newFit}, total ${post.total}→${newTotal} (${analysis.reason})`);
    changed++;
  }
}

console.log(`\n=== Summary ===`);
console.log(`Changed: ${changed}`);
console.log(`Newly rejected: ${newlyRejected}`);
console.log(`Newly approved: ${newlyApproved}`);

const stats = db.prepare(`SELECT count(*) as c FROM scores WHERE total >= 25 AND fit > 0`).get() as { c: number };
console.log(`Total approved now: ${stats.c}`);

db.close();
