/**
 * Cockpit MCP (#296) — first tool `cockpit_session_spend` + size ceiling.
 * Logic lives in bin/agentglass-cockpit-mcp; this drives the stdlib unit file.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const UNIT = join(import.meta.dir, "cockpit_mcp_unit.py");
const HAVE_PY = !!Bun.which("python3");

describe("agentglass-cockpit-mcp", () => {
  test.skipIf(!HAVE_PY)("bounded_json + spend tool + stdio handshake", async () => {
    const p = Bun.spawn(["python3", UNIT], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    const out = `${stdout}\n${stderr}`;
    if (code !== 0) {
      throw new Error(`cockpit_mcp_unit.py failed (${code})\n${out}`);
    }
    // unittest -v prints the summary banner to stderr
    expect(out).toMatch(/Ran \d+ tests/);
    expect(out).toMatch(/\bOK\b/);
  }, 30_000);
});
