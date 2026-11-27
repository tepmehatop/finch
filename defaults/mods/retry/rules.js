// Finch auto-retry: what a stopped agent's screen says, without the host
// (tested in scripts/retry.test.ts).

const TRANSIENT = /(API Error|Request failed|overloaded|\b5\d\d\b|Internal Server Error|Service Unavailable|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|Connection (?:error|reset|refused)|network error|stream (?:error|closed)|timed? ?out)/i;
const LIMIT = /(usage limit|rate limit|limit reached|limit exceeded|quota|too many requests|\b429\b)/i;
const RESET = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/** What to do about a stopped agent whose screen ends with `text`:
 *  null (nothing), { kind: "error" } or { kind: "limit", at: ms | null }. */
export function diagnose(text, now = Date.now()) {
  const tail = String(text ?? "").split("\n").filter((l) => l.trim()).slice(-25).join("\n");
  if (LIMIT.test(tail)) return { kind: "limit", at: resetTime(tail, now) };
  if (TRANSIENT.test(tail)) return { kind: "error" };
  return null;
}

/** "resets 3pm", "resets at 15:30": the next such moment after `now`, or null. */
export function resetTime(text, now = Date.now()) {
  const m = RESET.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime() + 60 * 1000;
}
