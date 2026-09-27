// R3 companion: a hand-started server with no AGENTGLASS_TOKEN ran silent.
// The gap (any local process, any account, reaches the shell and git/docker
// writes) is real and stays for this release, but it must no longer be quiet.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tokenlessWarning, type Auth } from "../src/auth.ts";

const auth = (source: Auth["source"]): Auth => ({ token: source === "none" ? null : "t", source, path: "/x" });

describe("tokenlessWarning", () => {
  it("warns and names the fix when there is no token", () => {
    const w = tokenlessWarning(auth("none"));
    expect(w).not.toBeNull();
    expect(w).toContain("AGENTGLASS_TOKEN");
  });

  it("stays silent for every source that actually has a token", () => {
    expect(tokenlessWarning(auth("env"))).toBeNull();
    expect(tokenlessWarning(auth("file"))).toBeNull();
    expect(tokenlessWarning(auth("generated"))).toBeNull();
  });
});

describe("index.ts calls tokenlessWarning at startup", () => {
  it("prints it in the else branch of the AUTH_TOKEN startup block", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    const stripped = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(stripped).toContain("tokenlessWarning(AUTH)");
  });
});
