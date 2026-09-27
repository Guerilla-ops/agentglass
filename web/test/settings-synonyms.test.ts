/*
 * SYNONYMS is read both directions: typing "chime" has to reach "sound" rows
 * and typing "sound" has to reach "chime" rows, or a group silently becomes
 * one-way the day somebody edits it without checking both directions by
 * hand. expandWord is the one function that reads the table, so this drives
 * it rather than re-walking SYNONYMS itself.
 */
import { describe, expect, test } from "bun:test";
import { SYNONYMS, expandWord } from "../src/lib/settingsIndex.ts";

describe("synonym groups are bidirectional", () => {
  test("there is more than one group, and every group has more than one word", () => {
    expect(SYNONYMS.length).toBeGreaterThan(3);
    for (const g of SYNONYMS) expect(g.length).toBeGreaterThan(1);
  });

  for (const group of SYNONYMS) {
    for (const word of group) {
      test(`"${word}" expands to every other word in [${group.join(", ")}]`, () => {
        const words = expandWord(word).map((e) => e.word);
        for (const other of group) expect(words).toContain(other);
      });
    }
  }

  test("a word not in any group only expands to itself", () => {
    const words = expandWord("terminal").map((e) => e.word);
    expect(words).toEqual(["terminal"]);
  });

  test("the word typed itself is never marked as a synonym", () => {
    for (const e of expandWord("sound")) if (e.word === "sound") expect(e.synonym).toBe(false);
  });
});
