/**
 * Pending local-diff review → one agent-chat prompt.
 *
 * The Diff panel already knows file, line and code; Chat can talk to an agent.
 * This is the bridge: gutter comments accumulate client-side (intro / outro +
 * captured snippets), and one action builds a single structured prompt and
 * hands it to `seedChat` / `openChatWith`. No GitHub API — that shape lives in
 * PrPanel for pull requests (#316). This is the local working-tree case (#294).
 *
 * The detail that survives an agent edit: the snippet is captured when the
 * comment is written. If the file's `sig` or the text at the anchor moves, the
 * comment is marked stale in the UI but the original snippet still goes in the
 * prompt. A review that silently loses its anchor is worse than no review.
 */
import type { DiffHunk, FileDiff } from "../../../shared/types.ts";

export type DiffSide = "LEFT" | "RIGHT";

export type LocalDiffComment = {
  id: string;
  path: string;
  repoRoot: string;
  line: number;
  startLine?: number;
  side: DiffSide;
  body: string;
  /** Code at the anchor when the comment was written — always sent. */
  snippet: string;
  capturedAt: number;
  /** FileDiff.sig at capture time. */
  sig?: string;
  /** Exact line text at the primary anchor when captured (stale check). */
  lineText?: string;
  stale?: boolean;
};

export type LocalDiffReview = {
  intro: string;
  outro: string;
  comments: LocalDiffComment[];
};

const EMPTY_REVIEW: LocalDiffReview = { intro: "", outro: "", comments: [] };
const emptyReview = (): LocalDiffReview => ({ intro: "", outro: "", comments: [] });

const STORAGE_KEY = "agentglass.diff.localReview.v1";

type Store = Record<string, LocalDiffReview>;

const loadAll = (): Store => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const saveAll = (all: Store) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
};

let cache: Store | null = null;
const listeners = new Set<() => void>();

const getStore = (): Store => {
  if (!cache) cache = typeof localStorage !== "undefined" ? loadAll() : {};
  return cache;
};

const bump = () => {
  for (const fn of listeners) fn();
};

export const subscribeLocalReview = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const getLocalReview = (repoRoot: string): LocalDiffReview => {
  const all = getStore();
  /* Stable empty snapshot — useSyncExternalStore compares with Object.is. */
  return all[repoRoot] ?? EMPTY_REVIEW;
};

const writeReview = (repoRoot: string, review: LocalDiffReview) => {
  const all = { ...getStore() };
  if (!review.intro && !review.outro && review.comments.length === 0) {
    delete all[repoRoot];
  } else {
    all[repoRoot] = review;
  }
  cache = all;
  saveAll(all);
  bump();
};

export const setLocalIntro = (repoRoot: string, intro: string) => {
  const cur = getLocalReview(repoRoot);
  writeReview(repoRoot, { ...cur, intro });
};

export const setLocalOutro = (repoRoot: string, outro: string) => {
  const cur = getLocalReview(repoRoot);
  writeReview(repoRoot, { ...cur, outro });
};

export const addLocalComment = (
  repoRoot: string,
  comment: Omit<LocalDiffComment, "id" | "capturedAt" | "repoRoot"> & { id?: string; capturedAt?: number },
): LocalDiffComment => {
  const full: LocalDiffComment = {
    ...comment,
    id: comment.id ?? `ldc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    repoRoot,
    capturedAt: comment.capturedAt ?? Date.now(),
  };
  const cur = getLocalReview(repoRoot);
  writeReview(repoRoot, { ...cur, comments: [...cur.comments, full] });
  return full;
};

export const removeLocalComment = (repoRoot: string, id: string) => {
  const cur = getLocalReview(repoRoot);
  writeReview(repoRoot, { ...cur, comments: cur.comments.filter((c) => c.id !== id) });
};

export const clearLocalReview = (repoRoot: string) => {
  writeReview(repoRoot, emptyReview());
};

/** Replace comments after a stale pass (keeps intro/outro). */
export const replaceLocalComments = (repoRoot: string, comments: LocalDiffComment[]) => {
  const cur = getLocalReview(repoRoot);
  writeReview(repoRoot, { ...cur, comments });
};

/* ── pure helpers ─────────────────────────────────────────────────────────── */

/**
 * Text of one line on one side of a unified hunk list.
 * Same walk PrPanel's `lineTextAt` uses — keeps LEFT/RIGHT numbering honest.
 */
export function lineTextAt(hunks: DiffHunk[], line: number, side: DiffSide): string {
  for (const h of hunks) {
    let oldN = h.oldStart, newN = h.newStart;
    for (const raw of h.lines) {
      if (raw.startsWith("\\")) continue;
      const tag = raw[0], text = raw.slice(1);
      if (tag === "+") {
        if (side === "RIGHT" && newN === line) return text;
        newN++;
      } else if (tag === "-") {
        if (side === "LEFT" && oldN === line) return text;
        oldN++;
      } else {
        if ((side === "RIGHT" && newN === line) || (side === "LEFT" && oldN === line)) return text;
        oldN++;
        newN++;
      }
    }
  }
  return "";
}

/**
 * Capture the code the comment is about — a single line, or a closed range
 * from `startLine` through `line` (inclusive), in file order on that side.
 */
export function captureSnippet(
  hunks: DiffHunk[],
  line: number,
  side: DiffSide,
  startLine?: number,
): string {
  const from = startLine != null && startLine !== line ? Math.min(startLine, line) : line;
  const to = startLine != null && startLine !== line ? Math.max(startLine, line) : line;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const t = lineTextAt(hunks, n, side);
    // Keep empty lines in a range so the snippet still looks like the block.
    if (from === to && !t) continue;
    out.push(t);
  }
  return out.join("\n");
}

/**
 * Mark comments stale when the file's signature moved or the text at the
 * recorded anchor no longer matches what was captured. Comments for other
 * paths are left alone. Always keeps the original `snippet`.
 */
export function markStale(
  comments: LocalDiffComment[],
  path: string,
  current: Pick<FileDiff, "sig" | "hunks"> | null,
): LocalDiffComment[] {
  if (!current) {
    return comments.map((c) => (c.path === path ? { ...c, stale: true } : c));
  }
  return comments.map((c) => {
    if (c.path !== path) return c;
    const sigMoved = c.sig != null && c.sig !== current.sig;
    const nowText = lineTextAt(current.hunks, c.line, c.side);
    const textMoved = c.lineText != null && c.lineText !== nowText;
    const missing = nowText === "" && (c.lineText != null && c.lineText !== "");
    const stale = !!(sigMoved || textMoved || missing);
    return stale === !!c.stale ? c : { ...c, stale };
  });
}

/**
 * One structured prompt: intro, each comment with path + hunk/snippet, outro.
 * Stale comments still include their captured snippet and a short notice.
 */
export function buildPrompt(review: LocalDiffReview): string {
  const parts: string[] = [];
  const intro = review.intro.trim();
  if (intro) parts.push(intro);

  for (const c of review.comments) {
    const from = c.startLine != null && c.startLine !== c.line
      ? Math.min(c.startLine, c.line)
      : c.line;
    const to = c.startLine != null && c.startLine !== c.line
      ? Math.max(c.startLine, c.line)
      : c.line;
    const where = from === to ? `L${from}` : `L${from}–L${to}`;
    const head = `## ${c.path}:${where} (${c.side})`;
    // Longer than any backtick run in the snippet, or a snippet that itself
    // holds a fence (a Markdown file, a template literal) closes this one early.
    const fence = "`".repeat(Math.max(3, ...(c.snippet.match(/`+/g) ?? []).map((r) => r.length + 1)));
    const block = [
      head,
      fence,
      c.snippet,
      fence,
      c.body.trim(),
      ...(c.stale ? ["[stale: line may have moved since capture]"] : []),
    ].join("\n");
    parts.push(block);
  }

  const outro = review.outro.trim();
  if (outro) parts.push(outro);

  return parts.join("\n\n").trim();
}

/** Title for the seeded chat tab. */
export function reviewChatTitle(review: LocalDiffReview): string {
  const n = review.comments.length;
  if (n === 0) return "Diff review";
  const path = review.comments[0]?.path ?? "diff";
  const name = path.slice(path.lastIndexOf("/") + 1) || path;
  return n === 1 ? `Diff review · ${name}` : `Diff review · ${n} comments`;
}
