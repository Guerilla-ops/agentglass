import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An unquoted heredoc (`<<EOF`) is expanded like a double-quoted string, so a
 * backtick in it RUNS what it wraps. install-local.sh wrote the .desktop file
 * from one that carried a comment with `app.setAsDefaultProtocolClient` and
 * `%u` in backticks: every install printed "command not found" and
 * "fg: no job control", and the comment landed in the .desktop file as well.
 */
const ROOT = join(import.meta.dir, "..", "..");
const scripts = ["electron", "scripts"].flatMap((d) =>
  readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".sh")).map((f) => join(d, f)));

/** Bodies of every heredoc whose delimiter is not quoted. */
function unquotedHeredocs(src: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/<<(-?)\s*([A-Za-z_]+)\s*$/);
    if (!m || /^\s*#/.test(lines[i]!)) continue;
    const end = lines.findIndex((l, j) => j > i && (m[1] ? l.trim() : l) === m[2]);
    if (end < 0) continue;
    out.push({ line: i + 1, body: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  return out;
}

describe("unquoted heredocs", () => {
  it("finds the scripts it is meant to scan", () => {
    expect(scripts).toContain(join("electron", "install-local.sh"));
  });

  for (const f of scripts) {
    it(`${f}: no backtick or $( inside one`, () => {
      const bad = unquotedHeredocs(readFileSync(join(ROOT, f), "utf8"))
        .filter((h) => /`|\$\(/.test(h.body))
        .map((h) => `${f}:${h.line}`);
      expect(bad).toEqual([]);
    });
  }

  it("the .desktop file is written without running anything", () => {
    const src = readFileSync(join(ROOT, "electron", "install-local.sh"), "utf8");
    const start = src.indexOf('cat > "$DESKTOP/agentglass.desktop"');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nEOF\n", start);
    expect(end).toBeGreaterThan(start);
    const dir = mkdtempSync(join(tmpdir(), "agx-desktop-"));
    try {
      const p = Bun.spawnSync(["bash", "-c", src.slice(start, end + 5)], {
        env: { PATH: process.env.PATH ?? "", APP: "/opt/orbit", DESKTOP: dir },
        stdout: "pipe", stderr: "pipe",
      });
      expect(p.stderr.toString()).toBe("");
      const desktop = readFileSync(join(dir, "agentglass.desktop"), "utf8");
      expect(desktop).toContain("Exec=/opt/orbit/agentglass %u\n");
      expect(desktop).toContain("MimeType=x-scheme-handler/agentglass;\n");
      expect(desktop).not.toContain("#");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
