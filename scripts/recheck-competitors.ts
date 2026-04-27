/**
 * Re-scan approved leads for competitor/newsletter-promo patterns.
 * Auto-rejects any that match and logs them.
 */
import { Database } from "bun:sqlite";

const DB_PATH = "/Users/par1k/Desktop/par1k/lead-magnet/linkedin/lead-scrape-reply/data/leads.db";
const db = new Database(DB_PATH);

const competitorHeadlines = [
  "ai consultant at", "ai consultant |", "freelance ai consultant",
  "freelance ai engineer", "freelance ai developer",
  "i help startups", "i help companies", "i help founders",
  "i help businesses", "helping companies with ai",
  "helping startups with ai", "helping founders", "helping teams",
  "ai agency", "ai studio", "ai automation agency",
  "ai consultant & engineer", "ai consultant and engineer",
  "ai integration |", "ai integration expert", "workflow & ai integration",
  "ai strategy consultant", "ai implementation consultant",
  "ai transformation consultant", "ai automation consultant",
  "ai advisor |", "ai expert |",
];

const newsletterPromo = [
  "read it here", "read the full article", "subscribe to my newsletter",
  "link to the full post", "check out my latest", "my latest article",
  "my latest newsletter", "this week's newsletter", "my substack",
  "link in bio", "read more below",
];

const leads = db.prepare(`
  SELECT p.id, p.author_name, p.author_headline, p.content, s.total, s.fit, s.reasoning,
    s.relevance, s.urgency, s.engagement_potential
  FROM posts p JOIN scores s ON p.id = s.post_id
  WHERE s.total >= 25 AND s.fit > 0
`).all() as Array<{
  id: string;
  author_name: string;
  author_headline: string;
  content: string;
  total: number;
  fit: number;
  reasoning: string;
  relevance: number;
  urgency: number;
  engagement_potential: number;
}>;

let rejected = 0;
for (const lead of leads) {
  const headline = (lead.author_headline || "").toLowerCase();
  const content = (lead.content || "").toLowerCase();

  const matchedHeadline = competitorHeadlines.find((h) => headline.includes(h));
  const matchedPromo = newsletterPromo.find((p) => content.includes(p));

  if (matchedHeadline || matchedPromo) {
    const reason = matchedHeadline
      ? `competitor headline: "${matchedHeadline}"`
      : `newsletter promo: "${matchedPromo}"`;
    const newTotal = lead.relevance + 0 + lead.urgency + lead.engagement_potential;
    db.prepare(
      "UPDATE scores SET fit = 0, total = ?, reasoning = ? WHERE post_id = ?"
    ).run(newTotal, `[AUTO-REJECT] ${reason}. ${lead.reasoning}`, lead.id);
    console.log(`  ${lead.author_name}: rejected (${reason})`);
    rejected++;
  }
}

console.log(`\n=== ${rejected} leads rejected ===`);
const stats = db.prepare("SELECT count(*) as c FROM scores WHERE total >= 25 AND fit > 0").get() as { c: number };
console.log(`Approved now: ${stats.c}`);

db.close();
