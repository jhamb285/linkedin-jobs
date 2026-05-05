/**
 * Rule-based author classification.
 *
 * Every author surfaced by the scraper — passing or filter-rejected —
 * gets a tag set written to `contact_identities.metadata.tags`. Tags
 * are derived from headline, name, and a small content sample using
 * substring + regex heuristics. No LLM calls.
 *
 * Why rule-based: the population is small enough (~200 fetched/day)
 * and the signal in headlines is strong enough that a curated rule
 * set produces ~90% accuracy at zero marginal cost. Stays in pipeline.
 *
 * Tags are intentionally a flat string[] (not enum) so the taxonomy
 * can grow without a code change in callers / DB queries that just
 * filter on `'student' = ANY (metadata->'tags')`.
 *
 * Categories:
 *   role          — student / intern / founder / executive / engineer /
 *                   architect / pm / designer / consultant / recruiter /
 *                   creator / business-owner / manager
 *   function      — ai-engineering / data-engineering / frontend /
 *                   fullstack / backend / devops / non-tech
 *   company-type  — company-page / agency / staffing-firm
 *   quality       — wrong-niche / target-fit / low-engagement /
 *                   india-content / non-english / spam-signals
 *   meta          — skip-rescore (composite — see shouldSkipRescore)
 */

export interface ClassifyResult {
  tags: string[];
  primaryRole: string | null;
  skipRescore: boolean;
}

export function classifyAuthor(
  authorName: string,
  authorHeadline: string,
  content: string,
): ClassifyResult {
  const tags = new Set<string>();
  const headline = (authorHeadline || "").toLowerCase();
  const name = (authorName || "").toLowerCase();
  const body = (content || "").toLowerCase();

  // ── Role detection (priority order — first match wins for primary role) ──
  let primaryRole: string | null = null;
  const setRole = (r: string) => {
    tags.add(r);
    if (!primaryRole) primaryRole = r;
  };

  // Student / intern — strongest signals. Check first.
  if (/\b(student at|undergrad|graduate student|fresher|sophomore|mba candidate|engineering student|college student)\b/.test(headline)) {
    setRole("student");
  } else if (/\bintern\b|\binternship\b|\bsummer intern\b/.test(headline)) {
    setRole("intern");
    tags.add("student"); // interns are typically students
  }

  // Founder — high target-fit. Check before generic exec.
  if (/\b(founder|co-?founder|cofounder|ceo of|ceo @|ceo at|owner of|owner @)\b/.test(headline)) {
    setRole("founder");
  }

  // Executive — VP, Director, CXO (without founder)
  if (
    !primaryRole &&
    /\b(vice president|\bvp\b|director of|director @|director at|chief \w+ officer|cxo|cto|cfo|coo|cmo|chief technology|head of)\b/.test(
      headline,
    )
  ) {
    setRole("executive");
  }

  // Recruiter — strongest signal across most spam. Check before generic roles.
  // Many recruiter signals overlap with SPAM_HEADLINE_SIGNALS in scraper.ts.
  const recruiterPatterns = [
    "recruiter", "recruitment", "talent acquisition", "talent scout",
    "headhunt", "headhunter", "staffing", "bench sales",
    "placement consultant", "resourcing specialist", "resource consultant",
    "us it recruiter", "tech recruiter", "hr recruiter", "hr executive",
    "matchmaker", "connecting talent", "talent connector",
  ];
  if (recruiterPatterns.some((p) => headline.includes(p))) {
    setRole("recruiter");
  }

  // PM / Scrum / Agile
  if (
    !primaryRole &&
    /\b(product manager|product owner|scrum master|agile coach|project manager|program manager|delivery manager)\b/.test(
      headline,
    )
  ) {
    setRole("pm");
  }

  // Architect
  if (!primaryRole && /\barchitect\b/.test(headline)) {
    setRole("architect");
  }

  // Consultant (generic — non-recruiter, non-AI)
  if (!primaryRole && /\bconsultant\b/.test(headline) && !/(ai consultant|llm consultant)/.test(headline)) {
    setRole("consultant");
  }

  // Engineer — broad, last among role categories
  if (!primaryRole && /\b(engineer|developer|programmer|swe|software engineer|sde)\b/.test(headline)) {
    setRole("engineer");
  }

  // Designer
  if (!primaryRole && /\b(designer|ux designer|ui designer|product designer)\b/.test(headline)) {
    setRole("designer");
  }

  // Manager (generic — only if no other role)
  if (!primaryRole && /\b(manager|lead|head)\b/.test(headline)) {
    setRole("manager");
  }

  // Content creator / thought leader
  if (
    /\b(content creator|thought leader|sharing latest|posting daily|creator|influencer)\b/.test(headline) ||
    /\b\d+k followers?\b/i.test(authorHeadline) ||
    /\b\d{3},\d{3} followers?\b/.test(authorHeadline)
  ) {
    tags.add("creator");
  }

  // Business owner (non-founder)
  if (!primaryRole && /\b(partner at|owner at|business owner|entrepreneur)\b/.test(headline)) {
    setRole("business-owner");
  }

  // ── Function / domain detection ──
  const aiEngHints = [
    "ai engineer", "ml engineer", "genai engineer", "llm engineer",
    "ai/ml", "ai-ml", "generative ai", "gen ai", "agentic", "rag",
    "ai developer", "ai architect",
  ];
  const isAiEng = aiEngHints.some((p) => headline.includes(p));
  if (isAiEng) tags.add("ai-engineering");

  if (/\bdata (engineer|scientist|analyst)\b/.test(headline)) tags.add("data-engineering");
  if (/\b(frontend|front-end|react developer|ui developer)\b/.test(headline)) tags.add("frontend");
  if (/\b(fullstack|full-stack|full stack)\b/.test(headline)) tags.add("fullstack");
  if (/\b(backend|back-end|backend developer)\b/.test(headline)) tags.add("backend");
  if (/\b(devops|sre|site reliability|infrastructure|platform engineer|cloud engineer)\b/.test(headline)) tags.add("devops");

  // ── Company-type ──
  if (/^[\d,]+\s+followers?$/i.test(authorHeadline.trim())) {
    tags.add("company-page");
  }
  if (/\b(agency|studio|labs|solutions|consultancy)\b/.test(name)) {
    tags.add("agency");
  }
  if (
    /\b(staffing|placements|tech services|infotech|it solutions|software services)\b/.test(name) ||
    /\b(staffing|bench sales)\b/.test(headline)
  ) {
    tags.add("staffing-firm");
  }

  // ── Quality signals ──

  // Low engagement — explicit low follower count in headline
  const lowFollowers = authorHeadline.match(/^(\d{1,3})\s+followers?$/i);
  if (lowFollowers && parseInt(lowFollowers[1], 10) < 200) {
    tags.add("low-engagement");
  }

  // India-content — light heuristic (the full check lives in checkLocation;
  // here we tag for analytics, not to gate filter).
  const indiaHints = [
    "in india", "india-based", "ist hours", "ist time",
    "lakh", "lakhs", "lpa", "ctc:", "₹", "rupees",
    "kindly revert", "do the needful", "share your cv at",
    "notice period", "immediate joiner", "naukri",
  ];
  if (indiaHints.some((h) => body.includes(h))) tags.add("india-content");

  // Non-English content (small sample size — just check if non-Latin chars dominate)
  const nonLatin = (content.match(/[؀-ۿऀ-ॿ一-鿿぀-ゟ゠-ヿ฀-๿]/g) || []).length;
  if (nonLatin > 10) tags.add("non-english");

  // Spam signals — appears together with the SPAM_BODY_SIGNALS check
  const spamHints = [
    "share your cv at", "drop your cv", "drop your resume",
    "available for c2c", "c2c bench", "h1b transfer",
    "open to opportunities", "open to work", "#opentowork",
    "fresh jobs", "looking for remote work in",
  ];
  if (spamHints.some((h) => body.includes(h))) tags.add("spam-signals");

  // ── Composite quality assessment ──

  // Wrong-niche — has a strong non-AI engineering signal AND no AI signal
  const nonAiEngFunctions = ["devops", "frontend", "backend", "fullstack", "data-engineering", "designer"];
  const hasNonAiFunction = nonAiEngFunctions.some((f) => tags.has(f));
  if (hasNonAiFunction && !tags.has("ai-engineering")) {
    tags.add("wrong-niche");
  }

  // Target-fit — founder/exec + AI engineering signal in body content
  // (founder posts often don't list "AI" in headline but do in body)
  const aiContentHint = /\b(ai engineer|ml engineer|llm|rag pipeline|generative ai|ai automation|chatbot|agent)\b/.test(body);
  if ((primaryRole === "founder" || primaryRole === "executive") && aiContentHint) {
    tags.add("target-fit");
  }

  // ── Skip-rescore composite ──
  // Authors we should NOT bother re-scoring on future scrapes.
  // Heavy bias toward false-rejects: only set when the signal is unambiguous.
  const skipRescore =
    tags.has("student") ||
    tags.has("intern") ||
    (tags.has("recruiter") && !tags.has("target-fit")) ||
    tags.has("staffing-firm") ||
    tags.has("low-engagement") ||
    tags.has("non-english") ||
    (tags.has("wrong-niche") && !tags.has("target-fit"));

  if (skipRescore) tags.add("skip-rescore");

  return {
    tags: [...tags].sort(),
    primaryRole,
    skipRescore,
  };
}
