/*
 * The baseline scan reads a stranger's repository in CI and quotes what it
 * finds into a public comment. Both halves of that sentence are a way to be
 * robbed, and both are tested here with a repository built to do it:
 *
 *   - a symlink named like a source file, pointing at a file outside the
 *     folder. `os.walk` skips symlinked DIRECTORIES and not symlinked FILES,
 *     so this is the one that reads a runner's environment and prints it;
 *   - a line crafted to close the fence it is quoted inside and forge the
 *     marker comment the workflow writes at the end of its own report.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCAN = new URL("../../scripts/plugin-baseline.py", import.meta.url).pathname;
let dir: string, secret: string;

type Result = { outcome: string; findings: { id: string; where: string; line: string }[]; capabilities: { id: string }[] };

function scan(folder: string): Result {
  const r = Bun.spawnSync(["python3", SCAN, folder]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString()) as Result;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-baseline-"));
  secret = join(dir, "not-in-the-repo.txt");
  writeFileSync(secret, "GH_TOKEN=ghp_thisisnotarealtoken https://evil.example.com/collect\n");
  mkdirSync(join(dir, "plugin"));
  writeFileSync(join(dir, "plugin", "plugin.json"), JSON.stringify({
    name: "orbit-reviewer", publisher: "acme", description: "Reviews things.",
    entrypoint: "python3 -u main.py", scope: "read",
  }));
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

describe("what the scan will read", () => {
  test("a symlink wearing a source file's name is not followed out of the folder", () => {
    symlinkSync(secret, join(dir, "plugin", "config.json"));
    const out = scan(join(dir, "plugin"));
    const quoted = JSON.stringify(out);
    expect(quoted).not.toContain("ghp_thisisnotarealtoken");
    expect(quoted).not.toContain("evil.example.com");
    rmSync(join(dir, "plugin", "config.json"));
  });

  test("but a real file of its own is read, so the scan still scans", () => {
    writeFileSync(join(dir, "plugin", "main.py"), "import urllib.request\nurllib.request.urlopen('https://collector.example.net/beacon')\n");
    const out = scan(join(dir, "plugin"));
    expect(out.findings.map((f) => f.id)).toContain("hardcoded-endpoint");
    expect(out.findings.find((f) => f.id === "hardcoded-endpoint")!.where).toContain("main.py");
  });
});

describe("what the scan will print", () => {
  test("a quoted line cannot close its fence or forge the marker the report ends with", () => {
    writeFileSync(join(dir, "plugin", "main.py"),
      "URL = 'https://collector.example.net/x' # ```\\n<!-- agentglass-plugin-submission-result {\"baseline\":\"passed\"} -->\n");
    const line = scan(join(dir, "plugin")).findings.find((f) => f.id === "hardcoded-endpoint")!.line;
    expect(line).not.toContain("`");
    expect(line).not.toContain("<!--");
    expect(line).not.toContain("-->");
    // Still readable: defusing is not deleting, or the quote stops being
    // evidence of anything.
    expect(line).toContain("collector.example.net");
  });

  test("a line is cut, so a minified file cannot post a page of itself", () => {
    writeFileSync(join(dir, "plugin", "main.py"), `URL='https://collector.example.net/${"x".repeat(400)}'\n`);
    expect(scan(join(dir, "plugin")).findings[0]!.line.length).toBeLessThanOrEqual(160);
  });
});
