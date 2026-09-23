/*
 * One pull request is one card — counted once, asked once.
 *
 * Pull requests used to be fetched per *checkout*, and this machine keeps three
 * worktrees of the same repository, so one red pull request drew three
 * identical cards. `dedupePrs` and `mainCheckouts` are the fix; the Now queue
 * that used to consume them is gone, but the rule still decides what the
 * pull-request list asks GitHub for.
 */
import { describe, expect, it } from "bun:test";
import { dedupePrs, mainCheckouts } from "../src/model/prRows.ts";

describe("counting a pull request once", () => {
  const rows = (scope: "mine" | "review", repo = "shop-api", number = 482) =>
    ({ repo, scope, pr: { number, url: `https://github.com/a/${repo}/pull/${number}` } });

  it("three worktrees of one repository still make one card", () => {
    expect(dedupePrs([rows("mine"), rows("mine"), rows("mine")])).toHaveLength(1);
  });

  it("yours wins over asked-to-review when both come back", () => {
    expect(dedupePrs([rows("review"), rows("mine")])[0]!.scope).toBe("mine");
    expect(dedupePrs([rows("mine"), rows("review")])[0]!.scope).toBe("mine");
  });

  it("the same number in two repositories is two things", () => {
    const out = dedupePrs([rows("mine", "shop-api"), rows("mine", "shop-web")]);
    expect(out).toHaveLength(2);
  });

  it("asks one checkout per repository, not one per directory", () => {
    const list = [
      { root: "/w/shop-api" },
      { root: "/w/shop-api-fix", worktreeOf: "/w/shop-api" },
      { root: "/w/shop-api-spike", worktreeOf: "/w/shop-api" },
      { root: "/w/shop-web" },
    ];
    expect(mainCheckouts(list).map((r) => r.root)).toEqual(["/w/shop-api", "/w/shop-web"]);
  });

  it("keeps a worktree whose main checkout the phone cannot see", () => {
    const list = [{ root: "/w/detached", worktreeOf: "/elsewhere/shop-api" }];
    expect(mainCheckouts(list)).toHaveLength(1);
  });

  it("falls back to repo and number when there is no url", () => {
    const bare = (scope: "mine" | "review") => ({ repo: "shop-api", scope, pr: { number: 482 } });
    expect(dedupePrs([bare("mine"), bare("review")])).toHaveLength(1);
  });
});
