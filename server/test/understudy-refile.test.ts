/*
 * Changing a drawer means re-filing what is already in it.
 *
 * Every precedent carries the class `classify()` gave it the moment it was
 * banked. Widen C10 and narrow C4 without touching the bank and the fix is
 * worse than the bug it fixes: retrieval asks for C10, the lines that now
 * belong to C10 are still sitting in C4 where yesterday's regex put them, and
 * a drawer that was merely wrong becomes wrong and empty.
 *
 * IN A CHILD PROCESS, and that is not ceremony. `bun test` runs every file in
 * one process and db.ts is a singleton bound to whichever file imported it
 * first — so a test that banks rows and deletes them from the precedents table
 * is writing into the database understudy-schema.test.ts is counting rows in.
 * Measured: it left that file asserting 8 matches against 3. Its own process,
 * its own AGENTGLASS_DB, and what comes back is a line of JSON.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNDERSTUDY = new URL("../src/understudy.ts", import.meta.url).pathname;
const DB = new URL("../src/db.ts", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "agx-refile-"));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

/** Run one scenario against a database of its own and give back what it printed. */
function scenario(body: string): Record<string, unknown> {
  const home = mkdtempSync(join(dir, "run-"));
  const script = join(home, "scenario.ts");
  writeFileSync(script, `
import { db } from ${JSON.stringify(DB)};
import { addPrecedent, refileBank } from ${JSON.stringify(UNDERSTUDY)};

/** A row as the ingest writes one — through addPrecedent, so the full-text
 *  index is written beside it the way the app writes it. */
const bank = (cls: string, words: string, ref: string) => addPrecedent({
  cls, partition: "global", situation: "a turn you typed", decision: words.slice(0, 160),
  hisWords: words, source: "test", sourceRef: ref, provenance: "typed", at: Date.now(),
});
const classOf = (ref: string) => db.query("SELECT class FROM understudy_precedents WHERE source_ref = ?").get(ref)?.class ?? null;
const countOf = (ref: string) => db.query("SELECT COUNT(*) AS n FROM understudy_precedents WHERE source_ref = ?").get(ref).n;
const CLASSES = ["C1", "C4", "C9", "C10"];
const out: Record<string, unknown> = {};
${body}
console.log(JSON.stringify(out));
`);
  const r = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      AGENTGLASS_DB: join(home, "refile.db"),
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
      AGENTGLASS_STATE_DIR: home, TMUX_TMPDIR: home,
    },
  });
  const said = r.stdout.toString().trim().split("\n").at(-1) ?? "";
  expect(r.stderr.toString(), "the scenario ran").not.toContain("error:");
  return JSON.parse(said) as Record<string, unknown>;
}

describe("the bank follows the drawers", () => {
  test("a row filed by the old words moves to the class that claims it now", () => {
    const out = scenario(`
      bank("C4", "lgtm, approve it", "verdict-1");
      bank("C9", "esto es para el equipo el lunes", "preposition-1");
      bank("C1", "cut a worktree from main", "left-alone-1");
      out.moved = refileBank("t", CLASSES);
      out.verdict = classOf("verdict-1");
      out.preposition = classOf("preposition-1");
      out.leftAlone = classOf("left-alone-1");
      out.again = refileBank("t", CLASSES);
    `);
    expect(out.moved).toBeGreaterThanOrEqual(2);
    expect(out.verdict).toBe("C10");
    expect(out.preposition).not.toBe("C9");
    // A row already in the right drawer is not touched, and not counted.
    expect(out.leftAlone).toBe("C1");
    // Once per tag: the second boot is a no-op.
    expect(out.again).toBe(0);
  });

  test("a line already filed in the drawer it is moving to is not duplicated", () => {
    // `UNIQUE(source, source_ref, class)`: the same source line can sit in two
    // classes, so a move into one that already holds it throws — and on the
    // real bank the first collision took the whole transaction down with it,
    // leaving 3,343 rows exactly where they were and the marker unwritten.
    const out = scenario(`
      bank("C10", "lgtm, approve it", "both-1");
      bank("C4", "lgtm, approve it", "both-1");
      out.before = countOf("both-1");
      refileBank("t", CLASSES);
      out.after = countOf("both-1");
      out.cls = classOf("both-1");
    `);
    expect(out.before).toBe(2);
    expect(out.after).toBe(1);
    expect(out.cls).toBe("C10");
  });

  test("the full-text index moves with the row", () => {
    // External content, and not one trigger in server/src: a stale entry does
    // not throw, it quietly answers the old class for ever.
    const out = scenario(`
      bank("C4", "my review verdict is: changes needed", "fts-1");
      refileBank("t", CLASSES);
      out.indexed = db.query("SELECT class FROM understudy_precedents_fts WHERE understudy_precedents_fts MATCH 'verdict'").get()?.class ?? null;
    `);
    expect(out.indexed).toBe("C10");
  });

  test("a row with no words of its own is left where it is", () => {
    const out = scenario(`
      addPrecedent({ cls: "C4", partition: "global", situation: "a note", decision: "lgtm approve",
        hisWords: "", source: "test", sourceRef: "wordless-1", provenance: "typed", at: Date.now() });
      refileBank("t", CLASSES);
      out.cls = classOf("wordless-1");
    `);
    // Its summary says "lgtm approve" and would classify as C10. Guessing from
    // a summary is not re-filing, it is re-writing.
    expect(out.cls).toBe("C4");
  });

  test("only the classes that changed are walked", () => {
    // Banked rows keep `his_words` cut at 240 characters, so a long line
    // re-read today can classify differently from the full line classify() saw.
    // Measured on the real bank: walking everything moved 3,343 rows and sent
    // 796 of them to `general`, for classes nobody had complained about.
    const out = scenario(`
      bank("C2", "the commit message says why, and the worktree is already cut", "elsewhere-1");
      out.moved = refileBank("t", ["C4", "C9", "C10"]);
      out.cls = classOf("elsewhere-1");
    `);
    expect(out.moved).toBe(0);
    expect(out.cls).toBe("C2");
  });
});
