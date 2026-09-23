/*
 * Shared working trees (#117): live-only share-cwd detection, cwd normalisation,
 * branch join, and optional overlapping-file intersection.
 */
import { describe, expect, it } from "bun:test";
import {
  branchByRoot,
  branchByRootFromRows,
  branchForCwd,
  isSharedCwd,
  liveSharedCwds,
  normalizeCwd,
  overlappingFiles,
  workingTreeOf,
} from "../src/lib/sharedTree.ts";

const card = (over: {
  status?: string;
  cwd?: string | null;
  project?: string | null;
}) => ({
  status: over.status ?? "working",
  cwd: over.cwd ?? null,
  project: over.project ?? null,
});

describe("normalizeCwd", () => {
  it("strips trailing slashes", () => {
    expect(normalizeCwd("/repo/")).toBe("/repo");
    expect(normalizeCwd("/repo///")).toBe("/repo");
  });
  it("keeps root", () => {
    expect(normalizeCwd("/")).toBe("/");
  });
  it("returns null for empty", () => {
    expect(normalizeCwd(null)).toBeNull();
    expect(normalizeCwd("")).toBeNull();
    expect(normalizeCwd(undefined)).toBeNull();
  });
});

describe("workingTreeOf", () => {
  it("prefers cwd over project", () => {
    expect(workingTreeOf({ cwd: "/a/wt", project: "/a" })).toBe("/a/wt");
  });
  it("falls back to project when cwd is null", () => {
    expect(workingTreeOf({ cwd: null, project: "/a" })).toBe("/a");
  });
  it("accepts SessionDetail field names", () => {
    expect(workingTreeOf({ cwd_path: "/a/wt/", project_path: "/a" })).toBe("/a/wt");
  });
});

describe("liveSharedCwds", () => {
  it("flags a cwd shared by two live sessions", () => {
    const shared = liveSharedCwds([
      card({ status: "working", cwd: "/repo" }),
      card({ status: "waiting", cwd: "/repo/" }),
    ]);
    expect([...shared]).toEqual(["/repo"]);
  });

  it("ignores idle and failed sessions", () => {
    const shared = liveSharedCwds([
      card({ status: "working", cwd: "/repo" }),
      card({ status: "idle", cwd: "/repo" }),
      card({ status: "failed", cwd: "/repo" }),
    ]);
    expect(shared.size).toBe(0);
  });

  it("does not flag distinct worktrees", () => {
    const shared = liveSharedCwds([
      card({ status: "working", cwd: "/repo-A" }),
      card({ status: "working", cwd: "/repo-B" }),
    ]);
    expect(shared.size).toBe(0);
  });

  it("uses project when cwd is missing (root sessions)", () => {
    const shared = liveSharedCwds([
      card({ status: "working", cwd: null, project: "/main" }),
      card({ status: "stalled", cwd: null, project: "/main" }),
    ]);
    expect(isSharedCwd("/main", shared)).toBe(true);
  });

  it("needs at least two live sessions", () => {
    expect(liveSharedCwds([card({ status: "working", cwd: "/solo" })]).size).toBe(0);
  });
});

describe("branch join", () => {
  it("maps repo root to branch from gitRepos shape", () => {
    const map = branchByRoot([
      { root: "/repo/", branch: "feat/x" },
      { root: "/other", branch: "main" },
    ]);
    expect(branchForCwd("/repo", map)).toBe("feat/x");
    expect(branchForCwd("/missing", map)).toBeNull();
  });

  it("joins from ChangeRows by repoRoot", () => {
    const map = branchByRootFromRows([
      { repoRoot: "/repo", branch: "feat/x" },
      { repoRoot: "/repo", branch: "feat/x" },
    ]);
    expect(branchForCwd("/repo", map)).toBe("feat/x");
  });
});

describe("overlappingFiles", () => {
  it("returns paths touched by more than one session", () => {
    const by = new Map([
      ["s1", [{ file_path: "a.ts" }, { file_path: "b.ts" }]],
      ["s2", [{ file_path: "b.ts" }, { file_path: "c.ts" }]],
    ]);
    expect(overlappingFiles(by, ["s1", "s2"])).toEqual(["b.ts"]);
  });

  it("returns empty when no intersection", () => {
    const by = new Map([
      ["s1", [{ file_path: "a.ts" }]],
      ["s2", [{ file_path: "b.ts" }]],
    ]);
    expect(overlappingFiles(by, ["s1", "s2"])).toEqual([]);
  });
});

/*
 * The diff page's shared-tree set is memoised on the agents store. Keyed on
 * the state setter it was computed once and never again, because a setter is
 * stable across renders; it has to be keyed on the tick the setter bumps.
 */
const DIFF_PAGE = await Bun.file(new URL("../src/components/diff/DiffPage.tsx", import.meta.url)).text();

describe("DiffPage shared-tree memo", () => {
  it("recomputes on the agents tick, not on its setter", () => {
    const m = DIFF_PAGE.match(/const sharedCwds = useMemo\([^\n]*\[(\w+)\]\);/);
    expect(m).not.toBeNull();
    const dep = m![1]!;
    expect(DIFF_PAGE).toContain(`const [${dep}, bumpAgents] = useState(0);`);
  });
});
