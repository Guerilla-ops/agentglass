/*
 * The second line of a check job's row, and which log lines get tinted.
 */
import { describe, expect, test } from "bun:test";
import type { PrCheckJob } from "../../shared/types.ts";
import { looksFailed, ranFor } from "../src/model/checkJobs.ts";

const job = (over: Partial<PrCheckJob>): PrCheckJob => ({
  id: "1", runId: "r", name: "test", status: "completed", conclusion: "failure",
  startedAt: "2026-09-01T10:00:00Z", completedAt: "2026-09-01T10:03:12Z", url: "", ...over,
});

describe("ranFor", () => {
  test("a finished job says how it ended and how long it took", () => {
    expect(ranFor(job({}), 0)).toBe("Failed after 3m 12s");
    expect(ranFor(job({ conclusion: "success", completedAt: "2026-09-01T10:00:41Z" }), 0)).toBe("Passed after 41s");
  });
  test("a running one says since when", () => {
    const now = Date.parse("2026-09-01T10:04:00Z");
    expect(ranFor(job({ status: "in_progress", conclusion: null, completedAt: null }), now)).toBe("Started 4m ago");
  });
  test("no times is the word alone", () => {
    expect(ranFor(job({ status: "queued", conclusion: null, startedAt: null, completedAt: null }), 0)).toBe("Queued");
  });
});

describe("looksFailed", () => {
  test("the lines a failure is written on", () => {
    for (const line of [" ✗ search › debounces", "error: script \"test\" exited with code 1", "##[error]Process completed",
      "   Expected: 1", "FAIL src/a.test.ts"]) expect(looksFailed(line), line).toBe(true);
  });
  test("and not a path that happens to contain the word", () => {
    for (const line of ["  src/errors/index.ts   2.1 KB", " ✓ indexer › builds", "Checked 812 installs"]) {
      expect(looksFailed(line), line).toBe(false);
    }
  });
});
