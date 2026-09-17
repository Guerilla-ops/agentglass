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
const ANSWER = /\bjson\(|new Response\(/g;

/** Each answer as written: from `json(` or `new Response(` to the parenthesis
 *  that closes it, however many lines that takes. A formatter that wraps the
 *  object does not change what the caller reads, so it must not change what
 *  this file sees either.
 *
 *  Bounded by the call's own parentheses rather than a number of lines, and
 *  measured: two lines miss the plainest wrapped `json({` (three lines), and
 *  three already flag `dictate.ts`, where a `new Response(child.stderr)` is
 *  followed by a `catch` that is not part of it. Over the 812 answers in src,
 *  counting parentheses closes every one where a scan that skips strings,
 *  templates and comments closes it, and none of the 58 that span lines
 *  holds a caught exception's text. */
function answers(src: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const m of src.matchAll(ANSWER)) {
    let depth = 0;
    let end = src.length;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) { end = i + 1; break; }
    }
    out.push({ at: m.index, text: src.slice(m.index, end) });
  }
  return out;
}

/** A caught exception's own text inside one, however it is spelled. The rule
 *  above wants `String(` immediately after `error:`, so a `String(e)` dropped
 *  into a sentence — or reached through one more operator — reads as a sentence
 *  the app wrote and is the exception verbatim with a preface on it.
 *
 *  Its ceiling: a bare `e.message` is NOT caught here, because a refusal this
 *  app defines is returned exactly that way — `SourceRefused` and
 *  `IngestRefused` carry sentences written in this repository, which is the one
 *  thing refused.ts says to hand back as itself. Separating those from a
 *  `TypeError` needs to know what the class is, and a line of source does not.
 *
 *  Two more, also chosen. The parentheses are counted, not parsed: a lone `)`
 *  inside a string or a regex in an answer ends it early and whatever follows
 *  goes unread, and a lone `(` carries it on, where it can fail the suite over code that is not an answer.
 *  And only what is written inside the call is read: `String(e)` put in a
 *  variable first, or returned by a helper a route then answers with, reaches
 *  the caller all the same and is not seen here. Following a value to where it
 *  is sent is data flow, which is CodeQL's job and not a regex's. */
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
    const offenders = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      for (const { at, text } of answers(src)) {
        const hit = RAW_IN_ANSWER.exec(text);
        // The line of the `String(`, not of the `json(` it sits in.
        if (hit) offenders.add(`${f}:${src.slice(0, at + hit.index).split("\n").length}`);
      }
    }
    expect(
      [...offenders],
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
