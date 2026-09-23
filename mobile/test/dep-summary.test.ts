/*
 * The verdict at the top of Troubleshooting.
 *
 * The screen was twenty rows with a dot each, and "is anything I need
 * missing" had to be counted off them.
 */
import { describe, expect, test } from "bun:test";
import { depSummary } from "../src/model/depLook.ts";

const dep = (status: "ok" | "missing" | "attention" | "unsupported", required = true) => ({ status, required });

describe("depSummary", () => {
  test("everything found is good", () => {
    expect(depSummary([dep("ok"), dep("ok", false)])).toMatchObject({ tone: "good", title: "2 of 2 tools found" });
  });
  test("an optional tool missing is amber, and said as optional", () => {
    const s = depSummary([dep("ok"), dep("missing", false)]);
    expect(s.tone).toBe("warn");
    expect(s.sub).toContain("One optional tool is missing");
  });
  test("a required one outranks it", () => {
    expect(depSummary([dep("attention"), dep("missing", false)]).tone).toBe("bad");
  });
  test("a tool this platform never uses counts as neither", () => {
    expect(depSummary([dep("ok"), dep("unsupported")])).toMatchObject({ tone: "good", title: "1 of 1 tools found" });
  });
});
