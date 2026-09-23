/**
 * Shared working trees — visibility helpers for #117.
 *
 * When two or more *live* sessions share one cwd / checkout, on-disk diffs are
 * commingled and per-file attribution is only approximate. These helpers detect
 * that case from the AgentCards Fleet already has, and join a git branch name
 * from a cheap repo list (or ChangeRows) without inventing session ownership.
 *
 * Visibility only: nothing here creates worktrees, assigns work, or attributes
 * hunks to a session.
 */

/** Statuses that mean the run is over — same rule Fleet uses for "live". */
export const SESSION_OVER = new Set<string>(["idle", "failed"]);

/** Chip / Diff honesty line. */
export const SHARED_TREE_LABEL = "shared tree";

/** Longer copy for tooltips and Diff section banners. */
export const SHARED_TREE_HINT =
  "shared tree — per-file attribution approximate";

export const SHARED_TREE_TOOLTIP =
  "Two or more live sessions share this working tree. On-disk diffs are commingled; per-file attribution here is approximate.";

/** Strip trailing slashes so `/repo` and `/repo/` group as one key. */
export function normalizeCwd(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}

/**
 * Where a session is actually working — prefer the recorded cwd, else the
 * project root. Accepts both AgentCard (`cwd`/`project`) and SessionDetail
 * (`cwd_path`/`project_path`) shapes.
 */
export function workingTreeOf(s: {
  cwd?: string | null;
  project?: string | null;
  cwd_path?: string | null;
  project_path?: string | null;
}): string | null {
  return normalizeCwd(s.cwd_path || s.cwd || s.project_path || s.project || null);
}

/**
 * Cwds shared by ≥2 live sessions. Idle / failed sessions do not count — a
 * finished agent left in the same checkout must not flag the live one.
 */
export function liveSharedCwds(
  agents: ReadonlyArray<{ status: string; cwd?: string | null; project?: string | null }>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const a of agents) {
    if (SESSION_OVER.has(a.status)) continue;
    const key = workingTreeOf(a);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = new Set<string>();
  for (const [key, n] of counts) {
    if (n >= 2) shared.add(key);
  }
  return shared;
}

export function isSharedCwd(
  cwd: string | null | undefined,
  shared: ReadonlySet<string>,
): boolean {
  const key = normalizeCwd(cwd);
  return !!key && shared.has(key);
}

/** repoRoot → branch from `api.gitRepos()` (or any `{root, branch}` list). */
export function branchByRoot(
  repos: ReadonlyArray<{ root: string; branch?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of repos) {
    const root = normalizeCwd(r.root);
    if (!root || !r.branch) continue;
    map.set(root, r.branch);
  }
  return map;
}

/** Same join from Diff ChangeRows — branch already rides on every row. */
export function branchByRootFromRows(
  rows: ReadonlyArray<{ repoRoot: string; branch?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const root = normalizeCwd(r.repoRoot);
    if (!root || !r.branch) continue;
    if (!map.has(root)) map.set(root, r.branch);
  }
  return map;
}

export function branchForCwd(
  cwd: string | null | undefined,
  byRoot: ReadonlyMap<string, string>,
): string | null {
  const key = normalizeCwd(cwd);
  if (!key) return null;
  return byRoot.get(key) ?? null;
}

/**
 * Relative paths touched by more than one of the given sessions.
 * Optional honesty strengthening when Edit/Write changes are already in hand.
 */
export function overlappingFiles(
  changesBySession: ReadonlyMap<string, ReadonlyArray<{ file_path: string }>>,
  sessionIds: ReadonlyArray<string>,
): string[] {
  if (sessionIds.length < 2) return [];
  const seen = new Map<string, string>(); // path → first session
  const overlap = new Set<string>();
  for (const id of sessionIds) {
    const changes = changesBySession.get(id);
    if (!changes) continue;
    for (const c of changes) {
      const path = c.file_path;
      if (!path) continue;
      const first = seen.get(path);
      if (first === undefined) seen.set(path, id);
      else if (first !== id) overlap.add(path);
    }
  }
  return [...overlap].sort();
}
