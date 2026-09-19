/*
 * "Which checkout on this machine is acme/orbit?"
 *
 * A pull request is read through a local checkout, because that is where the
 * remote — and so the repository's identity — comes from. A link to a pull
 * request in a project that is not the open one therefore has nowhere to land
 * until this has answered, and the panel's old answer was to search for the
 * number in whichever repository it happened to be showing: either nothing,
 * or somebody else's pull request with the same number.
 *
 * Real checkouts with real remotes, because the whole question is what `git
 * remote get-url` says.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateRepo } from "../src/prs.ts";

let dir: string, orbit: string, billing: string, bare: string;

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function checkout(name: string, remote?: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  if (remote) git(root, "remote", "add", "origin", remote);
  return root;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-pr-locate-"));
  orbit = checkout("orbit", "https://github.com/acme/orbit.git");
  billing = checkout("billing", "git@github.com:acme/billing.git");
  bare = checkout("scratch");
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("finding the checkout a pull request belongs to", () => {
  test("names the one whose remote is that repository, and only that one", async () => {
    expect(await locateRepo("acme/orbit", [billing, bare, orbit])).toBe(orbit);
    // An ssh remote is the same repository written differently.
    expect(await locateRepo("acme/billing", [orbit, billing])).toBe(billing);
  });

  test("case is GitHub's, not the link's — a URL copied out of a browser carries whatever the page used", async () => {
    expect(await locateRepo("Acme/Orbit", [orbit])).toBe(orbit);
  });

  test("a repository with no checkout here is nothing, not the nearest guess", async () => {
    expect(await locateRepo("acme/nowhere", [orbit, billing, bare])).toBeNull();
    // A checkout with no remote at all names no repository.
    expect(await locateRepo("acme/scratch", [bare])).toBeNull();
  });
});
