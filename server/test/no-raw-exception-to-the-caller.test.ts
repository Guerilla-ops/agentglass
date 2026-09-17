/*
 * An exception's text is not an answer.
 *
 * `String(e)` in a catch reads like honesty and is not: a caught error carries
 * absolute paths on this machine, the shape of a directory tree, the argv of a
 * command, sometimes a stack — and on a machine a phone can reach, the caller
 * is not always the person sitting at it. CodeQL read one of these as
 * `js/stack-trace-exposure` (alert #55, `bench.ts` through `/bench/note`) and
 * there were eleven more of the same shape it had not traced.
 *
 * The rule now: a refusal this app decided is returned as itself, because the
 * sentence is written in this repository. A failure goes through `failed()`,
 * which logs the real error to this process's stderr and hands the caller a
 * sentence naming the operation.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(new URL(".", import.meta.url).pathname, "..", "src");

/** `error: String(e)` and its spellings, anywhere a value is handed back. */
const RAW = /\berror:\s*String\(\s*(e|err|ex|error)\s*\)/;

/** Where the answer a caller actually reads is built: a `json(...)` body, or a
 *  `Response` assembled on the spot. */
const ANSWER = /\bjson\(|new Response\(/;

/** A caught exception's own text inside one, however it is spelled. The rule
 *  above wants `String(` immediately after `error:`, so a `String(e)` dropped
 *  into a sentence — or reached through one more operator — reads as a sentence
 *  the app wrote and is the exception verbatim with a preface on it.
 *
 *  Its ceiling: a bare `e.message` is NOT caught here, because a refusal this
 *  app defines is returned exactly that way — `SourceRefused` and
 *  `IngestRefused` carry sentences written in this repository, which is the one
 *  thing refused.ts says to hand back as itself. Separating those from a
 *  `TypeError` needs to know what the class is, and a line of source does not. */
const RAW_IN_ANSWER = /String\(\s*(?:e|err|ex|error)\b[^)]*\)/;

describe("what a caller is told when something threw", () => {
  test("no module hands back the text of a caught exception", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
        if (RAW.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "use failed(where, e, said) from refused.ts: it logs the real error and answers with a sentence",
    ).toEqual([]);
  });

  test("no route answers with the text of a caught exception", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
        const at = line.search(ANSWER);
        if (at >= 0 && RAW_IN_ANSWER.test(line.slice(at))) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "an HTTP answer is the flow CodeQL traces: failed(where, e, said) instead",
    ).toEqual([]);
  });

  test("failed() logs the real error and returns only the sentence", async () => {
    const { failed } = await import("../src/refused.ts");
    const saw: unknown[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => { saw.push(a); };
    try {
      const said = failed("a/probe", new Error("ENOENT /home/somebody/.ssh/id_rsa"), "that file could not be read");
      expect(said).toBe("that file could not be read");
      expect(said).not.toContain("/home/");
      expect(saw.length, "the real error reaches stderr").toBe(1);
      // The Error itself, not a string of it: an Error JSON-stringifies to
      // `{}`, so the assertion has to look at the object that was logged.
      const logged = (saw[0] as unknown[])[1];
      expect(logged, "and it is the whole error, not the sentence").toBeInstanceOf(Error);
      expect((logged as Error).message).toContain("ENOENT");
    } finally { console.error = real; }
  });
});
