import { ApifyClient } from "apify-client";
import type { AppConfig, ScrapedPost } from "./types";
import type { Store, QueryRunCounts } from "./store";
import { loadSearchQueries } from "./config";
import { recordEvent } from "./events";
import { getBudgetStatus } from "./lib/budget-guard";
import { classifyAuthor } from "./author-classifier";
import { createHash } from "crypto";

/**
 * Strip query params + fragments from LinkedIn post URLs.
 * Same post can have different utm_source, rcm params but same base URL.
 */
function normalizeUrl(url: string): string {
  return url.split("?")[0].split("#")[0].replace(/\/$/, "");
}

function postId(url: string, content: string): string {
  // Use normalized URL only (not content) so dedup works across scrapes
  return createHash("sha256")
    .update(normalizeUrl(url))
    .digest("hex")
    .slice(0, 16);
}

// Content fingerprint for dedup — catches same post scraped via different URLs
function contentFingerprint(authorName: string, content: string): string {
  const normalized = (authorName + content).replace(/\s+/g, " ").trim().slice(0, 200);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Email detection ──
// Catches both standard "name@domain.tld" and obfuscated "name at domain
// dot com" patterns. Ported from lead-magnet but TIGHTENED — the original
// regex allowed uppercase TLDs ([a-zA-Z]{2,}) which matches sentence-end
// fragments like "collabor@ions.Find" (false positive on natural prose
// where '@' appears mid-sentence). LinkedIn posts mash punctuation and
// the loose original was wrong ~50% of the time on our corpus.
//
// New rules:
//  - TLD must be lowercase (strict [a-z]{2,})
//  - Domain must NOT contain uppercase letters (extra sentence-boundary guard)
//  - Local part must not start or end with '.'
//  - Word boundaries anchored (\b)
//  - TLD must be in a known-valid list (rejects "ions.Find" -> TLD="Find")
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-z]{2,}\b/g;
const OBFUSCATED_EMAIL_REGEX =
  /\b([a-zA-Z0-9._%+-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\))\s*([a-zA-Z0-9.-]+)\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\.)\s*([a-z]{2,})\b/i;
// Conservative TLD allow-list — covers ~99% of real outbound contacts in
// our space (engineering / consulting / startup domains). Add more as
// real false-negatives surface.
const VALID_TLDS = new Set([
  "com", "net", "org", "io", "co", "ai", "dev", "app", "tech", "me",
  "in", "us", "uk", "ca", "au", "nz", "sg", "de", "fr", "es", "nl",
  "eu", "info", "biz", "agency", "studio", "consulting", "company",
  "page", "site", "online", "cloud", "tools", "engineering",
]);

export function detectEmail(text: string): string | null {
  if (!text) return null;
  for (const match of text.matchAll(EMAIL_REGEX)) {
    const email = match[0];
    const [local, domain] = email.split("@");
    if (!local || !domain) continue;
    if (local.startsWith(".") || local.endsWith(".")) continue;
    // Reject sentence-boundary matches: a domain with uppercase letters
    // is almost always a regex bleed into prose.
    if (/[A-Z]/.test(domain)) continue;
    const tld = domain.split(".").pop()!.toLowerCase();
    if (!VALID_TLDS.has(tld)) continue;
    return email;
  }
  const obfuscated = text.match(OBFUSCATED_EMAIL_REGEX);
  if (obfuscated) {
    const tld = obfuscated[3].toLowerCase();
    if (VALID_TLDS.has(tld)) {
      return `${obfuscated[1]}@${obfuscated[2]}.${tld}`;
    }
  }
  return null;
}

// ── Location Filter ──

const TARGET_REGIONS: string[] = [
  // US
  "united states", "usa", "u.s.", "new york", "san francisco", "los angeles",
  "chicago", "seattle", "austin", "boston", "denver", "miami", "atlanta",
  "dallas", "houston", "portland", "san diego", "washington", "dc", "nyc",
  "sf bay", "bay area", "silicon valley", "california", "texas", "florida",
  "colorado", "massachusetts", "virginia", "georgia", "north carolina",
  "pennsylvania", "ohio", "illinois", "arizona", "oregon", "new jersey",
  "minnesota", "tennessee", "michigan", "maryland", "connecticut",
  // Europe
  "europe", "european union", "eu", "united kingdom", "uk", "london",
  "berlin", "paris", "amsterdam", "munich", "zurich", "dublin",
  "stockholm", "copenhagen", "oslo", "helsinki", "barcelona", "madrid",
  "lisbon", "vienna", "brussels", "milan", "rome", "prague", "warsaw",
  "germany", "france", "netherlands", "switzerland", "ireland", "sweden",
  "denmark", "norway", "finland", "spain", "portugal", "austria",
  "belgium", "italy", "poland", "czech", "estonia", "latvia", "lithuania",
  "england", "scotland", "wales", "luxembourg", "iceland", "greece", "athens",
  "hungary", "budapest", "romania", "bucharest", "croatia", "zagreb",
  // UK specific
  "manchester", "birmingham", "edinburgh", "bristol", "leeds", "glasgow",
  "liverpool", "cardiff", "belfast", "cambridge", "oxford",
  // Australia & NZ
  "australia", "sydney", "melbourne", "brisbane", "perth", "adelaide",
  "canberra", "queensland", "new south wales", "victoria",
  "new zealand", "auckland", "wellington",
  // Canada
  "canada", "toronto", "vancouver", "montreal", "ottawa", "calgary",
  // Asia Pacific (developed)
  "singapore", "malaysia", "kuala lumpur", "japan", "tokyo", "south korea",
  "seoul", "hong kong", "taiwan", "taipei",
  // Middle East
  "dubai", "abu dhabi", "uae", "united arab emirates", "saudi arabia",
  "riyadh", "jeddah", "qatar", "doha", "bahrain", "kuwait", "oman",
  "muscat", "israel", "tel aviv",
  // Americas (non-US)
  "mexico", "mexico city", "monterrey", "brazil", "são paulo", "sao paulo",
  "argentina", "buenos aires", "chile", "santiago", "colombia", "bogotá",
  "bogota", "costa rica", "panama", "uruguay",
  // General
  "remote", "worldwide", "global", "anywhere",
];

const EXCLUDED_REGIONS: string[] = [
  // India — country + cities
  // (Indian states + union territories were added 2026-04-29 as a
  // single-match reject, then rolled back 2026-05-12 because they
  // were over-rejecting US/EU posts mentioning a state in passing
  // and produced no measurable win over the city + country list.
  // "X State Jobs" company pages are caught instead by the
  // author-name region check + the india-content-signal tier.)
  "india", "delhi", "mumbai", "bangalore", "bengaluru", "hyderabad",
  "chennai", "pune", "kolkata", "ahmedabad", "noida", "gurgaon",
  "gurugram", "jaipur", "lucknow", "chandigarh", "kochi", "indore",
  "nagpur", "coimbatore", "thiruvananthapuram", "bhubaneswar",
  "surat", "vadodara", "ludhiana", "agra", "nashik", "faridabad",
  "meerut", "rajkot", "kanpur", "visakhapatnam", "patna", "mysore",
  // Pakistan
  "pakistan", "lahore", "karachi", "islamabad", "rawalpindi",
  "faisalabad", "peshawar", "multan", "quetta", "sialkot",
  // Bangladesh
  "bangladesh", "dhaka", "chittagong", "sylhet",
  // Africa (full coverage)
  "nigeria", "lagos", "abuja", "ibadan", "kano", "port harcourt",
  "kenya", "nairobi", "mombasa", "kisumu",
  "south africa", "johannesburg", "cape town", "durban", "pretoria",
  "egypt", "cairo", "alexandria", "giza",
  "morocco", "casablanca", "rabat", "marrakech",
  "ethiopia", "addis ababa",
  "ghana", "accra", "kumasi",
  "tanzania", "dar es salaam", "dodoma",
  "uganda", "kampala",
  "rwanda", "kigali",
  "algeria", "algiers",
  "tunisia", "tunis", "tunisian",
  "senegal", "dakar",
  "ivory coast", "abidjan",
  "cameroon", "yaoundé", "douala",
  "zimbabwe", "harare",
  "angola", "luanda",
  "mozambique", "maputo",
  "libya", "tripoli",
  "sudan", "khartoum",
  "zambia", "lusaka",
];

// India/South Asia/Africa content signals — split into HARD and SOFT tiers.
//
// HARD = unambiguous tells that single-match-reject. Explicit "in India" /
// IST timezone / Indian-English idioms / Indian comp markers / etc. — these
// only appear when the post truly originates from or targets India/PK/BD/AF.
//
// SOFT = ambiguous signals that require 2+ matches OR absent target-region
// anchor before rejecting. City names ("bangalore"), outsourcing-firm names
// ("tcs ", "infosys "), and African city names — these can legitimately
// appear in US/EU posts ("our team is in NYC and Bangalore, role is fully
// remote in the US"). Single match alone is too noisy. The 04-28 round
// that conflated these with the hard signals dropped pass rate from
// ~22% to ~5%; this split restores the original signal/noise ratio.
// IMPORTANT: per user direction (2026-05-19), Indian RECRUITERS posting
// roles for abroad clients are valid leads — the staffing firm is just
// the middleman. We only reject when the ROLE ITSELF is located in
// India (Indian working hours, INR/lakh pay, "in India" location,
// candidates required from India). Don't add Indian-staffing-firm-voice
// signals (e.g. "share profiles at", "interested consultants or
// referrals") to this list — those are author-voice, not role-location.
const INDIA_CONTENT_HARD: string[] = [
  // India — explicit role location
  "in india", "india-based role", "india based role", "based in india",
  "indian market", "indian candidates", "candidates from india",
  "remote within india", "within india", "remote - india", "remote in india",
  // India — IST timezone (only used in India-context)
  "ist hours", "ist time", "ist timezone", "ist working hours",
  "indian standard time", "ist shift", "9am ist", "10am ist", "5pm ist",
  // India — comp markers (rupee / lakh / LPA / CTC) — strong role-location tells
  "inr ", " inr,", " inr.", "₹", "lakh", "lakhs", "lpa", "ctc:",
  "rupees",
  // India — language idioms (kept as-is from prior version)
  "do the needful", "kindly revert", "kindly do", "pfa ",
  "as per discussion", "interested candidates may", "interested candidates can",
  "looking for immediate joiners", "immediate joiner", "immediate joiners",
  "notice period", "serving notice", "preferred notice",
  // India — comp markers (rupee / lakh / LPA / CTC)
  "inr ", " inr,", " inr.", "₹", "lakh", "lakhs", "lpa", "ctc:",
  "rupees",
  // India — job board
  "naukri", "naukri.com", "indeed.co.in",
  // Pakistan — explicit
  "in pakistan", "pakistan-based", "pakistani candidates",
  // Bangladesh — explicit
  "in bangladesh", "bangladesh-based",
  // Africa — explicit ("in country" / "country-based")
  "in nigeria", "nigeria-based",
  "in kenya", "kenya-based",
  "in egypt", "egypt-based",
  "in morocco", "in ghana", "in ethiopia", "in tanzania", "in uganda",
  "tunisian candidates", "algerian candidates",
];

const INDIA_CONTENT_SOFT: string[] = [
  // India — cities (alone don't reject — see SOFT logic in checkLocation)
  "bangalore", "bengaluru", "hyderabad", "pune", "chennai",
  "mumbai", "delhi", "noida", "gurgaon", "gurugram",
  "kolkata", "ahmedabad", "jaipur", "kochi", "indore",
  "nagpur", "coimbatore", "lucknow", "chandigarh",
  "bhubaneswar", "thiruvananthapuram", "vadodara", "surat", "visakhapatnam",
  // India — outsourcing firms (can appear in legit comparisons)
  "tcs ", "infosys ", "wipro ", "hcl ", "cognizant ",
  "tech mahindra", "capgemini india", "accenture india",
  "ltimindtree", "mphasis ", "mindtree ", "persistent systems",
  // Pakistan — cities
  "lahore", "karachi", "islamabad", "rawalpindi", "peshawar",
  "pkr", "rs/-",
  // Bangladesh — cities
  "dhaka", "chittagong",
  // Currency loose markers (frequent false positives)
  "rs.", "rs ", "fixed pay", "variable pay",
  // Africa — cities (often in legit posts mentioning a global team)
  "lagos", "abuja", "ibadan", "kano",
  "nairobi", "mombasa",
  "johannesburg", "cape town", "pretoria", "durban",
  "south africa",
  "cairo", "alexandria", "giza",
  "casablanca", "rabat", "marrakech",
  "accra", "kumasi",
  "addis ababa",
  "dar es salaam", "dodoma",
  "kampala",
];

// Recruiter spam headline signals (staffing agencies from excluded regions).
//
// 2026-05-12: trimmed back to the lead-magnet baseline (7 unambiguous
// staffing terms). The 04-29 expansion added 24 patterns covering
// "recruiter" / "talent acquisition" / "matchmaker" — that catches a
// lot of legitimate recruiter-titled buyers (e.g. in-house Talent
// Acquisition leads at startups posting genuine contract roles). The
// LLM scorer is the right place for that judgment, not the filter.
const SPAM_HEADLINE_SIGNALS: string[] = [
  "bench sales", "staffing", "manpower", "placement agency",
  "offshore development", "nearshore", "bodyshop",
];

// SPAM_BODY_SIGNALS removed 2026-05-12.
//
// The 80-pattern array was added 2026-04-29 to catch Indian-staffing C2C
// / bench / visa-broker patterns + "27 remote platforms" affiliate spam
// + #opentowork posts + thought-leadership openers. In production this
// over-rejected real contract roles where the body mentioned "C2C" or
// "share your cv" as a normal recruiting term, AND the LLM scorer
// already scores all of these noise patterns as 0/40. Keeping the
// scorer as the noise gate (rather than the filter chain) restored
// 60-70 inserted/day vs the post-04-29 baseline of ~10. See lead-magnet
// audit — the original tool ran without this layer.

// "contract rescue" gate.
// User policy: accept ANY recruiter (US-staffing, Indian, etc.) IF the post
// is for a real contract/freelance role in a target region (US/UK/EU/AU/SG/ME).
// The buyer is the end-client, not the recruiter — even when offshore-shop is
// the middleman, a real US contract is a real lead.
//
// Rescue passes only when ALL FOUR are true:
//   1. Body has explicit contract signal (contract / c2c / 1099 / freelance)
//   2. Body does NOT have FTE signals (full-time / salary range / RSU / 401k)
//   3. Body has explicit target-region signal (USA / UK / EU / AU / SG / UAE
//      named, or USD currency, or US-timezone shift, or USC/GC visa)
//   4. Body does NOT have India-role markers (INR / LPA / CTC / IST hours /
//      "kindly revert" / "share your cv at" / Indian outsourcing-firm names)
//
// Falsifying any of those drops back to the standard geo rejection rules.

const RESCUE_CONTRACT_SIGNALS: string[] = [
  "contract role", "contract opportunity", "contract position",
  "contract-to-hire", "contract to hire",
  "freelance", "freelancer",
  "c2c", "corp-to-corp", "corp to corp", "1099",
  "project-based", "project basis", "fixed-term",
  "short-term contract", "long-term contract", "hourly contract",
];

const RESCUE_FTE_BLOCKERS: string[] = [
  "full-time role", "full time role", "full-time position", "full time position",
  "permanent role", "permanent position", "permanent hire",
  "salary range", "yearly salary", "annual salary", "base salary",
  "401k", "401(k)", "stock options", "rsu", "equity grant",
  "comp package", "compensation package", "total comp", "fte ",
];

const RESCUE_TARGET_REGION_BODY: string[] = [
  // Country / region names in body
  "united states", " usa ", " u.s. ", "us-based", "us based",
  "uk-based", "uk based", "europe-based", "europe based",
  "australia", "australian", "singapore", "singaporean",
  "uae", "united arab emirates", "saudi arabia",
  // Common natural-language phrasings ("in the US", "in Europe", etc.)
  "in the us", "in the usa", "in the u.s.", "in the uk",
  "in europe", "in the eu", "across the us", "across europe",
  "anywhere in the us", "anywhere in europe", "anywhere in the eu",
  "based in the us", "based in europe", "based in the uk",
  // Visa codes (always US-context)
  "usc/gc", "usc only", "us citizen", "green card holder",
  "visa - usc", "visa: usc", "visa type- usc",
  "h1b transfer", "h-1b", "tn visa", "opt visa",
  // Currency
  " usd", "$/hr", "$/hour", "/hr usd", "per hour usd",
  "£/hr", "eur/hr", " eur ", "€/hr",
  // Timezones
  " est ", " pst ", " cst ", " mst ", " edt ", " pdt ",
  "eastern time", "pacific time", "central time", "mountain time",
  "us shift", "us hours", "us-hours",
  // Remote-with-region (loose phrasings)
  "remote us", "remote (us", "remote in us", "remote (usa",
  "remote uk", "remote (uk", "remote eu", "remote (eu",
  "remote in the us", "remote in the usa", "remote in the uk",
  "remote in europe", "remote in the eu",
  "fully remote in the us", "fully remote in europe", "fully remote in the uk",
  "fully remote in the eu",
];

const RESCUE_INDIA_ROLE_MARKERS: string[] = [
  // Currency / comp
  "inr ", " inr,", " inr.", "lakh", "lakhs", "lpa", " ctc ", "ctc:",
  "₹", "rupees", "rs.", " rs ",
  // Working hours
  "ist hours", "ist time", "ist shift", "ist working", "ist timezone",
  "indian standard time", "9am ist", "10am ist", "5pm ist",
  // Indian-recruiter language
  "kindly revert", "kindly do", "do the needful", " pfa ", "pfa.",
  "as per discussion", "interested candidates may", "interested candidates can",
  "share your cv at", "share your resume at", "drop your cv",
  "share updated cv", "share updated resume",
  "looking for immediate joiners", "immediate joiner",
  "notice period", "serving notice", "preferred notice",
  // Indian outsourcing / job-board firms
  " tcs ", " infosys ", " wipro ", " hcl ", " cognizant ",
  "tech mahindra", "capgemini india", "ltimindtree",
  "naukri", "naukri.com", "indeed.co.in",
  // Explicit India-only role tags
  "remote within india", "within india", "remote - india",
  "indian candidates", "candidates from india",
];

function isContractRoleInTargetRegion(content: string): boolean {
  const lower = content.toLowerCase();
  const hasContract = RESCUE_CONTRACT_SIGNALS.some((s) => lower.includes(s));
  if (!hasContract) return false;
  const hasFte = RESCUE_FTE_BLOCKERS.some((s) => lower.includes(s));
  if (hasFte) return false;
  const hasTarget = RESCUE_TARGET_REGION_BODY.some((s) => lower.includes(s));
  if (!hasTarget) return false;
  const hasIndiaRole = RESCUE_INDIA_ROLE_MARKERS.some((s) => lower.includes(s));
  if (hasIndiaRole) return false;
  return true;
}

// 2026-05-26: Two additional rescue paths per PK direction:
//
//   Indian recruiters posting REMOTE-ABROAD roles (FT or contract) → valid.
//   Contract roles ANYWHERE including India → valid (Par1k can do contract
//   work for Indian clients too; only FT-in-India is blocked).
//
// These complement isContractRoleInTargetRegion above (which is the strict
// "US/UK/EU contract" gate) so the filter no longer drops 200+ posts/run
// from Indian-recruiter accounts that are surfacing legit remote roles.

const REMOTE_SIGNALS: string[] = [
  "remote", "fully remote", "remote-first", "remote first",
  "work from anywhere", "work-from-anywhere", "wfh",
  "100% remote", "fully-remote",
];

function isRemoteAbroadRole(content: string): boolean {
  const lower = content.toLowerCase();
  const hasRemote = REMOTE_SIGNALS.some((s) => lower.includes(s));
  if (!hasRemote) return false;
  const hasTarget = RESCUE_TARGET_REGION_BODY.some((s) => lower.includes(s));
  if (!hasTarget) return false;
  // Block when the role is explicitly India-only — even with "remote" +
  // "USD" mentions, "remote within india" / "remote - india" means the
  // role is locked to India.
  if (
    lower.includes("remote within india") ||
    lower.includes("remote - india") ||
    lower.includes("remote in india")
  ) {
    return false;
  }
  return true;
}

function isContractRoleAnywhere(content: string): boolean {
  const lower = content.toLowerCase();
  const hasContract = RESCUE_CONTRACT_SIGNALS.some((s) => lower.includes(s));
  if (!hasContract) return false;
  const hasFte = RESCUE_FTE_BLOCKERS.some((s) => lower.includes(s));
  if (hasFte) return false;
  return true;
}

export function checkLocation(
  headline: string,
  postContent: string,
  authorName: string = "",
): { pass: boolean; reason: string } {
  const headlineLower = headline.toLowerCase();
  const contentLower = postContent.toLowerCase();
  const authorNameLower = authorName.toLowerCase();

  // Reject non-English posts. Script coverage:
  //   Arabic (0600-06FF)         Hebrew (0590-05FF)
  //   Devanagari/Hindi (0900-097F)  Bengali (0980-09FF)
  //   Punjabi/Gurmukhi (0A00-0A7F)  Gujarati (0A80-0AFF)
  //   Tamil (0B80-0BFF)            Telugu (0C00-0C7F)
  //   Kannada (0C80-0CFF)          Malayalam (0D00-0D7F)
  //   Sinhala (0D80-0DFF)          Thai (0E00-0E7F)
  //   CJK Unified (4E00-9FFF)      Hiragana/Katakana (3040-30FF)
  //   Hangul (AC00-D7AF)           Greek (0370-03FF)
  //   Cyrillic (0400-04FF)
  // 2026-05-19 expanded after a Bengali competitor post + Hebrew job
  // post + German+Spanish foreign-Latin posts scored highly.
  const nonLatinCount = (
    postContent.match(
      /[\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0D80-\u0DFF\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0370-\u03FF\u0400-\u04FF]/g,
    ) || []
  ).length;
  if (nonLatinCount > 10) {
    return { pass: false, reason: "non-english-content" };
  }

  // Reject Latin-script foreign languages (German, Spanish, French,
  // Italian, Portuguese, Dutch). Added 2026-05-19 after a German
  // OneLog founder post scored 35/40 \u2014 the non-Latin check above
  // only catches Arabic/CJK/Hindi/Thai, not Latin-alphabet languages.
  //
  // Strategy: count occurrences of dead-give-away foreign stopwords vs
  // common English stopwords in a normalised word list. If foreign
  // wins decisively (>=4 hits AND >= 2\u00D7 English hits), reject.
  // Conservative on purpose \u2014 code-mixed English posts (e.g. "RFP /
  // Proposal" + emoji + tech terms) must pass through.
  const FOREIGN_STOPWORDS: Record<string, string[]> = {
    de: ["der", "die", "das", "und", "ist", "wir", "ein", "eine", "nicht", "auch", "mit", "f\u00FCr", "von", "auf", "sind", "haben", "werden", "wenn", "aber", "wie"],
    es: ["que", "los", "las", "una", "como", "para", "con", "por", "m\u00E1s", "esto", "esta", "pero", "est\u00E1", "son", "todo", "muy", "sus", "porque", "donde", "tambi\u00E9n"],
    fr: ["que", "les", "des", "une", "pour", "avec", "dans", "sur", "est", "sont", "nous", "vous", "leur", "cette", "comme", "aussi", "m\u00EAme", "alors", "mais", "tout"],
    it: ["che", "non", "una", "uno", "per", "con", "sono", "questo", "questa", "loro", "anche", "molto", "quando", "essere", "fare", "dire", "come", "dove", "perch\u00E9", "stato"],
    pt: ["que", "n\u00E3o", "uma", "para", "com", "como", "isso", "isto", "essa", "este", "s\u00E3o", "est\u00E3o", "tudo", "porque", "mais", "muito", "tamb\u00E9m", "quando", "onde", "mas"],
    nl: ["het", "een", "van", "voor", "met", "dat", "die", "deze", "wij", "ook", "maar", "naar", "door", "over", "tot", "toch", "weer", "kunnen", "moeten", "willen"],
  };
  const ENGLISH_STOPWORDS = [
    "the", "and", "for", "with", "that", "this", "from", "have", "are", "was",
    "will", "would", "should", "could", "what", "when", "where", "who", "we", "our",
    "their", "they", "you", "your", "us", "into", "about", "over", "between", "more",
    "ai", "agent", "agents", "model", "models", "data", "api", "engineer", "build", "build",
  ];

  // Tokenise to words: lowercase, strip punctuation, only alpha.
  const words = postContent
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 15);
  const wordSet = words; // duplicates retained \u2014 frequency matters
  if (wordSet.length >= 25) {
    const englishHits = wordSet.filter((w) => ENGLISH_STOPWORDS.includes(w)).length;
    let foreignHits = 0;
    let foreignLang = "";
    for (const [lang, sw] of Object.entries(FOREIGN_STOPWORDS)) {
      const hits = wordSet.filter((w) => sw.includes(w)).length;
      if (hits > foreignHits) {
        foreignHits = hits;
        foreignLang = lang;
      }
    }
    if (foreignHits >= 4 && foreignHits >= englishHits * 2) {
      return { pass: false, reason: `non-english-latin-${foreignLang}` };
    }
  }

  // 2026-04-29 round 3 — CONTRACT RESCUE PATH (see helper above for full
  // criteria). Lifts the geo gate when the post is clearly a contract role
  // in a target region, regardless of recruiter geo.
  if (isContractRoleInTargetRegion(postContent)) {
    return { pass: true, reason: "contract-rescue" };
  }

  // 2026-05-26 — REMOTE-ABROAD RESCUE: Indian recruiters posting remote
  // roles (FT or contract) for clients in US/UK/EU/etc. are valid leads.
  // Previously these were dropped at "headlineExcluded" / "india-content-
  // signal" when the recruiter's headline or post body had Indian markers.
  if (isRemoteAbroadRole(postContent)) {
    return { pass: true, reason: "remote-abroad-rescue" };
  }

  // 2026-05-26 — CONTRACT-ANYWHERE RESCUE: contract / freelance / 1099 /
  // c2c roles bypass geo even when located in India. Par1k can do contract
  // work for Indian clients too; only FT-in-India is filtered out (handled
  // below by the FTE-blocker-aware INDIA_CONTENT_HARD check, which still
  // catches "in india" + salary/permanent signals).
  if (isContractRoleAnywhere(postContent)) {
    return { pass: true, reason: "contract-anywhere-rescue" };
  }

  // 2026-04-29: check the author NAME for excluded regions, not just the
  // headline. Catches LinkedIn company pages whose headline is "X,XXX
  // followers" but whose name is "Uttar Pradesh Jobs" / "Chennai Jobs"
  // / "Madhya Pradesh Jobs" — pure India-region job aggregators that
  // the headline-only check missed.
  if (authorNameLower) {
    const nameExcluded = EXCLUDED_REGIONS.some((r) => authorNameLower.includes(r));
    if (nameExcluded) return { pass: false, reason: "excluded-region-author-name" };
  }

  // Check headline for excluded regions
  const headlineExcluded = EXCLUDED_REGIONS.some((r) => headlineLower.includes(r));
  if (headlineExcluded) return { pass: false, reason: "excluded-region-headline" };

  // Check headline for spam recruiter patterns (no target region = reject)
  const isSpamRecruiter = SPAM_HEADLINE_SIGNALS.some((s) => headlineLower.includes(s));
  const hasTargetRegion = TARGET_REGIONS.some((r) => headlineLower.includes(r));
  if (isSpamRecruiter && !hasTargetRegion) return { pass: false, reason: "spam-recruiter" };

  // 2026-05-27 — RELAXED: PK direction "let Gemini judge, the filter is
  // dropping leads we'd actually want". Previously this block rejected
  // ~120 posts/day with India-region markers. Now we only hard-reject
  // the unambiguous FT-in-India combination (INR pay + permanent terms);
  // everything else passes to Gemini scorer.
  //
  // Hard reject only when ALL THREE are true:
  //   (a) explicit INR/lakh/LPA/rupees pay signal AND
  //   (b) permanent/FT/salaried role signal AND
  //   (c) no remote-abroad anchor in body
  // This catches "Permanent role in Bangalore, INR 15 LPA" while letting
  // "Remote AI engineer, $80/hr (India-based recruiter)" through.
  const FT_INDIA_PAY = ["inr ", " inr,", " inr.", "₹", "lakh", "lakhs", "lpa", "ctc:", "rupees"];
  const FT_INDIA_PERMANENT = [
    "full-time role", "full time role", "full-time position", "full time position",
    "permanent role", "permanent position", "permanent hire",
    "annual salary", "yearly salary", "fixed pay", "in-office",
  ];
  const hasIndiaPay = FT_INDIA_PAY.some((s) => contentLower.includes(s));
  const hasFtTerms = FT_INDIA_PERMANENT.some((s) => contentLower.includes(s));
  const hasRemoteAbroadAnchor =
    REMOTE_SIGNALS.some((s) => contentLower.includes(s)) &&
    RESCUE_TARGET_REGION_BODY.some((s) => contentLower.includes(s));
  if (hasIndiaPay && hasFtTerms && !hasRemoteAbroadAnchor) {
    return { pass: false, reason: "ft-india-only" };
  }

  // (SPAM_BODY_SIGNALS check removed 2026-05-12 — LLM scorer handles
  // C2C/visa/bench/affiliate noise. See the SPAM_BODY_SIGNALS comment
  // block above for full reasoning.)

  // Check post content for explicit excluded location phrases. When the
  // post ALSO has a strong target-region anchor in body (e.g. "remote in
  // the US"), allow it through — the excluded-region mention is likely
  // team-context ("our team is in NYC and Bangalore"), not a role
  // location. Without this override the check fights the india-content
  // soft-single rule above and re-rejects the same false-positives.
  const locationPhrases = EXCLUDED_REGIONS.flatMap((r) => [
    `in ${r}`, `based in ${r}`, `from ${r}`, `located in ${r}`,
    `${r} based`, `${r} only`, `${r}-based`,
  ]);
  const contentExcluded = locationPhrases.some((p) => contentLower.includes(p));
  if (contentExcluded) {
    const hasTargetAnchor = RESCUE_TARGET_REGION_BODY.some((s) =>
      contentLower.includes(s),
    );
    if (!hasTargetAnchor) {
      return { pass: false, reason: "excluded-region-content" };
    }
    // Has target anchor — let it through.
  }

  // Check headline for target regions
  if (hasTargetRegion) return { pass: true, reason: "target-region" };

  // No location clue, let it through
  return { pass: true, reason: "unknown" };
}

// ── Intent Filter ──

const PROMO_SIGNALS = [
  "i'm excited to announce", "i'm thrilled to share", "we just launched",
  "check out our", "try our new", "introducing our", "our platform",
  "our tool", "our product", "sign up for", "join our webinar",
  "register for", "download our", "use code", "% off", "free trial",
  "link in comments", "link in bio", "i wrote about", "my latest article",
  "new blog post", "just published", "here's how i", "here are 5",
  "here are 10", "top 10", "thread:", "a thread on",
];

// Strong signals that THIS POSTER is an AI service provider / consultant OFFERING their services.
// These are not leads, they're competitors or self-promoters.
const OFFERING_SIGNALS = [
  "i help startups", "i help companies", "i help businesses",
  "i help founders", "i help teams", "i help ceos",
  "i'm an ai consultant", "i am an ai consultant",
  "i'm a freelance ai", "i am a freelance ai",
  "ai consultant offering", "ai engineer offering",
  "my services include", "services i offer", "what i offer",
  "book a call with me", "work with me", "hire me",
  "i'm available for", "i am available for",
  "i built this", "i made this", "just built",
  "i deliver", "years of experience helping",
  "i help you", "let me help you", "i can help you",
  "dm me to work", "dm me to hire", "reach out to work with me",
  "referral partners", "partnership opportunity", "find clients for",
  // 2026-04-29 round 2 — self-promoting consultants surfacing in pass group
  "ai transformation partner", "transformation partner",
  "i help businesses implement", "implementing ai",
  "i've helped", "i have helped", "we've helped",
  "introducing **", "introducing our", "introducing the",
  "build smarter", "launch faster", "scale instantly",
];

const SEEKING_SIGNALS = [
  "looking for", "hiring", "need help", "need someone", "who can build",
  "who knows", "recommend", "anyone know", "does anyone", "can someone",
  "seeking", "we need", "i need", "our team needs", "want to hire",
  "searching for", "open to", "dm me if", "reach out if",
  "let me know if", "budget", "contract", "freelance", "consultant",
];

// Full-time permanent role signals — reject these early.
// We are CONTRACT/FREELANCE only. Anything that smells like W2/FTE
// gets rejected up front so we don't burn Gemini score calls on it.
const FULLTIME_SIGNALS = [
  // Explicit role-type wording
  "full-time role", "full time role", "full-time position", "full time position",
  "full-time opportunity", "full time opportunity", "full-time hire", "full time hire",
  "permanent role", "permanent position", "permanent hire", "perm hire",
  "direct hire", "direct-hire", "full-time employee", "fte role", "fte position",
  "w2 role", "w2 only", "w2 position", "w-2 only", "w-2 role",
  // Compensation phrasing — annualized salary + benefits package = FTE
  "salary range", "yearly salary", "annual salary", "base salary",
  "comp package", "compensation package", "total comp",
  "401k", "401(k)", "health insurance", "medical, dental",
  "medical/dental", "health benefits", "stock options",
  "equity grant", "rsu grant", "rsu package", "vested over",
  "pto policy", "pto + ", "unlimited pto", "vacation days",
  "paid time off", "paid vacation",
  // Benefits-style hire pitch
  "great benefits", "competitive benefits", "comprehensive benefits",
];

// Hybrid role signals — HARD reject, no escape via "fully remote".
// Anything tagged hybrid is off-the-table per direction; we don't
// even consider these regardless of how the rest of the post reads.
// (We deliberately match on `hybrid <noun>` job-description phrasing
// rather than the bare word "hybrid", so a post that says
// "no hybrid here, fully remote" is not falsely killed.)
const HYBRID_SIGNALS = [
  "hybrid role", "hybrid position", "hybrid work", "hybrid model",
  "hybrid setup", "hybrid arrangement", "hybrid schedule",
  "hybrid based", "hybrid-based",
];

// On-site role signals — reject UNLESS the post also has a strong
// remote signal (e.g. "we're an onsite-first shop but this role is
// fully remote"). Bare "onsite" remains overridable; explicit hybrid
// wording is not.
const ONSITE_SIGNALS = [
  "in-office",
  "onsite role", "on-site role", "on site role", "on-site position", "onsite position",
  "must be local", "must be based in", "in-person",
  "3 days a week in office", "2 days in office", "office presence",
  "onsite", "on-site", "on site",
];

// Regex: "📍 Location: City, ST" or "Location: City" without "remote" — signals on-site
const LOCATION_PIN_REGEX = /(?:📍|location\s*:)\s*[A-Z][a-z]+(?:\s*,\s*[A-Z]{2})?/i;

export function quickIntentFilter(content: string, headline: string = ""): { pass: boolean; reason: string } {
  const lower = content.toLowerCase();
  const headlineLower = headline.toLowerCase();

  // Hard reject: poster is offering their services (competitor / self-promo)
  const hasOffering = OFFERING_SIGNALS.some((s) => lower.includes(s));
  if (hasOffering) return { pass: false, reason: "offering-services" };

  // Hard reject: full-time permanent role (Par1k is freelance only)
  const hasFulltime = FULLTIME_SIGNALS.some((s) => lower.includes(s));
  if (hasFulltime) return { pass: false, reason: "full-time-role" };

  // Hard reject: traditional ML/data science roles (we want GenAI/agents, not deep tech ML)
  const mlOnlySignals = [
    "machine learning engineer", "ml engineer", "data scientist",
    "deep learning engineer", "computer vision engineer", "nlp engineer",
    "mlops engineer", "ml ops engineer", "data engineer",
    "tensorflow", "pytorch", "scikit-learn", "model training",
    "feature engineering", "statistical modeling", "predictive modeling",
  ];
  const genaiSignals = [
    "genai", "gen ai", "generative ai", "ai agent", "agentic",
    "rag", "retrieval", "llm", "large language", "chatbot",
    "prompt engineer", "ai architect", "ai consultant",
    "ai automation", "ai developer", "ai application",
    "openai", "claude", "gemini", "langchain", "langgraph",
  ];
  const isMLOnly = mlOnlySignals.some((s) => lower.includes(s));
  const hasGenAI = genaiSignals.some((s) => lower.includes(s));
  if (isMLOnly && !hasGenAI) return { pass: false, reason: "ml-only-not-genai" };

  // Hybrid + onsite: reject UNLESS the post mentions "remote" anywhere.
  //
  // 2026-05-12: matches lead-magnet's permissive logic. Previously
  // (04-29 round 2) hybrid was a hard reject with no override and
  // onsite required explicit "fully remote"/"100% remote"/etc. — that
  // gate produced too many false-rejects on real contract posts that
  // said "remote-friendly" or "remote-optional". The LLM scorer (gated
  // at ≥20) penalises actual hybrid/onsite intent regardless.
  const hasHybrid = HYBRID_SIGNALS.some((s) => lower.includes(s));
  const hasOnsite = ONSITE_SIGNALS.some((s) => lower.includes(s));
  const hasRemote = lower.includes("remote");
  if ((hasHybrid || hasOnsite) && !hasRemote) {
    return { pass: false, reason: hasHybrid ? "hybrid-role" : "onsite-role" };
  }

  // Hard reject: explicit physical location pinned (📍 Location: City, ST)
  // without "remote" anywhere in body.
  if (LOCATION_PIN_REGEX.test(content) && !hasRemote) {
    return { pass: false, reason: "location-pinned-no-remote" };
  }

  // Hard reject: AI service provider headlines (competitors, not clients)
  const competitorHeadlines = [
    "ai consultant at", "ai consultant |", "freelance ai consultant",
    "freelance ai engineer", "freelance ai developer",
    "i help startups", "i help companies", "i help founders",
    "i help businesses", "helping companies with ai",
    "helping startups with ai", "helping founders", "helping teams",
    "ai agency", "ai studio", "ai automation agency",
    "ai consultant & engineer", "ai consultant and engineer",
    // Generic consultant headlines with AI integration/workflow services
    "ai integration |", "ai integration expert", "workflow & ai integration",
    "ai strategy consultant", "ai implementation consultant",
    "ai transformation consultant", "ai automation consultant",
    "ai advisor |", "ai expert |",
    // 2026-04-29 round 2
    "ai transformation partner", "transformation partner @",
    "transformation partner",
  ];
  const isCompetitor = competitorHeadlines.some((h) => headlineLower.includes(h));
  if (isCompetitor) return { pass: false, reason: "competitor-headline" };

  // Hard reject: promoting own newsletter/article (thought leadership, not hiring)
  const newsletterPromo = [
    "read it here", "read the full article", "subscribe to my newsletter",
    "link to the full post", "check out my latest", "my latest article",
    "my latest newsletter", "this week's newsletter", "my substack",
    "link in bio", "read more below",
  ];
  if (newsletterPromo.some((p) => lower.includes(p))) {
    return { pass: false, reason: "newsletter-promo" };
  }

  // Contract intent is enforced by the query layer (search-queries.json
  // pins "contract"/"freelance"/"remote" into every active query). The
  // filter no longer hard-rejects hiring-shaped posts that omit the
  // word "contract" — that responsibility belongs to the queries, and
  // the LLM scorer is the final arbiter of whether a post is a real
  // engagement.
  const CONTRACT_SIGNALS = [
    "contract", "contractor", "freelance", "freelancer",
    "consultant", "consulting engagement", "consultancy",
    "1099", "c2c", "corp-to-corp", "corp to corp",
    "project-based", "project basis", "fixed-term",
    "short-term contract", "long-term contract",
    "contract-to-hire", "contract to hire",
  ];
  const hasContract = CONTRACT_SIGNALS.some((s) => lower.includes(s));

  // Pass: explicit contract/freelance signal present.
  if (hasContract) return { pass: true, reason: "contract-signal" };

  // Pass: seeking signals present (fallback — discovery / referral asks etc.)
  const hasSeeking = SEEKING_SIGNALS.some((s) => lower.includes(s));
  if (hasSeeking) return { pass: true, reason: "seeking-signal" };

  // Reject: promo content
  const hasPromo = PROMO_SIGNALS.some((s) => lower.includes(s));
  if (hasPromo) return { pass: false, reason: "promo-content" };

  // Default policy: PASS to scoring. Queries already enforce contract /
  // remote intent at the search layer, and the geo + spam-body + hybrid +
  // onsite + offering rejects above have stripped the obvious noise. The
  // LLM scorer is the final filter — letting borderline posts through
  // recovers leads where the language is unconventional but the intent
  // is real (founders writing in their own voice, multi-paragraph posts
  // where contract terms appear later in the body, etc.).
  return { pass: true, reason: "no-explicit-intent" };
}

// ── Date Filter ──

export function isRecentPost(postedAt: Record<string, unknown> | undefined, maxAgeHours: number): boolean {
  if (!postedAt) return false;

  // harvestapi returns ISO date "2026-04-10T09:28:59.078Z"
  // apimaestro returns "2026-04-09 09:02:23" (space-separated, no tz)
  const dateStr = postedAt.date as string | undefined;
  if (dateStr) {
    try {
      // Try ISO first (harvestapi), fall back to space-separated (apimaestro)
      let postDate = new Date(dateStr);
      if (isNaN(postDate.getTime())) {
        postDate = new Date(dateStr.replace(" ", "T") + "Z");
      }
      const ageMs = Date.now() - postDate.getTime();
      return ageMs / (1000 * 60 * 60) <= maxAgeHours;
    } catch {}
  }

  // Fallback: check display_text (apimaestro) or postedAgoShort (harvestapi) like "4h", "2d", "1w"
  const display = (postedAt.display_text ?? postedAt.postedAgoShort) as string | undefined;
  const maxDays = maxAgeHours / 24;
  if (display) {
    if (display.includes("mo")) return false; // months old = too old
    if (display.includes("w")) {
      // "1w" = 7 days, "2w" = 14 days — only accept if within maxDays
      const weeks = parseInt(display) || 1;
      return weeks * 7 <= maxDays;
    }
    if (display.includes("d")) {
      const days = parseInt(display) || 1;
      return days <= maxDays;
    }
    if (display.includes("h")) {
      const hours = parseInt(display);
      return !isNaN(hours) && hours <= maxAgeHours;
    }
    if (display.includes("m") && !display.includes("mo")) return true; // minutes
  }

  return false;
}

// ── Normalize Apify Response ──
// Handles both harvestapi/linkedin-post-search and apimaestro formats.

import { fetchArticleBody, extractArticleLink, looksTruncated, mergeTeaserAndArticle } from "./article-fetch";

export function normalizeApifyResult(raw: Record<string, unknown>, query: string): ScrapedPost | null {
  // harvestapi uses `content` + `linkedinUrl`; apimaestro uses `text` + `post_url`
  const text = (raw.content ?? raw.text ?? "") as string;
  const postUrl = (raw.linkedinUrl ?? raw.post_url ?? "") as string;

  if (!text || !postUrl) return null;

  // LinkedIn's stable post ID. harvestapi exposes it as raw.id; apimaestro
  // doesn't (we'll get null). Used as a secondary dedup key on top of URL.
  const linkedinPostId =
    typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;

  const author = (raw.author ?? {}) as Record<string, unknown>;
  const authorName = (author.name ?? "") as string;
  // harvestapi: author.info | apimaestro: author.headline
  const authorHeadline = (author.info ?? author.headline ?? "") as string;
  // harvestapi: author.linkedinUrl | apimaestro: author.profile_url
  const authorUrl = (author.linkedinUrl ?? author.profile_url ?? "") as string;

  // Engagement breakdown.
  // harvestapi: raw.engagement = { likes, comments, shares, reactions:{...}}
  // apimaestro: raw.stats = { total_reactions, comments, ... }
  const engagement = (raw.engagement ?? {}) as Record<string, unknown>;
  const stats = (raw.stats ?? {}) as Record<string, unknown>;

  const likes =
    (engagement.likes as number | undefined) ??
    (stats.total_reactions as number | undefined) ??
    null;
  const comments =
    (engagement.comments as number | undefined) ??
    (stats.comments as number | undefined) ??
    null;
  const shares =
    (engagement.shares as number | undefined) ??
    (stats.shares as number | undefined) ??
    null;

  const totalEngagement =
    (likes ?? 0) + (comments ?? 0) + (shares ?? 0);

  // Date: harvestapi uses raw.postedAt.date (ISO) | apimaestro uses raw.posted_at.date (string)
  const postedAt = (raw.postedAt ?? raw.posted_at) as Record<string, unknown> | undefined;
  const dateStr = postedAt?.date ? String(postedAt.date) : new Date().toISOString();

  return {
    id: postId(postUrl, text),
    url: postUrl,
    linkedinPostId,
    authorName,
    authorHeadline,
    authorUrl,
    content: text.slice(0, 5000),
    engagementCount: totalEngagement,
    engagementLikes: likes,
    engagementComments: comments,
    engagementShares: shares,
    scrapedAt: dateStr,
    queryUsed: query,
    detectedEmail: detectEmail(text),
  };
}

// ── Main Scraper ──

export async function runScraper(config: AppConfig, store: Store): Promise<void> {
  const queries = loadSearchQueries();
  const client = new ApifyClient({ token: config.apifyToken });

  const maxQueries = parseInt(process.env.MAX_QUERIES || "999", 10);
  const maxResults = parseInt(process.env.MAX_RESULTS || "15", 10);
  const activeQueries = queries.slice(0, maxQueries);

  // Reweight per-query budget by historical Approval% (high-score / fetched
  // over the last 30 days). Total keyword budget is preserved; allocation
  // shifts toward queries that have surfaced buyers in the past. 30% of the
  // budget is split evenly (floor for new/cold queries); 70% is distributed
  // by approvalPct so a 5%-yield query gets ~5× the allocation of a 1%-yield
  // query at the same configured size. Profile-watch queries are exempt —
  // their maxResults is the rotation slice size, not a fetch budget.
  // Disable via REWEIGHT=0.
  if (process.env.REWEIGHT !== "0") {
    try {
      const stats = await store.getQueryApprovalStats(30);
      const statsByQuery = new Map(stats.map((s) => [s.query, s]));
      const keywordQueries = activeQueries.filter(
        (q) => q.mode !== "profile-watch",
      );
      const keywordBudget = keywordQueries.reduce(
        (s, q) => s + (q.maxResults ?? maxResults),
        0,
      );
      const baseShare = 0.3;
      const bonusShare = 0.7;
      const baseBudgetPerQuery =
        (keywordBudget * baseShare) / Math.max(1, keywordQueries.length);
      // Effective approvalPct: use the historical signal only when we have
      // at least one scored post for that query. Otherwise fall back to the
      // neutral default (0.05). This keeps a temporary scoring outage from
      // flagging new queries as "0% approval".
      const effectiveApr = (q: { query: string }): number => {
        const s = statsByQuery.get(q.query);
        return s && s.scored > 0 ? s.approvalPct : 0.05;
      };
      const totalApproval = keywordQueries.reduce(
        (s, q) => s + effectiveApr(q),
        0,
      );
      for (const q of keywordQueries) {
        const apr = effectiveApr(q);
        const bonusBudget =
          (keywordBudget * bonusShare * apr) / Math.max(0.001, totalApproval);
        q.maxResults = Math.max(2, Math.round(baseBudgetPerQuery + bonusBudget));
      }
      console.log("[reweight] Per-query maxResults after Approval%-weighting:");
      for (const q of activeQueries) {
        const s = statsByQuery.get(q.query);
        const pct =
          s && s.scored > 0 ? (s.approvalPct * 100).toFixed(1) : "  - ";
        const tag = q.mode === "profile-watch" ? " [profile-watch, fixed]" : "";
        console.log(
          `  ${String(q.maxResults ?? maxResults).padStart(3)}  ${pct.padStart(5)}%  ${q.query.slice(0, 60)}${tag}`,
        );
      }
    } catch (err) {
      console.warn(
        `[reweight] Failed to compute approval stats, falling back to configured maxResults: ${(err as Error).message}`,
      );
    }
  }

  // Daily hard cap on fetched items (Apify bills per fetched item).
  const cap = config.dailyScrapeCap;
  const todayAlready = await store.getTodayScrapeFetched();
  const remainingBudget = Math.max(0, cap - todayAlready);
  console.log(`Daily cap: ${cap} | fetched today so far: ${todayAlready} | remaining budget: ${remainingBudget}`);

  if (remainingBudget === 0) {
    console.log(`Daily scrape cap reached (${todayAlready}/${cap}). Skipping run.`);
    return;
  }

  // Unified rolling-24h $ cap guard (see src/lib/budget-guard.ts). Backstops
  // the item-count cap above against per-post price drift; mirrors the guard
  // in reddit-intent and x-intent.
  const budget = await getBudgetStatus();
  if (budget.blocked) {
    console.log(
      `[cap] 24h $ cap hit (spent=$${budget.spentToday.toFixed(4)} cap=$${budget.cap}); skipping run.`,
    );
    await recordEvent({
      eventType: "scrape.run.skipped",
      workflow: "linkedin_jobs",
      actor: "linkedin-jobs.scraper",
      payload: {
        reason: "cost_cap_hit",
        spentToday: budget.spentToday,
        cap: budget.cap,
      },
    });
    return;
  }

  const runId = await store.startScrapeRun();
  let fetchedThisRun = 0;
  let actorRuns = 0;
  let capped = false;

  await recordEvent({
    eventType: "scrape.run.started",
    workflow: "linkedin_jobs",
    actor: "linkedin-jobs.scraper",
    payload: {
      runId,
      activeQueries: activeQueries.length,
      totalQueries: queries.length,
      remainingBudget,
      apifyActor: config.apifyActorId,
    },
  });

  console.log(`Scraping ${activeQueries.length}/${queries.length} queries via ${config.apifyActorId} (last 2 days)...\n`);

  let totalNew = 0;
  let totalSkipped = 0;
  let totalFiltered = 0;
  let totalOld = 0;
  let totalGeo = 0;

  // Track content fingerprints within this scrape to catch same post via different URLs
  const seenFingerprints = new Set<string>();

  // 2 days window (48 hours)
  const dateCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  for (const q of activeQueries) {
    if (fetchedThisRun >= remainingBudget) {
      console.log(`[cap] Hit daily cap of ${cap} fetched items — stopping before next query.`);
      capped = true;
      break;
    }
    // If FORCE_RESULTS env var is set, override per-query maxResults (for A/B testing)
    const forceResults = process.env.FORCE_RESULTS ? parseInt(process.env.FORCE_RESULTS, 10) : null;
    // Clamp per-query fetch to what's left in the daily budget so we never exceed the cap.
    const perQueryLimit = forceResults ?? q.maxResults ?? maxResults;
    const budgetLeft = remainingBudget - fetchedThisRun;
    const resultLimit = Math.min(perQueryLimit, budgetLeft);
    if (resultLimit <= 0) {
      capped = true;
      break;
    }
    console.log(`[${q.group}${q.tier ? `/T${q.tier}` : ""}] ${q.query} (${resultLimit} results, budget left: ${budgetLeft})`);

    // Hard $ ceiling for THIS actor call: the headroom left under the daily
    // cap (prior rolling-24h spend + what this run has already fetched).
    // Apify aborts the run once the charge reaches this value, so even a
    // price drift or an actor that over-returns past maxPosts can't push
    // total spend past the cap. Floored at a couple cents so a
    // near-exhausted budget can still finish a tiny run.
    const spentUsdSoFar =
      budget.spentToday + fetchedThisRun * config.apifyCostPerLead;
    const maxTotalChargeUsd =
      Math.max(0.02, Math.round((budget.cap - spentUsdSoFar) * 100) / 100);

    // Per-query counters — persisted to scrape_run_queries at end of loop body
    // so the analytics leaderboard can answer "which query has best yield".
    const queryStartedAt = new Date().toISOString();
    const queryRowId = await store.startQueryRecord(runId, q, queryStartedAt);
    const queryCounts: QueryRunCounts = {
      fetched: 0,
      inserted: 0,
      rejected_date: 0,
      rejected_dedup_content: 0,
      rejected_dedup_db: 0,
      rejected_geo: 0,
      rejected_intent: 0,
      rejected_normalize: 0,
      geo_reasons: {},
      intent_reasons: {},
      error: null,
    };

    try {
      let items: unknown[];
      if (q.mode === "profile-watch") {
        // Profile-watch bucket — pull rotating product-founder URLs and
        // call the profile-posts actor. Per-profile posts cap is `maxPosts`;
        // empirically the actor returns ~2-4 items per profile, plus a few
        // reposts/comments by associated authors.
        const profileUrls = await store.getFreshFoundersForWatch(resultLimit);
        if (profileUrls.length === 0) {
          console.log(`  [${q.group}] No founders to watch — skipping.`);
          items = [];
        } else {
          const run = await client
            .actor("harvestapi/linkedin-profile-posts")
            .call({ profileUrls, maxPosts: 2, maxTotalChargeUsd });
          ({ items } = await client.dataset(run.defaultDatasetId).listItems());
          actorRuns++;
        }
      } else {
        // harvestapi: mirrors lead-magnet's working pattern exactly —
        //   searchQueries: [<one query>]
        //   maxPosts:      <per-query budget>
        //   sortBy:        "date"
        //   postedLimit:   "week"
        // The "week" bucket is intentionally looser than a strict 48h
        // date cutoff — the local isRecentPost(postedAt, 48) check at
        // line ~945 trims anything actually >48h. This pattern is what
        // produces fresh leads consistently in lead-magnet.
        // Legacy apimaestro path kept for back-compat.
        const isHarvestApi = config.apifyActorId.startsWith("harvestapi/");
        const actorInput = isHarvestApi
          ? {
              searchQueries: [q.query],
              maxPosts: resultLimit,
              sortBy: "date",
              postedLimit: "week",
              maxTotalChargeUsd,
            }
          : {
              keyword: q.query,
              limit: resultLimit,
              sortBy: "date_posted",
              postedLimitDate: dateCutoff,
            };

        const run = await client.actor(config.apifyActorId).call(actorInput);
        ({ items } = await client.dataset(run.defaultDatasetId).listItems());
        actorRuns++;
      }
      fetchedThisRun += items.length;
      queryCounts.fetched = items.length;

      let newCount = 0;

      for (const item of items) {
        const raw = item as Record<string, unknown>;
        // harvestapi uses raw.postedAt (camelCase), apimaestro uses raw.posted_at
        const postedAt = (raw.postedAt ?? raw.posted_at) as Record<string, unknown> | undefined;

        // Safety net: date filter (48h = 2 days)
        if (!isRecentPost(postedAt, 48)) {
          queryCounts.rejected_date++;
          totalOld++;
          continue;
        }

        const post = normalizeApifyResult(raw, q.query);
        if (!post) {
          queryCounts.rejected_normalize++;
          continue;
        }

        // Article-share enrichment: when LinkedIn gives us a teaser pointing
        // to an external article, fetch the article body so Gemini scoring +
        // content gen see the actual job description, not just the share copy.
        if (looksTruncated(post.content)) {
          const link = extractArticleLink(raw);
          if (link) {
            const body = await fetchArticleBody(link);
            if (body && body.length > post.content.length) {
              post.content = mergeTeaserAndArticle(post.content, body);
            }
          }
        }

        // Content dedup: catch same post text via different URLs
        const fp = contentFingerprint(post.authorName, post.content);
        if (seenFingerprints.has(fp)) {
          queryCounts.rejected_dedup_content++;
          totalSkipped++;
          continue;
        }
        seenFingerprints.add(fp);

        const scrapedAt = post.scrapedAt ? new Date(post.scrapedAt) : new Date();

        // Classify the author once per post for CRM tags on the
        // contact_identities row (DB UI / founder-watch). These tags are
        // metadata only — they NO LONGER adjust the score. Gemini owns
        // scoring (see matcher.ts + config/scoring-prompt.md).
        const classification = classifyAuthor(
          post.authorName,
          post.authorHeadline,
          post.content,
        );

        // 2026-06: no geo/intent drop-gates here. Per direction, every
        // deduped post goes to the Gemini scorer, which judges geo,
        // remote/onsite, competitor, gig-farm and lead-type itself. The
        // checkLocation/quickIntentFilter helpers stay exported (used by
        // tests + analytics) but are not used as scrape-time filters.
        const inserted = await store.insertPost(post);
        if (inserted) {
          queryCounts.inserted++;
          newCount++;
          console.log(`  + ${post.authorName} | ${post.authorHeadline.slice(0, 40)} | "${post.content.slice(0, 60)}..."`);
        } else {
          queryCounts.rejected_dedup_db++;
          totalSkipped++;
        }

        // Always upsert + link, regardless of insert vs dedup outcome.
        // The post.id is set in both branches (see store.insertPost).
        const contactId = await store.upsertContactFromPost({
          authorName: post.authorName,
          authorHeadline: post.authorHeadline,
          authorUrl: post.authorUrl,
          scrapedAt,
          rejection: null,
          tags: classification.tags,
          primaryRole: classification.primaryRole,
        });
        if (contactId && post.id) {
          await store.linkContactToPost(contactId, post.id);
        }
      }

      totalNew += newCount;
      console.log(`  -> ${items.length} fetched, ${newCount} new\n`);
    } catch (err) {
      queryCounts.error = (err as Error).message;
      console.error(`  -> Error: ${(err as Error).message}\n`);
    }

    // Finalize per-query record (always runs, even on error — stub rows with
    // completed_at set + error text are visible to the leaderboard).
    await store.finishQueryRecord(queryRowId, queryCounts);
  }

  const estimatedCost = fetchedThisRun * config.apifyCostPerLead;
  await store.finishScrapeRun(runId, {
    leadsFetched: fetchedThisRun,
    leadsInserted: totalNew,
    actorRuns,
    estimatedCostUsd: estimatedCost,
    capped,
  });

  await recordEvent({
    eventType: "scrape.run.completed",
    workflow: "linkedin_jobs",
    actor: "linkedin-jobs.scraper",
    costUsd: estimatedCost,
    payload: {
      runId,
      leadsFetched: fetchedThisRun,
      leadsInserted: totalNew,
      actorRuns,
      capped,
      totalGeo,
      totalIntent: totalFiltered,
      totalOld,
      totalDupes: totalSkipped,
    },
  });

  console.log(
    `Done: ${totalNew} new | ${totalGeo} geo | ${totalFiltered} intent | ${totalOld} old | ${totalSkipped} dupes | ` +
      `${fetchedThisRun} fetched (est. $${estimatedCost.toFixed(3)})${capped ? " [CAPPED]" : ""}`
  );
}
