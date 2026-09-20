/*
 * The plugins page on the site draws a list that strangers write.
 *
 * Two things follow from that and neither is visible in a screenshot: every
 * field goes in as text rather than as markup, because a title is somebody
 * else's string and `innerHTML` would run it; and the list is drawn a page at
 * a time, because a catalogue grows and three thousand cards built in one go
 * block the thread that is scrolling.
 */
import { describe, expect, test } from "bun:test";

const PAGE = await Bun.file(new URL("../../landing/index.html", import.meta.url)).text();

/** The plugins page's own script, from its catalogue fetch to the end of the
 *  block that renders it. Never a fixed window. */
const SECTION = PAGE.slice(PAGE.indexOf("const DRAW = {"), PAGE.indexOf('$("pl-q").addEventListener'));

describe("the plugins page", () => {
  test("draws a page of cards and offers the rest, rather than all of them", () => {
    expect(SECTION).toContain("const PAGE = 24");
    expect(SECTION).toContain("rows.slice(0, shown)");
    expect(SECTION, "and a new search starts at the top again").toContain("shown = PAGE");
  });

  test("says how many matched and how many there are", () => {
    expect(SECTION).toContain('$("pl-count").textContent');
  });

  test("puts a stranger's strings in as text, never as markup", () => {
    /* `el(tag, class, text)` sets textContent. The one `innerHTML` on this
       path is the page's own icon constant, which is markup this repository
       wrote — so the rule is not "no innerHTML", it is that nothing from a
       catalogue entry ever reaches one. A card built the other way would run
       whatever a title carried. */
    const cardFn = SECTION.slice(SECTION.indexOf("const card ="), SECTION.indexOf("const render ="));
    expect(cardFn).not.toContain("insertAdjacentHTML");
    for (const m of cardFn.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
      const assigned = m[1]!.trim();
      expect(assigned, `innerHTML is fed ${assigned}`).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });
});
