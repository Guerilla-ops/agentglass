import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, normalize, displayText, parseLog, type LogEntry } from "../src/logdigest.ts";
import { formatEntry, appendEntry, readEntries, LOG_MAX } from "../src/serverlog.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const e = (agoMs: number, text: string, level: LogEntry["level"] = "error"): LogEntry =>
  ({ at: NOW - agoMs, level, text });

const scratch = mkdtempSync(join(tmpdir(), "agx-logdigest-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("normalize", () => {
  test("ids, numbers, paths and quoted names fold into one signature", () => {
    const a = normalize("[picker] could not save /home/ann/orbit/a.json: EACCES 4821");
    const b = normalize("[picker] could not save /home/bob/acme/b.json: EACCES 77");
    expect(a).toBe(b);
    expect(a).toContain("[picker] could not save");
  });
  test("different messages stay different", () => {
    expect(normalize("[understudy] learn: boom")).not.toBe(normalize("[understudy] ask: boom"));
  });
});

describe("displayText", () => {
  test("emoji and their variation selectors are stripped, spacing closed up", () => {
    expect(displayText("\u26A0\uFE0F  [net] retry in 5 minutes")).toBe("[net] retry in 5 minutes");
    expect(displayText("[loop] \u23F1 blocked 340ms by GET /a/b")).toBe("[loop] blocked 340ms by GET /a/b");
  });
  test("only the first line, cut at a word", () => {
    expect(displayText("first\nsecond")).toBe("first");
    const long = displayText("word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(240);
    expect(long.endsWith("word")).toBe(true);
  });
});

describe("group example", () => {
  test("a group shows its most recent line as written, never the grouping placeholders", () => {
    const d = digest([
      e(3 * H, "[web] listening, bound to 127.0.0.1 after 11 tries"),
      e(1 * H, "\u26A0 [web] listening, bound to 10.0.0.7 after 12 tries"),
    ], NOW);
    expect(d.groups[0].sig).toContain("<n>");
    expect(d.groups[0].example).toBe("[web] listening, bound to 10.0.0.7 after 12 tries");
    expect(d.groups[0].example).not.toContain("<n>");
  });
  test("a group carries the worst level seen and a loop or spike carries an example", () => {
    const d = digest([
      e(3 * H, "[x] boom 1", "warn"), e(2 * H, "[x] boom 2", "error"), e(1 * H, "[x] boom 3", "warn"),
    ], NOW);
    expect(d.groups[0].level).toBe("error");
    const crash = digest([e(30_000, "child exited with code 1: try 1"), e(20_000, "child exited with code 1: try 2"), e(10_000, "child exited with code 1: try 3")], NOW);
    expect(crash.crashLoops[0].example).toBe("child exited with code 1: try 3");
  });
});

describe("digest", () => {
  test("groups recurring errors with counts, most frequent first", () => {
    const d = digest([
      e(10 * H, "[understudy] ask: boom 1"), e(9 * H, "[understudy] ask: boom 2"), e(8 * H, "[understudy] ask: boom 3"),
      e(7 * H, "[picker] could not save x"),
    ], NOW);
    expect(d.groups[0].count).toBe(3);
    expect(d.groups[0].sig).toContain("[understudy] ask");
    expect(d.groups[1].count).toBe(1);
    expect(d.total).toBe(4);
  });

  test("three crash signals inside a minute are a crash loop; spread over hours they are not", () => {
    const loop = digest([
      e(3 * H, "child died: SIGSEGV"), e(3 * H - 5_000, "child died: SIGSEGV"), e(3 * H - 12_000, "child died: SIGSEGV"),
    ], NOW);
    expect(loop.crashLoops.length).toBe(1);
    expect(loop.crashLoops[0].count).toBe(3);
    expect(loop.quiet).toBe(false);
    const spread = digest([
      e(9 * H, "child died: SIGSEGV"), e(5 * H, "child died: SIGSEGV"), e(1 * H, "child died: SIGSEGV"),
    ], NOW);
    expect(spread.crashLoops.length).toBe(0);
  });

  test("a server that boots three times inside a minute is a restart loop", () => {
    const d = digest([
      e(20_000, "server started", "boot"), e(10_000, "server started", "boot"), e(1_000, "server started", "boot"),
    ], NOW);
    expect(d.crashLoops.length).toBe(1);
    expect(d.crashLoops[0].sig).toBe("server restarted");
  });

  test("a burst in the last hour against a quiet past is a spike", () => {
    const past = [e(20 * H, "browser did not answer in time (open)"), e(10 * H, "browser did not answer in time (shot)")];
    const burst = Array.from({ length: 9 }, (_, i) => e(i * 60_000, "browser did not answer in time (click)"));
    const d = digest([...past, ...burst], NOW);
    expect(d.spikes.length).toBe(1);
    expect(d.spikes[0].recent).toBe(9);
    expect(d.quiet).toBe(false);
  });

  test("a steady drip is not a spike", () => {
    const drip = Array.from({ length: 120 }, (_, i) => e(Math.floor(i / 5) * H + (i % 5) * 60_000 + 1000, "[picker] could not save x"));
    const d = digest(drip, NOW);
    expect(d.spikes.length).toBe(0);
    expect(d.quiet).toBe(true);
  });

  test("an empty log is quiet", () => {
    const d = digest([], NOW);
    expect(d.total).toBe(0);
    expect(d.quiet).toBe(true);
  });

  test("entries older than 24 h are not counted", () => {
    expect(digest([e(30 * H, "old")], NOW).total).toBe(0);
  });
});

describe("parseLog", () => {
  test("skips damaged lines instead of failing", () => {
    const text = JSON.stringify({ at: 1, level: "error", text: "ok" }) + "\n{not json\n\n" +
      JSON.stringify({ at: "x", level: "error", text: "bad at" }) + "\n";
    expect(parseLog(text).length).toBe(1);
  });
});

describe("serverlog", () => {
  test("formatEntry flattens an Error to its message and caps a long line", () => {
    const line = JSON.parse(formatEntry("error", ["[x] failed:", new Error("disk full")], 5)!);
    expect(line.text).toContain("[x] failed:");
    expect(line.text).toContain("disk full");
    expect(line.at).toBe(5);
    const long = JSON.parse(formatEntry("warn", ["a".repeat(50_000)], 1)!);
    expect(long.text.length).toBeLessThanOrEqual(2000);
  });

  test("append then read round-trips, and the file is rotated once past LOG_MAX", () => {
    const path = join(scratch, "server-errors.log");
    appendEntry(path, "error", ["first"], 1);
    expect(readEntries(path).map((x) => x.text)).toEqual(["first"]);
    writeFileSync(path, "x".repeat(LOG_MAX + 10));
    appendEntry(path, "error", ["after rotation"], 2);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(1000);
    expect(readEntries(path).some((x) => x.text === "after rotation")).toBe(true);
  });

  test("an unwritable path never throws", () => {
    expect(() => appendEntry(join(scratch, "no", "such", "dir", "x.log"), "error", ["x"], 1)).not.toThrow();
  });

  test("the file is owner-only", () => {
    const path = join(scratch, "mode.log");
    appendEntry(path, "warn", ["m"], 1);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(readFileSync(path, "utf8")).toContain('"level":"warn"');
  });
});
