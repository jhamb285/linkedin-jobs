/**
 * IST helpers — mirrors platform/web/lib/utils.ts so both repos compute
 * "today" boundaries the same way. India does not observe DST, so a
 * fixed +5:30 offset is correct year-round.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Returns a Date representing the start (00:00:00.000) of the current day
 * in IST, expressed as a UTC instant. Use everywhere we need a "today"
 * boundary for filtering, counters, daily caps, etc.
 */
export function istDayStart(now: Date = new Date()): Date {
  const istNowMs = now.getTime() + IST_OFFSET_MS;
  const istMidnightMs = Math.floor(istNowMs / 86_400_000) * 86_400_000;
  return new Date(istMidnightMs - IST_OFFSET_MS);
}

/** Format a Date as IST wall-clock for logs. */
export function formatIst(d: Date): string {
  return (
    d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " IST"
  );
}
