/*
 * Which checkout a directory is in.
 *
 * Source control opened from the terminal used to show the FIRST checkout the
 * machine listed, whatever pane it was opened from: `found[0]`. On a machine
 * working a worktree per pull request that is somebody else's branch, drawn
 * convincingly under the name of the one you were looking at.
 *
 * A pane's directory is often below the checkout's root (a shell that has
 * `cd`'d into `src/`), so this is the longest root that contains it, not an
 * exact match. No match is the directory itself: the server's status route
 * takes a path and answers for whatever repository holds it.
 */
export function checkoutFor(where: string, roots: string[]): string {
  const clean = where.replace(/\/+$/, "");
  let best: string | null = null;
  for (const root of roots) {
    const r = root.replace(/\/+$/, "");
    if ((clean === r || clean.startsWith(r + "/")) && (!best || r.length > best.length)) best = root;
  }
  return best ?? where;
}
