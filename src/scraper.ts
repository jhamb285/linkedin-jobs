import { ApifyClient } from "apify-client";
import type { AppConfig, ScrapedPost } from "./types";
import type { Store, QueryRunCounts } from "./store";
import { loadSearchQueries } from "./config";
import { recordEvent } from "./events";
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
  // India — states + union territories
  // (added 2026-04-29 — "X State Jobs" company pages were slipping past
  //  the city-only list)
  "andhra pradesh", "arunachal pradesh", "assam", "bihar",
  "chhattisgarh", "goa", "gujarat", "haryana", "himachal pradesh",
  "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra",
  "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "punjab",
  "rajasthan", "sikkim", "tamil nadu", "telangana", "tripura",
  "uttar pradesh", "uttarakhand", "west bengal",
  "jammu and kashmir", "ladakh", "puducherry",
  // India — country + cities
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
const INDIA_CONTENT_HARD: string[] = [
  // India — explicit statements
  "in india", "india-based", "india based", "indian market", "indian candidates",
  // India — IST timezone (only used in India-context)
  "ist hours", "ist time", "ist timezone", "ist working hours",
  "indian standard time", "ist shift", "9am ist", "10am ist", "5pm ist",
  // India — language idioms (Indian-English only)
  "do the needful", "kindly revert", "kindly do", "pfa ",
  "as per discussion", "interested candidates may", "interested candidates can",
  "share your cv at", "share your resume at", "drop your cv",
  "drop your resume", "share updated cv", "share updated resume",
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

// Recruiter spam headline signals (staffing agencies from excluded regions)
// Extended 2026-04-29 after analyze-test-c surfaced 8 polished-recruiter
// false-positives in the 64-post pass group; the original list only
// caught explicit "staffing" / "bench sales" wording.
const SPAM_HEADLINE_SIGNALS: string[] = [
  // Original
  "bench sales", "staffing", "manpower", "placement agency",
  "offshore development", "nearshore", "bodyshop",
  // Recruiter titles — common at staffing/agency outfits
  "senior recruiter", "sr recruiter", "sr. recruiter",
  "technical recruiter", "tech recruiter", "executive recruiter",
  "freelance recruiter", "contract recruiter", "us it recruiter",
  // Talent / HR titles
  "talent acquisition", "talent manager", "talent scout",
  "hr executive", "hr recruiter", "hr recruitment",
  // Recruitment-org titles
  "recruitment consultant", "recruiting at", "headhunting", "headhunter",
  "placement consultant", "resourcing specialist", "resource consultant",
  // Connector / matchmaker positioning
  "connecting talent", "connecting high",
  "bridging talent", "bridging data and",
  // Volume-recruiter "open roles" headlines
  "100+ roles", "open to connect",
  // US-staffing variants (often Indian-owned but US-fronted)
  "us staffing", "it staffing",
  // Additional recruiter / matchmaker titles surfaced 2026-04-29 round 2
  "vp recruitment", "vice president recruitment",
  "practice manager", "design & tech recruitment", "tech recruitment",
  "talent matchmaker", "matchmaker", "zzp matchmaker",
  "client manager", "new business development",
];

// Spam BODY signals — patterns inside the post text that strongly
// indicate Indian-staffing C2C / bench / visa-broker content. Added
// 2026-04-29 — these slip past the headline check because the recruiter
// uses polished US-style headlines but the BODY gives them away.
const SPAM_BODY_SIGNALS: string[] = [
  // C2C (corp-to-corp) staffing patterns
  "available for c2c", "c2c bench", "open for c2c", "c2c requirement",
  "c2c opportunity", "c2c position", "c2c role", "we have a c2c",
  "consultant for c2c", "c2c only", "looking for c2c",
  "c2h opportunity", "c2h role", "c2h contract",
  // Body-side "share your CV" patterns (Indian-staffing convention)
  "share your cv", "share updated cv", "share updated resume",
  "share resume at", "send resume to", "drop your cv", "drop your resume",
  // Visa-class patterns (US contracting via offshore staffing)
  "visa - usc", "visa: usc", "visa type- usc", "usc/gc only",
  "h1b transfer", "h-1b transfer", "h1 transfer", "available for h1",
  // Bench-staffing patterns
  "certified bench", "consulting bench", "staffing bench",
  "partner certified bench", "expert bench",
  // Job-seeker / affiliate spam patterns
  "looking for remote work opportunities", "looking for remote opportunities",
  "looking for work opportunities", "looking for my next big move",
  "looking for my next role", "looking for my next opportunity",
  "platforms that offer remote", "best platforms that offer",
  "27 platforms", "20 platforms", "10 platforms that",
  // 2026-04-29 round 3.1 — additional affiliate / aggregator spam patterns
  "stop relying only on linkedin", "stop relying on linkedin",
  "most people only search for jobs", "dozens of better pl",
  "tuesday drop", "wednesday drop", "thursday drop", "friday drop",
  "fresh jobs in engineering", "fresh jobs in design",
  " fresh jobs ", "hirehut squad",
  "looking for remote work", "looking for remote opp", "want to get paid in usd",
  "looking for remote", "remote work in 2026",
  // Explicit not-a-hiring-post tags & open-to-work signals
  "#not_a_hiring_post", "not a hiring post", "#open_to_opportunities",
  "i'm currently open to opportunities", "i am currently open to opportunities",
  "open to new opportunities", "currently open to",
  "#opentowork", "open to work", "opentowork",
  // Job-aggregator / weekly-jobs spam
  "top remote l&d jobs", "top remote jobs", "top remote",
  "weekly jobs", "weekly job round-up", "weekly remote jobs",
  "this week's remote", "your weekly job",
  // Personal-achievement / certification posts (not hiring)
  "i just passed", "i am thrilled to share that i just",
  "i'm thrilled to share that i just",
  "i just earned", "just earned the", "just received the",
  "completed the interactive course", "i'm happy to share that i've completed",
  "i'm happy to share that i just",
  // LATAM/offshore staffing recruitment-firm pitches
  "helping tech talent across latam", "tech talent across latam",
  "remote-first company helping", "we are launchpad",
  // Thought-leadership rhetorical opener patterns (no hiring intent)
  "in the llm systems i've been building",
  "over the past few months, i", "over the last few months, i",
  "i've watched dozens of", "i've watched hundreds of",
  "people…stop", "people, stop", "stop trusting ai",
  "most teams are testing", "most teams are doing",
];

// 2026-04-29 round 3 — "contract rescue" gate.
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
  // 2026-04-29 round 3.1 — also block rescue when the post trips
  // SPAM_BODY_SIGNALS (job-seeker affiliate spam, bench-staffing, "X
  // fresh jobs" aggregators). Without this guard the rescue lets through
  // the "📌 Looking for remote work in USD — 27 platforms" content-creator
  // posts because they happen to include "freelance" + "USD".
  const hasSpamBody = SPAM_BODY_SIGNALS.some((s) => lower.includes(s));
  if (hasSpamBody) return false;
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

  // Reject non-English posts (Arabic, Chinese, Hindi, Urdu, Thai, etc.)
  // We only target English-speaking markets, so non-Latin scripts are likely from excluded regions
  const nonLatinCount = (postContent.match(/[\u0600-\u06FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\u0E00-\u0E7F]/g) || []).length;
  if (nonLatinCount > 10) {
    return { pass: false, reason: "non-english-content" };
  }

  // 2026-04-29 round 3 — CONTRACT RESCUE PATH (see helper above for full
  // criteria). Lifts the geo gate when the post is clearly a contract role
  // in a target region, regardless of recruiter geo.
  if (isContractRoleInTargetRegion(postContent)) {
    return { pass: true, reason: "contract-rescue" };
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

  // Check post content for India/South Asia signals — two-tier evaluation.
  //
  // HARD tier: any single match rejects. These are unambiguous tells
  // (explicit "in India", IST timezone, Indian-English idioms, INR/LPA).
  //
  // SOFT tier: requires either (a) ≥2 matches, OR (b) zero target-region
  // anchor anywhere in the body. A single soft hit + a target-region
  // anchor (e.g. "fully remote in the US, our team is in Bangalore")
  // is allowed through — the role is in the target region, the city
  // mention is just team-context.
  const hardHit = INDIA_CONTENT_HARD.some((s) => contentLower.includes(s));
  if (hardHit) return { pass: false, reason: "india-content-signal-hard" };

  const softMatches = INDIA_CONTENT_SOFT.filter((s) => contentLower.includes(s));
  if (softMatches.length >= 2) {
    return { pass: false, reason: "india-content-signal-soft-multi" };
  }
  if (softMatches.length === 1) {
    const hasTargetAnchor = RESCUE_TARGET_REGION_BODY.some((s) =>
      contentLower.includes(s),
    );
    if (!hasTargetAnchor) {
      return { pass: false, reason: "india-content-signal-soft-single" };
    }
    // Single soft hit + target-region anchor → pass through to next check.
  }

  // 2026-04-29: spam BODY signals — Indian-staffing C2C/bench/visa
  // patterns + job-seeker affiliate spam. Runs after india-content-signal
  // so the more-specific reason surfaces here.
  const hasSpamBody = SPAM_BODY_SIGNALS.some((s) => contentLower.includes(s));
  if (hasSpamBody) return { pass: false, reason: "spam-body-signal" };

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

  // HARD reject: any hybrid wording. Per direction, we do NOT accept
  // hybrid roles even if the rest of the post screams "remote-friendly".
  // This gate runs before the onsite gate so it can't be overridden.
  const hasHybrid = HYBRID_SIGNALS.some((s) => lower.includes(s));
  if (hasHybrid) return { pass: false, reason: "hybrid-role" };

  // Hard reject: on-site role. "remote" alone isn't strong enough — many
  // posts say "remote-friendly" while still being effectively on-site.
  // Override threshold: explicit strong-remote signal must be present.
  const hasOnsite = ONSITE_SIGNALS.some((s) => lower.includes(s));
  const hasStrongRemote =
    lower.includes("fully remote") ||
    lower.includes("100% remote") ||
    lower.includes("100 percent remote") ||
    lower.includes("remote-first") ||
    lower.includes("remote first") ||
    lower.includes("remote only") ||
    lower.includes("remote-only") ||
    lower.includes("work from anywhere") ||
    lower.includes("anywhere in the world") ||
    lower.includes("anywhere in the us") ||
    lower.includes("anywhere in europe") ||
    lower.includes("anywhere in the eu");
  if (hasOnsite && !hasStrongRemote) {
    return { pass: false, reason: "onsite-role" };
  }

  // Hard reject: explicit physical location pinned (📍 Location: City, ST)
  // without a strong remote signal.
  if (LOCATION_PIN_REGEX.test(content) && !hasStrongRemote) {
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
  };
}

// ── Main Scraper ──

export async function runScraper(config: AppConfig, store: Store): Promise<void> {
  const queries = loadSearchQueries();
  const client = new ApifyClient({ token: config.apifyToken });

  const maxQueries = parseInt(process.env.MAX_QUERIES || "999", 10);
  const maxResults = parseInt(process.env.MAX_RESULTS || "15", 10);
  const activeQueries = queries.slice(0, maxQueries);

  // Daily hard cap on fetched items (Apify bills per fetched item).
  const cap = config.dailyScrapeCap;
  const todayAlready = await store.getTodayScrapeFetched();
  const remainingBudget = Math.max(0, cap - todayAlready);
  console.log(`Daily cap: ${cap} | fetched today so far: ${todayAlready} | remaining budget: ${remainingBudget}`);

  if (remainingBudget === 0) {
    console.log(`Daily scrape cap reached (${todayAlready}/${cap}). Skipping run.`);
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
      // harvestapi: searchQueries array + maxPosts + sortBy:"date" + postedLimitDate.
      // We use postedLimitDate (ISO 48h ago) instead of postedLimit:"week"
      // for a deterministic 48h window — LinkedIn's "week" bucket is
      // looser and pulls in stale posts.
      // Legacy apimaestro used keyword + limit + postedLimitDate.
      const isHarvestApi = config.apifyActorId.startsWith("harvestapi/");
      const actorInput = isHarvestApi
        ? {
            searchQueries: [q.query],
            maxPosts: resultLimit,
            sortBy: "date",
            postedLimitDate: dateCutoff,
          }
        : {
            keyword: q.query,
            limit: resultLimit,
            sortBy: "date_posted",
            postedLimitDate: dateCutoff,
          };

      const run = await client.actor(config.apifyActorId).call(actorInput);
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      actorRuns++;
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

        // Classify the author once per post — used by every upsert call site
        // below so each contact_identity row gets tagged regardless of which
        // filter outcome it lands in.
        const classification = classifyAuthor(
          post.authorName,
          post.authorHeadline,
          post.content,
        );

        // Location filter (headline + content + India signals + recruiter spam)
        const geo = checkLocation(post.authorHeadline, post.content, post.authorName);
        if (!geo.pass) {
          queryCounts.rejected_geo++;
          queryCounts.geo_reasons[geo.reason] = (queryCounts.geo_reasons[geo.reason] ?? 0) + 1;
          totalGeo++;
          // Record the contact even though the post is rejected. This is
          // the "sourcing memory" the DB UI surfaces — recruiters in
          // wrong regions, on-site-only roles, etc. that we filtered out
          // but might want to revisit if the criteria change.
          await store.upsertContactFromPost({
            authorName: post.authorName,
            authorHeadline: post.authorHeadline,
            authorUrl: post.authorUrl,
            scrapedAt,
            rejection: { stage: "geo", reason: geo.reason },
            tags: classification.tags,
            primaryRole: classification.primaryRole,
          });
          continue;
        }

        // Intent filter (content + headline checks for offering/full-time/on-site)
        const intent = quickIntentFilter(post.content, post.authorHeadline);
        if (!intent.pass) {
          queryCounts.rejected_intent++;
          queryCounts.intent_reasons[intent.reason] = (queryCounts.intent_reasons[intent.reason] ?? 0) + 1;
          totalFiltered++;
          await store.upsertContactFromPost({
            authorName: post.authorName,
            authorHeadline: post.authorHeadline,
            authorUrl: post.authorUrl,
            scrapedAt,
            rejection: { stage: "intent", reason: intent.reason },
            tags: classification.tags,
            primaryRole: classification.primaryRole,
          });
          continue;
        }

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
