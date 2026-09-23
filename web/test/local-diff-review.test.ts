/*
 * Local diff review → agent chat prompt.
 *
 * Pure helpers only: snippet capture, prompt shape, and stale detection when
 * a file's sig or the text at the anchor moves. The DiffPage wires these into
 * the gutter; the store's localStorage is not exercised here.
 */
import { describe, expect, it } from "bun:test";
import type { DiffHunk } from "../../shared/types.ts";
import {
  buildPrompt,
  captureSnippet,
  lineTextAt,
  markStale,
  reviewChatTitle,
  type LocalDiffComment,
  type LocalDiffReview,
} from "../src/lib/localDiffReview.ts";

const hunk = (over: Partial<DiffHunk> & Pick<DiffHunk, "lines">): DiffHunk =>
  ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, ...over });

const sample: DiffHunk[] = [
  hunk({
    oldStart: 10,
    newStart: 10,
    lines: [
      " context before",
      "-old line",
      "+new line",
      "+added second",
      " context after",
    ],
  }),
];

const comment = (over: Partial<LocalDiffComment> = {}): LocalDiffComment => ({
  id: "c1",
  path: "src/foo.ts",
  repoRoot: "/repo",
  line: 11,
  side: "RIGHT",
  body: "prefer const",
  snippet: "new line",
  capturedAt: 1,
  sig: "sig-a",
  lineText: "new line",
  ...over,
});

describe("lineTextAt / captureSnippet", () => {
  it("reads RIGHT additions and LEFT removals at the right numbers", () => {
    expect(lineTextAt(sample, 11, "RIGHT")).toBe("new line");
    expect(lineTextAt(sample, 12, "RIGHT")).toBe("added second");
    expect(lineTextAt(sample, 11, "LEFT")).toBe("old line");
    expect(lineTextAt(sample, 10, "RIGHT")).toBe("context before");
  });

  it("captures a single line as the snippet", () => {
    expect(captureSnippet(sample, 11, "RIGHT")).toBe("new line");
  });

  it("captures a closed range in order", () => {
    expect(captureSnippet(sample, 12, "RIGHT", 11)).toBe("new line\nadded second");
  });

  it("returns empty when the line is not in any hunk", () => {
    expect(captureSnippet(sample, 99, "RIGHT")).toBe("");
  });
});

describe("markStale", () => {
  it("stays fresh when sig and line text match", () => {
    const out = markStale([comment()], "src/foo.ts", { sig: "sig-a", hunks: sample });
    expect(out[0]!.stale).toBeFalsy();
  });

  it("marks stale when FileDiff.sig moved", () => {
    const out = markStale([comment()], "src/foo.ts", { sig: "sig-b", hunks: sample });
    expect(out[0]!.stale).toBe(true);
    expect(out[0]!.snippet).toBe("new line");
  });

  it("marks stale when the text at the anchor changed", () => {
    const moved: DiffHunk[] = [
      hunk({
        oldStart: 10,
        newStart: 10,
        lines: [" context before", "-old line", "+changed line", " context after"],
      }),
    ];
    const out = markStale(
      [comment({ sig: "sig-a" })],
      "src/foo.ts",
      { sig: "sig-a", hunks: moved },
    );
    expect(out[0]!.stale).toBe(true);
    expect(out[0]!.snippet).toBe("new line");
  });

  it("leaves comments on other paths alone", () => {
    const out = markStale(
      [comment({ path: "other.ts" })],
      "src/foo.ts",
      { sig: "sig-b", hunks: sample },
    );
    expect(out[0]!.stale).toBeFalsy();
  });

  it("marks stale when the current diff is gone", () => {
    const out = markStale([comment()], "src/foo.ts", null);
    expect(out[0]!.stale).toBe(true);
  });
});

describe("buildPrompt", () => {
  it("quotes path, side, snippet and body, with intro and outro", () => {
    const review: LocalDiffReview = {
      intro: "Please fix these.",
      outro: "Thanks.",
      comments: [comment()],
    };
    const prompt = buildPrompt(review);
    expect(prompt).toContain("Please fix these.");
    expect(prompt).toContain("## src/foo.ts:L11 (RIGHT)");
    expect(prompt).toContain("```\nnew line\n```");
    expect(prompt).toContain("prefer const");
    expect(prompt).toContain("Thanks.");
    expect(prompt).not.toContain("[stale:");
  });

  it("still includes the captured snippet when stale, plus a notice", () => {
    const review: LocalDiffReview = {
      intro: "",
      outro: "",
      comments: [comment({ stale: true, startLine: 11, line: 12, snippet: "new line\nadded second" })],
    };
    const prompt = buildPrompt(review);
    expect(prompt).toContain("## src/foo.ts:L11–L12 (RIGHT)");
    expect(prompt).toContain("new line\nadded second");
    expect(prompt).toContain("[stale: line may have moved since capture]");
  });

  it("names a chat tab from the first file", () => {
    expect(reviewChatTitle({ intro: "", outro: "", comments: [] })).toBe("Diff review");
    expect(reviewChatTitle({ intro: "", outro: "", comments: [comment()] })).toBe("Diff review · foo.ts");
    expect(reviewChatTitle({
      intro: "", outro: "",
      comments: [comment(), comment({ id: "c2", path: "bar.ts" })],
    })).toBe("Diff review · 2 comments");
  });
});
