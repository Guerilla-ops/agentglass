/**
 * Following the desktop's palette must not blink, and must reach the panes.
 *
 * Two things went wrong the first time, both visible on a real desktop within
 * minutes. The poll compared the answer object as well as its stamp, every
 * answer is a new object, so it repainted every three seconds — a repaint
 * rewrites the root's style, every terminal watches that and swaps its whole
 * theme, and the panes blinked on the clock. And the palette was held back
 * from this app's tmux, which paints its own background over the terminal, so
 * the chrome followed the desktop while every pane kept the last theme.
 */
import { test, expect } from "bun:test";

const SRC = await Bun.file(new URL("../src/lib/themes.ts", import.meta.url)).text();
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the poll repaints on a new stamp and nothing else", () => {
  expect(code).toMatch(/if \(changed\) \{/);
  expect(code).not.toMatch(/was !== desktop/);
});

test("the desktop palette is carried out to tmux, once per palette", () => {
  /* The branch that paints it honours `sync`… */
  expect(code).toMatch(/if \(sync\) syncTheme\(desktop as unknown as Theme\)/);
  /* …and the poll sends it only when the stamp differs from the last one sent,
     so a reload with the desktop unchanged repaints no running pane. */
  expect(code).toMatch(/const send = !!desktop && stamp !== sent;/);
  expect(code).toMatch(/localStorage\.setItem\(SYNCED_KEY, stamp\)/);
});
