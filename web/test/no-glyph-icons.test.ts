/*
 * An icon is drawn, never typed.
 *
 * The app had over two hundred icons that were characters: emoji (`⚙ 💬 🔒 📌
 * ⏰`) that draw in colour at whatever size the system's emoji font picks, and
 * symbols (`⇄ ☑ ✳ ◍ ⌕ ✎ ⎇ ✦`) that paint about 60% of their font size — beside
 * the line icons of the rail, in the same row. On a desktop whose emoji font is
 * not the one this was built on, a menu of them read as a sticker sheet.
 *
 * Every one of these characters now has a line icon in lib/glyphIcons.tsx or
 * workspace/icons.tsx. This fails when one comes back as text in a component.
 *
 * What stays text, and why, is listed rather than guessed at:
 *   - GitHub's reactions and markdown emoji shortcodes are CONTENT the person
 *     wrote, not the app's chrome;
 *   - the diff's change column (`− → ± ⧉`) is a code, like a git status letter.
 * Keys in shortcut hints (`⌘ ⏎ ⌫`), arrows inside a sentence and status dots
 * are not in the set at all.
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

const ICON_GLYPHS = [..."⚙⇄☑✳◍▤◆⌕⧉↻⟳↺⟲✎⚠★☆✦✨⎇⑂⑃⏰⏱⏳◷⚡💬🔒🔓⚿🔗⛶⤢⤡⊘⛔☐⊙⌗⏣◈◌⌬⌸⊟⊞⛁☰⎌⫴⚐⚑⌂▭▣◉🏷👤👁📁🗀🖥📌🛰🙋✋📱❌🔍🔎🔥✅🤖📎⌨🌙⋯✕＋－◎❞❊ℹ✓◯○"];

/** Content, not chrome — see the header. Matched against the line. */
const ALLOWED: Record<string, RegExp[]> = {
  "components/PrPanel.tsx": [
    /^\s*(tada|white_check_mark|pray|boom):/,            // markdown emoji shortcodes
    /content: "[A-Z_]+", glyph: "/,                        // GitHub's reactions
    /case "copied": return \{ ch: "⧉"/,                    // the diff's change column
  ],
  "lib/prBody.ts": [/^\s*[a-z_+"-]+: "/],                  // markdown emoji shortcodes
  "lib/useLive.ts": [/\.replace\(\/\^/],                   // stripping a server's emoji prefix
};

/** Comments say which glyph a thing replaced; only code is scanned. */
const code = (src: string) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1))
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const root = new URL("../src/", import.meta.url).pathname;
const offenders: string[] = [];
for await (const f of new Glob("**/*.{ts,tsx}").scan(root)) {
  if (f === "lib/glyphIcons.tsx") continue;
  /* `"\u2713"` is a tick too: two of these were written as escapes, and one
     of those sat in JSX text, where an escape is not decoded at all. */
  const lines = code(await Bun.file(root + f).text())
    .replace(/\\u\{?([0-9A-Fa-f]{4,5})\}?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .split("\n");
  lines.forEach((line, i) => {
    if (!ICON_GLYPHS.some((g) => line.includes(g))) return;
    if ((ALLOWED[f] ?? []).some((re) => re.test(line))) return;
    offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 80)}`);
  });
}

describe("an icon is drawn, never typed", () => {
  it("no icon glyph is left as text in the UI", () => {
    expect(offenders).toEqual([]);
  });
});
