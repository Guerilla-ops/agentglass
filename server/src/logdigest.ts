/*
 * What the server's own error log says, in three lines a person can act on.
 *
 * Pure: entries in, a digest out. The file, the rotation and the console tap
 * live in serverlog.ts; the route and the badge only render what this returns.
 *
 * WHAT IT LOOKS FOR, and why those three. A list of every error is a log
 * nobody reads. What was missed in practice was never one line, it was a shape:
 * the same crash signal four times in twelve seconds, and the same timeout ten
 * times in an hour against a week of near silence. So: recurring signatures with
 * counts, restart/crash loops, and spikes.
 *
 * ITS CEILING. A crash is seen only if the process that crashed left a line
 * where the server could log it — a child's stderr the server forwards, or the
 * server's own "started" marker three times in a minute. A process that dies
 * without a word and is never restarted leaves nothing here; that stays with the
 * coredump list.
 */

export type LogLevel = "error" | "warn" | "boot";
export type LogEntry = { at: number; level: LogLevel; text: string };

import type { LogDigest } from "../../shared/types.ts";

const HOUR = 3_600_000;
const WINDOW = 24 * HOUR;
/** Signals a process died. `exited with code 0` is a clean exit, not a crash. */
const CRASH = /SIG(?:SEGV|ABRT|BUS|ILL|TRAP|KILL)|segmentation fault|core dumped|exited with code [1-9]/i;
const LOOP_COUNT = 3;
const LOOP_SPAN = 60_000;
const SPIKE_MIN = 5;
const SPIKE_FACTOR = 3;
const GROUPS_SHOWN = 10;

/** Folds the parts of a message that change between two occurrences of the same
 *  problem — paths, hex, numbers — so a count means one problem. */
export function normalize(text: string): string {
  return text
    .split("\n")[0]
    .replace(/(?:\/[\w.@~-]+){2,}/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const EXAMPLE_MAX = 240;

/** What a person reads for a line: the first line only, emoji dropped (the UI
 *  draws its own severity marker, and a raw warning sign beside it is a second
 *  one), cut at a word rather than mid-token. */
export function displayText(text: string): string {
  const t = text.split("\n")[0]
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= EXAMPLE_MAX) return t;
  const cut = t.slice(0, EXAMPLE_MAX);
  const sp = cut.lastIndexOf(" ");
  return (sp > EXAMPLE_MAX / 2 ? cut.slice(0, sp) : cut).trimEnd();
}

/** One JSON line per entry; a line cut off by a crash mid-write is skipped. */
export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (typeof v.at === "number" && typeof v.text === "string"
        && (v.level === "error" || v.level === "warn" || v.level === "boot")) out.push(v);
    } catch { /* a torn line */ }
  }
  return out;
}

/** Sliding window over sorted times: where the first run of `n` inside `span`
 *  starts, and how many fall inside that span from there. */
function burst(times: number[], n: number, span: number): { at: number; count: number } | null {
  for (let i = 0; i + n - 1 < times.length; i++) {
    if (times[i + n - 1] - times[i] <= span) {
      let count = n;
      while (i + count < times.length && times[i + count] - times[i] <= span) count++;
      return { at: times[i], count };
    }
  }
  return null;
}

export function digest(entries: LogEntry[], now: number): LogDigest {
  const since = now - WINDOW;
  const inWindow = entries.filter((x) => x.at >= since && x.at <= now).sort((a, b) => a.at - b.at);
  const bySig = new Map<string, LogEntry[]>();
  const boots: number[] = [];
  let total = 0;
  for (const x of inWindow) {
    if (x.level === "boot") { boots.push(x.at); continue; }
    total++;
    const sig = normalize(x.text);
    const list = bySig.get(sig);
    if (list) list.push(x); else bySig.set(sig, [x]);
  }

  const groups: LogDigest["groups"] = [...bySig].map(([sig, l]) => ({
    sig, count: l.length, first: l[0].at, last: l[l.length - 1].at,
    // The sig is only the grouping key; a person reads the latest real line.
    example: displayText(l[l.length - 1].text),
    level: l.some((x) => x.level === "error") ? "error" as const : "warn" as const,
  }))
    .sort((a, b) => b.count - a.count || b.last - a.last);

  const crashLoops: LogDigest["crashLoops"] = [];
  const restarted = burst(boots, LOOP_COUNT, LOOP_SPAN);
  if (restarted) crashLoops.push({ sig: "server restarted", example: "server restarted", ...restarted });
  for (const [sig, l] of bySig) {
    if (!CRASH.test(l[0].text)) continue;
    const b = burst(l.map((x) => x.at), LOOP_COUNT, LOOP_SPAN);
    if (b) crashLoops.push({ sig, example: displayText(l[l.length - 1].text), ...b });
  }

  const spikes: LogDigest["spikes"] = [];
  const recentFrom = now - HOUR;
  for (const [sig, l] of bySig) {
    const recent = l.filter((x) => x.at >= recentFrom).length;
    if (recent < SPIKE_MIN) continue;
    const before = l.length - recent;
    // Hours of history before the burst, at least one, so a signature seen for
    // the first time compares against "nothing" rather than dividing by zero.
    const hours = Math.max(1, (recentFrom - l[0].at) / HOUR);
    const perHourBefore = before / hours;
    if (recent > SPIKE_FACTOR * perHourBefore) spikes.push({ sig, example: displayText(l[l.length - 1].text), recent, perHourBefore: Math.round(perHourBefore * 10) / 10 });
  }
  spikes.sort((a, b) => b.recent - a.recent);

  return {
    since, total,
    groups: groups.slice(0, GROUPS_SHOWN), crashLoops, spikes,
    quiet: crashLoops.length === 0 && spikes.length === 0,
  };
}
