/*
 * An open fold's body lines up with the rows it sits between.
 *
 * Measured in the settings page on the Agents pane, before the fix: the body
 * had an 18px gutter on its left and 0 on its right, and padding on the
 * bottom only. A block of cards opened inside it therefore read as shoved to
 * one side and jammed under its own header — which is what it looked like on
 * the plugin declaration, where the fold holds three bordered blocks rather
 * than a sentence.
 *
 * The indent is the thing that comes back if nobody holds it down: lining the
 * body up with the label rather than the card looks deliberate in a diff and
 * wrong on screen.
 */
import { describe, expect, test } from "bun:test";

const row = await Bun.file(new URL("../src/components/SettingRow.tsx", import.meta.url)).text();

/** `Fold`'s own body, sliced to its closing brace rather than a fixed window:
 *  this file holds several components and `marginLeft` is legitimate in the
 *  others. */
const fold = (() => {
  const at = row.indexOf("export function Fold(");
  expect(at).toBeGreaterThan(-1);
  return row.slice(at, row.indexOf("\n}\n", at));
})();

const code = fold.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("an open fold", () => {
  test("indents its body no further than the rows around it", () => {
    expect(code).not.toContain("marginLeft");
    expect(code).not.toMatch(/\bml-\[/);
    expect(code).not.toMatch(/\bpl-\[18px\]\s*text-\[12px\]/);
  });

  test("keeps a gap under its own header, not only under itself", () => {
    // pb-3 alone was the bug: the body opened flush against the label.
    expect(code).toMatch(/className="pt-[\d.]+ pb-3 text-\[12px\]/);
  });

  test("the hint still hangs under the label, which is the row's own business", () => {
    // The hint belongs to the header line and stays aligned with the label
    // text; only the body changed.
    expect(fold).toContain('className="block pl-[18px]"');
  });
});
