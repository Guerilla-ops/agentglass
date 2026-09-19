/**
 * Which Taskwarrior stores this writes to.
 *
 * 3.x was refused for a while, on two doubts about TaskChampion's store that did
 * not survive measurement against 3.5 — and the refusal left every Arch-based
 * desktop, whose Taskwarrior is 3.x, with a task list it could read and never
 * change. An unknown major stays refused: a store format that moves again gets
 * measured before it is written to.
 */
import { test, expect } from "bun:test";
import { writableVersion } from "../src/tasks.ts";

test("2.x and 3.x are written to", () => {
  for (const v of ["2.6.2", "2.5.1", "3.0.0", "3.5.0"]) expect(writableVersion(v), v).toBe(true);
});

test("an unmeasured major, or no version at all, is not", () => {
  for (const v of ["4.0.0", "1.9.4", "", undefined]) expect(writableVersion(v as string | undefined), String(v)).toBe(false);
});
