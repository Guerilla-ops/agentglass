/*
 * Thirteen drawers, and every one of them has to be reachable.
 *
 * `classify()` returns the FIRST class whose words claim a line, so a class
 * whose words are a subset of an earlier one's can never be returned — it is
 * not a weak class, it is a dead one, and nothing said so. Measured over the
 * local bank before this: C10 ("a review verdict, and the comments under it")
 * shared `review|lgtm|approve` with C4 ("triaging a bot review"), which is
 * asked first, so 160 lines went to C4 and the only 29 that ever reached C10
 * were the ones saying `verdict` or `comment`.
 *
 * And a class's words have to be about its own label. C9 is "whether a pull
 * request is ready to merge" and its words were `halt|stop|abort|para|kill` —
 * which is a drawer about stopping, not about merging, and `para` is the
 * Spanish preposition, so it matched every line with the word "for" in it.
 *
 * The reachability test is the one worth keeping: it fails for a class nobody
 * has broken yet, the next time somebody widens the words of the class above
 * it.
 */
import { describe, expect, test } from "bun:test";
import { CLASS_WORDS, classify } from "../src/understudy.ts";

/** A line that lands in each class, written as somebody would actually say it. */
const SPOKEN: Record<string, string> = {
  C1: "cut a worktree from main before you start",
  C2: "the commit message says why, not what",
  C3: "rebase on top of master, then land it",
  C4: "the bot left a nit, dismiss it and move on",
  C5: "the suite is red on one test",
  C6: "answer the permission prompt with deny",
  C7: "install it locally and see",
  C8: "hand that to a subagent",
  C9: "it is ready to merge once CI is green",
  C10: "lgtm, approve it",
  C11: "the pr body needs its testing criteria",
  C12: "the clickup card has no scope",
  C13: "what to work on next, and why",
};

describe("every class can be reached", () => {
  test("each of the thirteen claims a line of its own", () => {
    for (const [cls] of CLASS_WORDS) {
      expect(SPOKEN[cls], `${cls} has no example line in this test`).toBeDefined();
      expect(classify(SPOKEN[cls]), `${cls} is unreachable — an earlier class claims its words`).toBe(cls);
    }
  });

  test("and no class is a subset of one asked before it", () => {
    // The structural version of the same rule: if every word of a later class
    // is already claimed by an earlier one, it is dead however it is worded.
    const shadowed: string[] = [];
    for (let i = 0; i < CLASS_WORDS.length; i++) {
      const [cls, re] = CLASS_WORDS[i];
      const words = String(re).replace(/^\/\\b\(|\)\\b\/i$/g, "").split("|");
      const reachable = words.some((w) => {
        const probe = w.replace(/\\b|\?|\.\?/g, " ").replace(/\s+/g, " ").trim();
        if (!probe) return false;
        return CLASS_WORDS.slice(0, i).every(([, before]) => !before.test(probe));
      });
      if (!reachable) shadowed.push(cls);
    }
    expect(shadowed.join(", ") || null).toBeNull();
  });
});

describe("the two that were wrong", () => {
  test("a verdict reaches the verdict drawer", () => {
    expect(classify("lgtm")).toBe("C10");
    expect(classify("approve it, the diff is small")).toBe("C10");
    expect(classify("my review verdict is: changes needed")).toBe("C10");
  });

  test("a bot's nit is still the bot drawer", () => {
    expect(classify("the bot is noisy on this one")).toBe("C4");
  });

  test("a Spanish preposition is not a signal", () => {
    // `para` was in C9 and it is the commonest short word in his Spanish.
    expect(classify("esto es para el equipo de reviews el lunes")).not.toBe("C9");
    expect(classify("para el deploy usa el script")).not.toBe("C9");
  });

  test("and readiness to merge is, even though C3 owns the bare word", () => {
    expect(classify("this one is ready to merge")).toBe("C9");
    expect(classify("put it back to draft until CI passes")).toBe("C9");
    // A line that is only about the act of merging stays where it was.
    expect(classify("merge it into master")).toBe("C3");
  });
});
