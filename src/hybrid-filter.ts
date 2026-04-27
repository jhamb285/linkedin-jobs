/**
 * Deterministic hybrid/remote detection — don't trust the AI for this.
 * Uses proximity-based detection (not rigid regex) to handle typos and flexible phrasing.
 */

const ONSITE_KEYWORDS = [
  "onsite", "oniste", "on-site", "on site",
  "in office", "in the office", "in-office",
  "in person", "in-person",
];
const REMOTE_KEYWORDS = ["remote", "wfh", "work from home"];
const HYBRID_KEYWORDS = ["hybrid"];

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

/**
 * Find all "N days" and "N-M days" mentions with context.
 * For ranges like "2-3 days", takes the MAX (err conservative).
 */
function findDayMentions(text: string): Array<{ num: number; context: string }> {
  const results: Array<{ num: number; context: string }> = [];

  // Range pattern: "2-3 days" or "2 to 3 days"
  const rangeRegex = /(\d+)\s*(?:-|to)\s*(\d+)\s*days?/g;
  let match;
  while ((match = rangeRegex.exec(text)) !== null) {
    const max = parseInt(match[2], 10);
    if (max < 1 || max > 7) continue;
    const start = Math.max(0, match.index - 40);
    const end = Math.min(text.length, match.index + match[0].length + 40);
    results.push({ num: max, context: text.slice(start, end) });
  }

  // Single number: "3 days"
  const singleRegex = /(?<![-\d])(\d+)\s*days?/g;
  while ((match = singleRegex.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num < 1 || num > 7) continue;
    // Skip if this is part of a range we already captured
    const before = text.slice(Math.max(0, match.index - 5), match.index);
    if (/\d\s*(?:-|to)\s*$/.test(before)) continue;
    const start = Math.max(0, match.index - 40);
    const end = Math.min(text.length, match.index + match[0].length + 40);
    results.push({ num, context: text.slice(start, end) });
  }

  return results;
}

export function analyzeRemoteDays(content: string): {
  remoteDays: number | null;
  reject: boolean;
  reason: string;
} {
  const lower = content.toLowerCase();

  // Hard reject: fully onsite / no remote
  if (
    /(5\s*days?\s*(?:on[\s-]?site|in\s*office)|fully\s*on[\s-]?site|on[\s-]?site\s*only|must\s*be\s*on[\s-]?site|need\s*locals?|face\s*-?\s*to\s*-?\s*face\s*interview)/.test(
      lower
    )
  ) {
    if (!hasKeyword(lower, REMOTE_KEYWORDS)) {
      return { remoteDays: 0, reject: true, reason: "Fully onsite / locals only" };
    }
  }

  // ── Day-count analysis ──
  const mentions = findDayMentions(lower);

  let bestOnsiteDays: number | null = null;
  let bestRemoteDays: number | null = null;

  for (const { num, context } of mentions) {
    const contextHasOnsite = hasKeyword(context, ONSITE_KEYWORDS);
    const contextHasRemote = hasKeyword(context, REMOTE_KEYWORDS);
    const contextHasHybrid = hasKeyword(context, HYBRID_KEYWORDS);
    const contextHasWeek = /week/.test(context);

    // "N days remote" or "remote N days"
    if (contextHasRemote && !contextHasOnsite) {
      if (bestRemoteDays === null || num > bestRemoteDays) {
        bestRemoteDays = num;
      }
    }
    // "N days onsite" / "hybrid - N days" / "hybrid N days" — if "hybrid" near N days without "remote", assume onsite
    else if (contextHasOnsite || contextHasHybrid) {
      if (bestOnsiteDays === null || num > bestOnsiteDays) {
        bestOnsiteDays = num;
      }
    }
  }

  // Decision based on detected day counts
  if (bestOnsiteDays !== null) {
    if (bestOnsiteDays >= 3) {
      return {
        remoteDays: 5 - bestOnsiteDays,
        reject: true,
        reason: `${bestOnsiteDays} days onsite (only ${Math.max(0, 5 - bestOnsiteDays)} days remote)`,
      };
    }
    return {
      remoteDays: 5 - bestOnsiteDays,
      reject: false,
      reason: `${bestOnsiteDays} days onsite (${5 - bestOnsiteDays} days remote, approved)`,
    };
  }

  if (bestRemoteDays !== null) {
    if (bestRemoteDays >= 3) {
      return {
        remoteDays: bestRemoteDays,
        reject: false,
        reason: `${bestRemoteDays} days remote`,
      };
    }
    return {
      remoteDays: bestRemoteDays,
      reject: true,
      reason: `Only ${bestRemoteDays} days remote`,
    };
  }

  // ── Good signals (mostly remote) ──

  // "Onsite 1x per week" / "1 day per week onsite" / "one day a week"
  if (/(1\s*x|once)\s*(?:per|a)\s*week\s*(?:on[\s-]?site|in\s*office)/.test(lower)) {
    return { remoteDays: 4, reject: false, reason: "1x per week onsite (4 remote)" };
  }
  if (/(?:on[\s-]?site|in\s*office).{0,15}(?:1\s*x|once)\s*(?:per|a)\s*week/.test(lower)) {
    return { remoteDays: 4, reject: false, reason: "Onsite 1x per week (4 remote)" };
  }

  // "Fully remote" / "100% remote" / "Remote only"
  if (
    /(fully|100\s*%|completely)\s*remote/.test(lower) ||
    /remote\s*only/.test(lower) ||
    /work\s*from\s*home/.test(lower)
  ) {
    return { remoteDays: 5, reject: false, reason: "Fully remote" };
  }

  // "Remote with occasional travel"
  if (
    /remote/.test(lower) &&
    /(occasional(?:ly)?|quarterly|monthly|rare)\s*(?:travel|onsite|in\s*office|visit)/.test(lower)
  ) {
    return { remoteDays: 5, reject: false, reason: "Remote with occasional travel" };
  }

  // "Hybrid" with no day count — ambiguous, let AI decide
  if (/hybrid/.test(lower)) {
    return { remoteDays: null, reject: false, reason: "Hybrid (unspecified days)" };
  }

  // ── Unclear ──
  return { remoteDays: null, reject: false, reason: "No explicit day count" };
}
