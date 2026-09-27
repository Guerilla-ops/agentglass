/*
 * CommandBar.tsx already imported openSettings before this and never called
 * it — the "run a project command" box and "go to a setting" were two
 * unconnected boxes for the same kind of question ("where is the thing that
 * does X"). This checks the wiring stayed a source fact rather than an
 * import nobody finished: a page entry and a row entry both actually call
 * openSettings, with a pane (and, for a row, that row's id) rather than a
 * shell command a click would type at the terminal.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/CommandBar.tsx", import.meta.url).pathname, "utf8");

describe("the command palette also opens settings", () => {
  test("imports the generated settings index, not SettingsModal.tsx", () => {
    expect(src).toContain('from "../lib/settingsRows.gen.ts"');
    expect(src).not.toContain('from "./SettingsModal.tsx"');
  });

  test("a page entry calls openSettings with just a pane", () => {
    expect(src).toMatch(/openSettings\(p\.id\)/);
  });

  test("a row entry calls openSettings with a pane AND a row id", () => {
    expect(src).toMatch(/openSettings\(r\.pane,\s*r\.row\)/);
  });

  test("row entries are gated on a non-empty query — the empty palette is not flooded", () => {
    const at = src.indexOf("const settingsRowMatches");
    expect(at).toBeGreaterThan(-1);
    const line = src.slice(at, src.indexOf(";", at));
    expect(line).toContain("ql");
    expect(line).toContain("[]");
  });
});
