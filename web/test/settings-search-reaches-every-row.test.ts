/*
 * The old version of this test checked that a row's words were somewhere in
 * its page's `kw` bag — an input to the search, not the search itself, and
 * one a page could satisfy by accident (a word shared with an unrelated
 * row) while still never actually indexing the row it was meant to cover.
 *
 * Search no longer runs on `kw` for a row-level answer at all: it runs on
 * SETTINGS_ROWS, generated straight from the JSX. So the guard this file
 * owes the next reader is stricter and more direct — every literal
 * `label="…"` on a page, read the same way settings-is-a-page.test.ts and
 * gen-settings-index.ts already read this file, actually made it into
 * SETTINGS_ROWS for that pane. A label that did not is a row search can
 * never find no matter what a page's `kw` says.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");

/** The source between one `{show("x") && …}` and the next. A page's content
 *  used to be gated by `pane === "x"`; it is now gated by `show("x")` — the
 *  current page with no query running, or the query's own result set while
 *  one is (see settingsIndex.ts's `show`/`matches` in SettingsModal.tsx) —
 *  so this reads the new marker instead. */
function paneBlocks(): { id: string; body: string }[] {
  const marks = [...src.matchAll(/\{show\("([a-z-]+)"\) &&/g)];
  return marks.map((m, i) => ({
    id: m[1]!,
    body: src.slice(m.index!, i + 1 < marks.length ? marks[i + 1]!.index! : src.length),
  }));
}

/** A conservative subset of gen-settings-index.ts's own row-tag detection:
 *  a literal label directly on one of the primitives this file draws rows
 *  with. Anything the generator resolves through a NAMED SUB-COMPONENT
 *  (`<HooksPane`, `<RemoteAccessPane`) is outside what this file alone can
 *  see, and is not this test's job — the generator's own freshness test
 *  (settings-index-rows.test.ts) covers those. */
const DIRECT_ROW_TAGS = ["SettingRow", "Row", "Toggle", "Fold", "Select", "Stepper", "Choice", "Bulk", "Path", "MiniBtn", "SoundRow"];

function directLabels(body: string): string[] {
  const labels = [...body.matchAll(/(?<!aria-)\blabel="([^"]{1,90})"/g)];
  const out: string[] = [];
  for (const m of labels) {
    const before = body.slice(Math.max(0, m.index! - 500), m.index!);
    const tagMatch = [...before.matchAll(/<([A-Z][A-Za-z0-9]*)(?:<[^<>]*>)?[\s]/g)].pop();
    if (tagMatch && DIRECT_ROW_TAGS.includes(tagMatch[1]!)) out.push(m[1]!);
  }
  return out;
}

describe("every row drawn directly in a pane's own block is in SETTINGS_ROWS", () => {
  const byPane = new Map<string, Set<string>>();
  for (const r of SETTINGS_ROWS) {
    if (!byPane.has(r.pane)) byPane.set(r.pane, new Set());
    byPane.get(r.pane)!.add(r.label);
  }

  for (const { id, body } of paneBlocks()) {
    const labels = directLabels(body);
    if (!labels.length) continue;
    test(`${id}: every direct row label is indexed`, () => {
      const known = byPane.get(id) ?? new Set();
      const missing = labels.filter((l) => !known.has(l));
      expect(["Run `bun run gen:settings-index` in web/ — these rows are missing:", ...missing].join("\n"))
        .toEqual("Run `bun run gen:settings-index` in web/ — these rows are missing:");
    });
  }
});
