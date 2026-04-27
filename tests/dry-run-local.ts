/**
 * Local dry-run with sample data — no API keys needed.
 * Tests the full pipeline: insert posts → score → generate comments → show status
 *
 * Usage: bun run tests/dry-run-local.ts
 */

import { Store } from "../src/store";
import { join } from "path";
import { mkdirSync } from "fs";

const DB_PATH = join(import.meta.dir, "..", "data", "leads-test.db");
mkdirSync(join(import.meta.dir, "..", "data"), { recursive: true });

const store = new Store(DB_PATH);

// ── Sample posts (realistic LinkedIn content) ──

const samplePosts = [
  {
    id: "demo-001",
    url: "https://linkedin.com/posts/sarahcto-looking-for-ai-engineer",
    authorName: "Sarah Chen",
    authorHeadline: "CTO at Nextera Health | Building AI-first healthcare",
    authorUrl: "https://linkedin.com/in/sarahchen",
    content:
      "We're looking for a freelance AI engineer to help us build an agentic system for patient triage. Need someone who understands multi-agent architectures and can work remote on a 3-month contract. RAG pipeline experience is a must. Budget is flexible for the right person. DM me if interested!",
    engagementCount: 47,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"looking for AI engineer"',
  },
  {
    id: "demo-002",
    url: "https://linkedin.com/posts/mikefoundr-ai-automation",
    authorName: "Mike Rodriguez",
    authorHeadline: "Founder @ ScaleOps | Marketing Automation",
    authorUrl: "https://linkedin.com/in/mikerodriguez",
    content:
      "Question for my network: who can build AI-powered automations? We need someone to set up a content pipeline that uses LLMs to generate, schedule, and analyze marketing content across 5 channels. Freelance or agency, remote preferred. This is a 6-week project.",
    engagementCount: 32,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"who can build AI"',
  },
  {
    id: "demo-003",
    url: "https://linkedin.com/posts/janedev-thoughts-on-agents",
    authorName: "Jane Park",
    authorHeadline: "Senior ML Engineer at Google",
    authorUrl: "https://linkedin.com/in/janepark",
    content:
      "Hot take: Most AI agent frameworks are over-engineered. You don't need LangGraph or CrewAI for 90% of use cases. A simple loop with tool-calling is enough. What do you think?",
    engagementCount: 234,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"AI agents"',
  },
  {
    id: "demo-004",
    url: "https://linkedin.com/posts/alexvp-hiring-ai-consultant",
    authorName: "Alex Thompson",
    authorHeadline: "VP Engineering @ FinanceAI | Series B",
    authorUrl: "https://linkedin.com/in/alexthompson",
    content:
      "Hiring: We need an AI consultant to audit our RAG pipeline and recommend improvements. Our retrieval accuracy dropped 15% after scaling to 2M documents. Looking for someone who's solved this at scale. Contract role, fully remote, starting ASAP. Competitive day rate.",
    engagementCount: 18,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"AI consultant" AND contract',
  },
  {
    id: "demo-005",
    url: "https://linkedin.com/posts/lisahr-new-role",
    authorName: "Lisa Wang",
    authorHeadline: "HR Director at TechFlow Inc",
    authorUrl: "https://linkedin.com/in/lisawang",
    content:
      "Excited to announce we're hiring a full-time Senior AI Engineer! Join our team in San Francisco to work on cutting-edge NLP. Competitive salary + equity. Apply through our careers page.",
    engagementCount: 89,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"hiring AI engineer"',
  },
  {
    id: "demo-006",
    url: "https://linkedin.com/posts/davidceo-need-help",
    authorName: "David Kim",
    authorHeadline: "CEO @ Retail.ai | E-commerce + AI",
    authorUrl: "https://linkedin.com/in/davidkim",
    content:
      "Need help with AI integration for our e-commerce platform. We want to add AI-powered product recommendations and a chatbot for customer support. Looking for a freelance AI developer or small agency who can deliver in 4-6 weeks. Remote work fine. DM me with your portfolio.",
    engagementCount: 25,
    scrapedAt: new Date().toISOString(),
    queryUsed: '"need help with AI" AND freelance',
  },
];

// ── Simulated scores (what Claude Haiku would return) ──

const simulatedScores = [
  {
    postId: "demo-001",
    relevance: 9,
    fit: 9,
    urgency: 8,
    engagementPotential: 8,
    total: 34,
    positioning: "agent_dev" as const,
    reasoning: "Direct ask for freelance AI engineer, agentic system, remote contract, budget mentioned",
    scoredAt: new Date().toISOString(),
  },
  {
    postId: "demo-002",
    relevance: 8,
    fit: 8,
    urgency: 7,
    engagementPotential: 8,
    total: 31,
    positioning: "automation_agency" as const,
    reasoning: "Looking for AI automation builder, freelance/agency, specific project scope and timeline",
    scoredAt: new Date().toISOString(),
  },
  {
    postId: "demo-003",
    relevance: 3,
    fit: 1,
    urgency: 0,
    engagementPotential: 7,
    total: 11,
    positioning: "consulting" as const,
    reasoning: "Discussion about AI agents but not looking for services. High engagement but no lead signal",
    scoredAt: new Date().toISOString(),
  },
  {
    postId: "demo-004",
    relevance: 9,
    fit: 9,
    urgency: 9,
    engagementPotential: 9,
    total: 36,
    positioning: "consulting" as const,
    reasoning: "Explicit need for RAG consultant, contract role, ASAP urgency, specific technical problem",
    scoredAt: new Date().toISOString(),
  },
  {
    postId: "demo-005",
    relevance: 6,
    fit: 1,
    urgency: 5,
    engagementPotential: 2,
    total: 14,
    positioning: "consulting" as const,
    reasoning: "Full-time role in SF, doesn't match freelance/contract/remote criteria",
    scoredAt: new Date().toISOString(),
  },
  {
    postId: "demo-006",
    relevance: 8,
    fit: 9,
    urgency: 7,
    engagementPotential: 8,
    total: 32,
    positioning: "automation_agency" as const,
    reasoning: "Freelance/agency ask, specific deliverables, timeline, remote OK, DM invite",
    scoredAt: new Date().toISOString(),
  },
];

// ── Simulated comments (what Claude Sonnet would generate) ──

const simulatedComments: Record<string, string> = {
  "demo-001":
    "Multi-agent triage is tricky — the key is getting the handoff protocol right between specialist agents. Have you evaluated a supervisor pattern vs peer-to-peer routing for your patient flows?",
  "demo-002":
    "The cross-channel consistency is the hard part here — each platform's API has different content constraints. Are you planning to generate platform-native variations or adapt a single source?",
  "demo-004":
    "15% retrieval drop at 2M docs usually points to chunk strategy rather than embedding quality. Have you tried hybrid search (dense + sparse) with reranking? That pattern holds up well at scale.",
  "demo-006":
    "For the chatbot piece — the biggest win is usually connecting it to your actual product catalog via RAG rather than training on static FAQs. What's your current data pipeline look like?",
};

// ── Run the simulation ──

console.log("\n" + "=".repeat(60));
console.log("  LOCAL DRY-RUN — No API keys needed");
console.log("=".repeat(60));

// Step 1: Insert posts
console.log("\n--- STEP 1: SCRAPE (simulated) ---\n");
let inserted = 0;
for (const post of samplePosts) {
  if (store.insertPost(post)) inserted++;
}
console.log(`Inserted ${inserted} sample posts`);

// Step 2: Score
console.log("\n--- STEP 2: SCORE (simulated) ---\n");
for (const score of simulatedScores) {
  store.insertScore(score);
  const marker = score.total >= 25 ? ">>>" : "   ";
  const post = samplePosts.find((p) => p.id === score.postId)!;
  console.log(
    `  ${marker} [${score.total}/40] ${post.authorName.padEnd(20)} | ${score.positioning.padEnd(18)} | ${score.reasoning.slice(0, 55)}...`
  );
}

// Step 3: Generate comments
console.log("\n--- STEP 3: GENERATE COMMENTS (simulated) ---\n");
const leads = store.getHighScoringUncommented(25);
console.log(`${leads.length} posts scored 25+ (leads):\n`);

for (const lead of leads) {
  const comment = simulatedComments[lead.id];
  if (comment) {
    store.insertComment(lead.id, comment);
    console.log(`  Author:  ${lead.author_name}`);
    console.log(`  Post:    "${lead.content.slice(0, 80)}..."`);
    console.log(`  Score:   ${lead.total}/40 (${lead.positioning})`);
    console.log(`  Comment: "${comment}"`);
    console.log();
  }
}

// Step 4: Show queue
console.log("--- STEP 4: REVIEW QUEUE ---\n");
const pending = store.getPendingComments();
console.log(`${pending.length} comments pending review:`);
for (const c of pending) {
  console.log(`  [${c.id}] ${c.authorName} -> "${c.comment_text.slice(0, 50)}..."`);
}

// Step 5: Status
console.log("\n--- PIPELINE STATUS ---\n");
const stats = store.getStats();
console.log(`  Posts scraped:     ${stats.totalPosts}`);
console.log(`  Posts scored:      ${stats.scoredPosts}`);
console.log(`  High-score (25+):  ${stats.highScorePosts}`);
console.log(`  Comments pending:  ${stats.pendingComments}`);
console.log(`  Comments approved: ${stats.approvedComments}`);
console.log(`  Comments posted:   ${stats.postedComments}`);
console.log(`  DMs pending:       ${stats.pendingDms}`);

console.log("\n" + "=".repeat(60));
console.log("  DRY-RUN COMPLETE — No API calls made");
console.log("  Test DB: data/leads-test.db");
console.log("=".repeat(60) + "\n");

store.close();
