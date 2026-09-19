/*
 * No "⚙" drawn as text anywhere in the UI.
 *
 * The emoji renders in colour on some systems and as a flat glyph on others,
 * and on either it matches none of the app's line icons: the Commands button
 * wore a blue cog next to a line-drawn clock on the Sessions button beside it.
 * GearIcon in workspace/icons.tsx is the one to use.
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

const root = new URL("../src/", import.meta.url).pathname;
const offenders: string[] = [];
for await (const f of new Glob("**/*.tsx").scan(root)) {
  const src = await Bun.file(root + f).text();
  src.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    if (code.includes("⚙")) offenders.push(`${f}:${i + 1}`);
  });
}

describe("the gear is a line icon", () => {
  it("never the emoji", () => {
    expect(offenders).toEqual([]);
  });
});
