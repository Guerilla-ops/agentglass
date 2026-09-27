/*
 * More than one page can answer a query. `tabScore` used to rank a page by
 * its title and `kw` bag alone; it is now `pageScore` from settingsIndex.ts,
 * which also scores every ROW on the page — a page that owns the row a
 * query names now outranks one that merely mentions the word in its `kw`
 * bag or a stray paragraph. Updated in place, not left pointing at a
 * function that no longer exists in SettingsModal.tsx: the property under
 * test ("exact beats prefix beats substring, title over kw") is unchanged,
 * only which function proves it.
 */
import { describe, expect, test } from "bun:test";
import { pageScore, type SettingsPage } from "../src/lib/settingsIndex.ts";

// A page with no id of its own (not one of the real TABS ids) so its score
// comes only from label/kw — the tier-ordering tests below are about that
// part of pageScore, independent of anything a real page's rows might add.
const page = (label: string, kw: string): SettingsPage => ({ id: "zzz-not-a-real-pane", label, kw });

describe("pageScore ranks a query match instead of taking the first one declared", () => {
  test("an empty query scores everything the same, at zero", () => {
    expect(pageScore(page("Terminal", "scrollback"), "")).toBe(0);
  });

  test("title beats kw, exact beats prefix beats substring, within each tier", () => {
    const exactTitle = pageScore(page("Terminal", ""), "terminal");
    const prefixTitle = pageScore(page("Terminal", ""), "term");
    const subTitle = pageScore(page("Terminal", ""), "rmin");
    const exactKw = pageScore(page("Nothing", "scrollback size"), "scrollback");
    const prefixKw = pageScore(page("Nothing", "scrollback size"), "scroll");
    const subKw = pageScore(page("Nothing", "scrollback size"), "rollb");

    // pageScore's label/kw tiers are flat and word-exact (a page's own title
    // or kw bag is one tier each, not three) — the three-tier exact/prefix/
    // substring ordering now lives on a ROW's label, which real rows carry
    // and this synthetic page does not. A page's title still substring-
    // matches ("term" and "rmin" both find "Terminal"), and kw is an exact
    // word only — "scroll" is not "scrollback" — so a query has to name the
    // row, not merely start typing it, to reach a page through kw alone.
    expect(exactTitle).toBeGreaterThan(exactKw);
    expect(prefixTitle).toBe(exactTitle);
    expect(subTitle).toBe(exactTitle);
    expect(prefixKw).toBe(0);
    expect(subKw).toBe(0);
    expect(exactKw).toBeGreaterThan(prefixKw);
  });

  test("no match anywhere scores zero", () => {
    expect(pageScore(page("Terminal", "scrollback"), "budgets")).toBe(0);
  });

  test("a real row on the page outranks a page whose only hit is its kw bag", () => {
    const terminal: SettingsPage = { id: "terminal", label: "Terminal", kw: "" };
    const nothing = page("Nothing", "font size");
    expect(pageScore(terminal, "font size")).toBeGreaterThan(pageScore(nothing, "font size"));
  });
});
