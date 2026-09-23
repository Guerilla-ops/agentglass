/*
 * A count you can believe.
 *
 * Pull requests were fetched per *checkout*, and this machine keeps three
 * worktrees of the same repository, so one red pull request drew three
 * identical cards and told you there were three things to do. The same rows
 * feed the pull request badge on the tab bar now, and the same lie would be a
 * badge saying three.
 *
 * The rest of this suite tested the Now screen's queue (its "Later" and the
 * `mark` a card was compared by) and went with that screen.
 */
import { describe, expect, it } from "bun:test";
import { dedupePrs, mainCheckouts } from "../src/model/prRows.ts";

// ── one pull request is one card ───────────────────────────────────────

describe("counting a pull request once", () => {
  const rows = (scope: "mine" | "review", repo = "shop-api", number = 482) =>
    ({ repo, scope, pr: { number, url: `https://github.com/a/${repo}/pull/${number}` } });

  it("three worktrees of one repository still make one card", () => {
    // Every checkout of a repository answers the same question with the same
    // answer. Before this, the queue said "3 things want you" and the hero's
    // number was the number of directories on disk.
    expect(dedupePrs([rows("mine"), rows("mine"), rows("mine")])).toHaveLength(1);
  });

  it("yours wins over asked-to-review when both come back", () => {
    // A pull request you own and were also added to is a thing to fix, not a
    // thing to read. Whichever order the two fetches land in.
    expect(dedupePrs([rows("review"), rows("mine")])[0]!.scope).toBe("mine");
    expect(dedupePrs([rows("mine"), rows("review")])[0]!.scope).toBe("mine");
  });

  it("the same number in two repositories is two things", () => {
    const out = dedupePrs([rows("mine", "shop-api"), rows("mine", "shop-web")]);
    expect(out).toHaveLength(2);
  });

  it("asks one checkout per repository, not one per directory", () => {
    // The root cause. Three worktrees is a normal way to work here, and each
    // one answered GitHub's question identically because a worktree shares the
    // remote — so the fix is to stop asking three times, and dedupe is the
    // belt to that pair of braces.
    const list = [
      { root: "/w/shop-api" },
      { root: "/w/shop-api-fix", worktreeOf: "/w/shop-api" },
      { root: "/w/shop-api-spike", worktreeOf: "/w/shop-api" },
      { root: "/w/shop-web" },
    ];
    expect(mainCheckouts(list).map((r) => r.root)).toEqual(["/w/shop-api", "/w/shop-web"]);
  });

  it("keeps a worktree whose main checkout the phone cannot see", () => {
    // Otherwise that repository's pull requests vanish entirely, which is a
    // worse bug than counting them twice.
    const list = [{ root: "/w/detached", worktreeOf: "/elsewhere/shop-api" }];
    expect(mainCheckouts(list)).toHaveLength(1);
  });

  it("falls back to repo and number when there is no url", () => {
    const bare = (scope: "mine" | "review") => ({ repo: "shop-api", scope, pr: { number: 482 } });
    expect(dedupePrs([bare("mine"), bare("review")])).toHaveLength(1);
  });
});
