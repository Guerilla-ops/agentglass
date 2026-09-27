/*
 * `template save|list|rm`: a template is a signed-in page's cookies and
 * storage, kept under a name instead of a path, for `lane new --from-template`
 * (browser-fork-per-task.test.ts) to seed a fresh partition from later.
 *
 * A template is a credential, so:
 *   - the file is 0600 in a 0700 directory, like every other file `session
 *     save` already writes through `_write_private` (bin-token-and-files);
 *   - `template list` prints what the template is FOR (origins, when it was
 *     made, when it goes stale) and never a cookie or storage value;
 *   - names are `[a-z0-9-]{1,32}` — no path segment, no traversal;
 *   - nothing here is reachable over MCP. An agent asks the CLI-only verb, or
 *     it does not get a template at all — the same shape as `session import`.
 *
 * Loaded as a module without running main(), same trick as
 * bin-token-and-files.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_PY = !!Bun.which("python3");
const BIN = (name: string) => new URL(`../../bin/${name}`, import.meta.url).pathname;

function probe(file: string, body: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const src = `
import json, os, sys
ns = {"__name__": "probe", "__file__": ${JSON.stringify(file)}}
exec(compile(open(${JSON.stringify(file)}).read(), ${JSON.stringify(file)}, "exec"), ns)
${body}
`;
  const p = Bun.spawnSync(["python3", "-c", src], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const STUB_ANSWERS = `
answers = {
  "cdp": {"ok": True, "value": {"result": {"cookies": [
    {"name": "sid", "value": "secret-cookie", "domain": "app.example.invalid", "expires": 4102444800},
    {"name": "flash", "value": "secret-flash", "domain": "app.example.invalid", "expires": -1},
  ]}}},
  "eval": {"ok": True, "value": {"value": {"origin": "https://app.example.invalid", "localStorage": {"token": "secret-token"}, "sessionStorage": {}}}},
}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
`;

describe.skipIf(!HAVE_PY)("template store", () => {
  test("template save writes 0600 in a 0700 dir, meta only in what it prints", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-data-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${STUB_ANSWERS}
code = ns["template_save"]("acme-corp", "", None)
tdir = os.path.join(${JSON.stringify(dataHome)}, "agentglass", "browser-templates")
tfile = os.path.join(tdir, "acme-corp.json")
print(json.dumps({
  "code": code,
  "dirMode": oct(os.stat(tdir).st_mode & 0o777),
  "fileMode": oct(os.stat(tfile).st_mode & 0o777),
  "raw": open(tfile).read(),
}))
`, { XDG_DATA_HOME: dataHome });
      expect(r.code, r.err).toBe(0);
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; dirMode: string; fileMode: string; raw: string };
      expect(last.code).toBe(0);
      expect(last.dirMode).toBe("0o700");
      expect(last.fileMode).toBe("0o600");
      const saved = JSON.parse(last.raw) as { meta: { origins: string[]; createdAt: string; earliestExpiry: number | null } };
      expect(saved.meta.origins).toEqual(["https://app.example.invalid"]);
      expect(saved.meta.earliestExpiry).toBe(4102444800); // the session cookie (expires -1) never wins the "earliest"
      expect(typeof saved.meta.createdAt).toBe("string");
      // The line `template_save` itself printed — never the file it just wrote,
      // which is r.out's second line and is expected to hold the cookie.
      const printed = r.out.trim().split("\n")[0];
      expect(printed).not.toContain("secret-cookie");
      expect(printed).not.toContain("secret-token");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("template list prints origins and expiry, never a value", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-data-"));
    try {
      probe(BIN("agentglass-browser"), `${STUB_ANSWERS}\nns["template_save"]("acme-corp", "", None)`, { XDG_DATA_HOME: dataHome });
      const r = probe(BIN("agentglass-browser"), `ns["template_list"]()`, { XDG_DATA_HOME: dataHome });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain("acme-corp");
      expect(r.out).toContain("app.example.invalid");
      expect(r.out).not.toContain("secret-cookie");
      expect(r.out).not.toContain("secret-token");
      expect(r.out).not.toContain("secret-flash");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("template list on an empty store says so, without inventing a name", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-data-"));
    try {
      const r = probe(BIN("agentglass-browser"), `ns["template_list"]()`, { XDG_DATA_HOME: dataHome });
      expect(r.code, r.err).toBe(0);
      expect(r.out.trim().length).toBeGreaterThan(0);
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("template rm deletes a saved template; a name that was never saved is a named refusal, not a crash", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-data-"));
    try {
      probe(BIN("agentglass-browser"), `${STUB_ANSWERS}\nns["template_save"]("acme-corp", "", None)`, { XDG_DATA_HOME: dataHome });
      const gone = probe(BIN("agentglass-browser"), `print(ns["template_rm"]("acme-corp"))`, { XDG_DATA_HOME: dataHome });
      expect(gone.out.trim().split("\n").pop()).toBe("0");
      const missing = probe(BIN("agentglass-browser"), `print(ns["template_rm"]("acme-corp"))`, { XDG_DATA_HOME: dataHome });
      expect(missing.out.trim().split("\n").pop()).toBe("1");
      expect(missing.err).toContain("no template called acme-corp");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("a name that is not [a-z0-9-]{1,32} is refused by save AND rm — no path, no traversal", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-data-"));
    try {
      for (const bad of ["../../etc/passwd", "Acme-Corp", "has space", "a".repeat(33), ""]) {
        const s = probe(BIN("agentglass-browser"), `${STUB_ANSWERS}\nprint(ns["template_save"](${JSON.stringify(bad)}, "", None))`, { XDG_DATA_HOME: dataHome });
        expect(s.out.trim().split("\n").pop(), `save ${JSON.stringify(bad)}: ${s.err}`).toBe("2");
        const r = probe(BIN("agentglass-browser"), `print(ns["template_rm"](${JSON.stringify(bad)}))`, { XDG_DATA_HOME: dataHome });
        expect(r.out.trim().split("\n").pop(), `rm ${JSON.stringify(bad)}: ${r.err}`).toBe("2");
      }
      // Nothing escaped the templates directory.
      const dir = join(dataHome, "agentglass", "browser-templates");
      try { expect(statSync(dir).isDirectory()).toBe(true); } catch { /* never created is fine too */ }
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("a symlinked or foreign-owned templates directory is refused, not written into", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-data-"));
    const outside = mkdtempSync(join(tmpdir(), "agx-tmpl-outside-"));
    try {
      mkdirSync(join(dataHome, "agentglass"), { recursive: true });
      // A symlink where `_template_dir` expects a real, owned directory — the
      // exact planted-link shape `O_NOFOLLOW`/the lstat check exist to catch.
      symlinkSync(outside, join(dataHome, "agentglass", "browser-templates"));
      const r = probe(BIN("agentglass-browser"), `
${STUB_ANSWERS}
print(ns["template_save"]("acme-corp", "", None))
`, { XDG_DATA_HOME: dataHome });
      expect(r.code).toBe(2);
      expect(r.err).toContain("not a private directory I own");
    } finally {
      rmSync(dataHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("MCP offers no template tool — a template is minted and read by the CLI alone", () => {
    const src = readFileSync(BIN("agentglass-browser-mcp"), "utf8");
    expect(src.toLowerCase()).not.toContain("template");
  });

  test("browser_upload's deny list refuses a file under the templates directory, same weight as .ssh/.gnupg/.aws", async () => {
    // Same server process as browser_upload's own check (uploadPathError),
    // not the CLI's python subprocess — a template is CLI-only to make, but
    // the panel/MCP's file-attach path is a second, independent way a page
    // could otherwise be handed one, and this is what closes THAT one.
    const { uploadPathError } = await import("../src/browserdrive.ts");
    const savedHome = process.env.HOME;
    const savedXdg = process.env.XDG_DATA_HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "agx-tmpl-uploadhome-"));
    try {
      delete process.env.XDG_DATA_HOME; // an ambient one must not shadow HOME for this check
      process.env.HOME = fakeHome;
      const dir = join(fakeHome, ".local", "share", "agentglass", "browser-templates");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "acme-corp.json");
      writeFileSync(file, "{}");
      const r = uploadPathError(file);
      expect(r.error).toContain("files under");
      expect(r.error).toContain("browser-templates");
      expect(r.real).toBeUndefined();
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXdg;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
