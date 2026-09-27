/*
 * The measured case that motivated a row-level, synonym-aware search:
 * typing "chime" found nothing, because "chime" is a word Notifications'
 * `kw` bag happens to carry but a plain substring match against the page
 * title never reaches, and the row itself says "sound", not "chime".
 * pageScore/searchSettings read the ROWS, not a hand-kept bag, and expand a
 * query word through SYNONYMS before giving up on it.
 */
import { describe, expect, test } from "bun:test";
import { pageScore, searchSettings, absentFor, type SettingsPage } from "../src/lib/settingsIndex.ts";
import { readFileSync } from "node:fs";

/** The real TABS table (id/label/kw), read out of SettingsModal.tsx the way
 *  the existing search tests already do — not reimplemented, so a `kw`
 *  edit there shows up here without a second copy to keep in sync. */
function loadPages(): SettingsPage[] {
  const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");
  const re = /\{ id: "([a-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*", kw: "([^"]*)"/g;
  const out: SettingsPage[] = [];
  for (const m of src.matchAll(re)) out.push({ id: m[1]!, label: m[2]!, kw: m[3]! });
  return out;
}

describe("searching by row, with synonyms", () => {
  const pages = loadPages();
  const topPane = (ql: string) => {
    const scored = pages.map((p) => ({ id: p.id, s: pageScore(p, ql) }));
    const top = Math.max(...scored.map((x) => x.s));
    return { id: scored.find((x) => x.s === top)?.id, top };
  };

  test('"sound" lands on notifications, ahead of the window page', () => {
    const { id } = topPane("sound");
    expect(id).toBe("notifications");
    const prefs = pages.find((p) => p.id === "prefs")!;
    const notif = pages.find((p) => p.id === "notifications")!;
    expect(pageScore(prefs, "sound")).toBeLessThanOrEqual(pageScore(notif, "sound"));
  });

  test('"chime" finds the same page as "sound", through the synonym table', () => {
    expect(topPane("chime").id).toBe(topPane("sound").id);
    expect(topPane("chime").top).toBeGreaterThan(0);
  });

  test('"delete" reaches a retention/remove row (via the synonym group), or is answered as absent', () => {
    const hits = searchSettings("delete", pages);
    expect(hits.length).toBeGreaterThan(0);
    expect(absentFor("delete")).toBeNull(); // "delete" is not a known-absent feature; it should find real rows
  });

  test('"proxy" is answered as an absent feature, not "no settings match"', () => {
    const a = absentFor("proxy");
    expect(a).not.toBeNull();
    expect(a!.say).toContain("HTTPS_PROXY");
  });

  test('"font size" lands on terminal', () => {
    expect(topPane("font size").id).toBe("terminal");
  });
});
