/**
 * Checkout → branch, from the cheap `gitRepos` list.
 *
 * Fleet and SessionModal join this onto sessionCwd so "branch Y in worktree Z"
 * is readable without opening Diff. Refreshed on the git bus; no per-card
 * `rev-parse`.
 */
import { api } from "./api.ts";
import { subscribeGitChanged } from "./gitBus.ts";
import { branchByRoot } from "./sharedTree.ts";

let byRoot: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
let watching = false;
let inflight = false;

function tell(): void {
  for (const l of listeners) {
    try { l(); } catch { /* one bad listener must not stop the rest */ }
  }
}

async function load(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const { repos } = await api.gitRepos();
    byRoot = branchByRoot(repos);
    tell();
  } catch {
    /* keep the last good map */
  } finally {
    inflight = false;
  }
}

function ensureWatch(): void {
  if (watching) return;
  watching = true;
  subscribeGitChanged(() => { void load(); });
  void load();
}

export function branchesOf(): ReadonlyMap<string, string> {
  ensureWatch();
  return byRoot;
}

export function subscribeBranches(fn: () => void): () => void {
  ensureWatch();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
