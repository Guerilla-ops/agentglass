/*
 * What a dictated sentence does to the line somebody is composing.
 *
 * The rule that matters is the space. A transcript joined without one turns
 * `git commit -m` plus "fix the thing" into `git commit -mfix the thing` — a
 * flag nobody typed, in a command that will run.
 */
import { describe, expect, test } from "bun:test";
import {
  dictationDestination, joinDictated, joinDictatedInto, nameFor, wordsFrom,
} from "../src/terminal/dictation.ts";

describe("reading the answer", () => {
  test("words come back as words", () => {
    expect(wordsFrom({ ok: true, text: "  run the tests  " })).toEqual({ text: "run the tests" });
  });

  test("ok with nothing said is an error, not an empty insert", () => {
    // The same trap as the image upload: trusting `ok` alone puts "undefined"
    // in somebody's field.
    expect("error" in wordsFrom({ ok: true })).toBe(true);
    expect("error" in wordsFrom({ ok: true, text: "   " })).toBe(true);
  });

  test("the computer's own words survive a refusal", () => {
    // "no transcriber on this computer" is the whole point of the message —
    // flattening it to "failed" is what makes a feature look broken instead of
    // uninstalled.
    expect(wordsFrom({ ok: false, error: "no transcriber on this computer" }))
      .toEqual({ error: "no transcriber on this computer" });
  });

  test("no answer at all says so", () => {
    expect("error" in wordsFrom(null)).toBe(true);
    expect("error" in wordsFrom(undefined)).toBe(true);
  });
});

describe("joining it to what is there", () => {
  test("an empty field takes the words with no leading space", () => {
    expect(joinDictated("", "run the tests")).toBe("run the tests");
  });

  test("a space is added when the field does not end in one", () => {
    expect(joinDictated("git commit -m", "fix the thing")).toBe("git commit -m fix the thing");
  });

  test("a space already there is not doubled", () => {
    expect(joinDictated("git commit -m ", "fix the thing")).toBe("git commit -m fix the thing");
    expect(joinDictated("echo\t", "hello")).toBe("echo\thello");
  });

  test("nothing dictated leaves the field exactly as it was", () => {
    // Including its trailing space, which somebody typed on purpose.
    expect(joinDictated("git checkout ", "")).toBe("git checkout ");
    expect(joinDictated("git checkout ", "   ")).toBe("git checkout ");
  });

  test("it appends rather than replaces", () => {
    // Dictating is one part of writing a line, not the whole of it — which is
    // the reason the transcript is not sent by itself either.
    expect(joinDictated("one", "two")).toContain("one");
  });
});

describe("which destination a transcript goes to", () => {
  test("compose when the screen is not in live mode", () => {
    expect(dictationDestination(false)).toBe("compose");
  });

  test("live when the screen is", () => {
    expect(dictationDestination(true)).toBe("live");
  });
});

describe("joining it into that destination", () => {
  test("compose behaves exactly like joinDictated", () => {
    expect(joinDictatedInto("compose", "git commit -m", "fix the thing"))
      .toBe(joinDictated("git commit -m", "fix the thing"));
  });

  test("live joins the same way when there is nothing to flatten", () => {
    expect(joinDictatedInto("live", "ls ", "the tests")).toBe("ls the tests");
  });

  // The bug this whole function exists to close: the live destination is
  // keystrokes on a pane's stdin with no submit step of its own, so a
  // transcript carrying a line break — either engine has been seen to model a
  // pause that way — must never put one there. Broken on purpose first: drop
  // the `.replace` in `joinDictatedInto` and this goes red with a literal \n
  // in the result.
  test("live never contains \\r or \\n, however the transcript arrived", () => {
    const cases = [
      "run the tests\n",
      "run the tests\r\n",
      "first line\nsecond line",
      "windows style\r\nline two",
      "\ntrailing thought",
    ];
    for (const dictated of cases) {
      const got = joinDictatedInto("live", "", dictated);
      expect(got).not.toContain("\r");
      expect(got).not.toContain("\n");
    }
  });

  test("live still applies the spacing rule after flattening", () => {
    expect(joinDictatedInto("live", "git commit -m", "fix the thing\n"))
      .toBe("git commit -m fix the thing");
  });

  test("compose is untouched by the live-only flattening — a real newline stays", () => {
    // Compose is the field somebody edits before sending, so nothing about
    // its content needs to be dangerous the way an un-gated live send is.
    expect(joinDictatedInto("compose", "", "line one\nline two"))
      .toBe("line one\nline two");
  });
});

describe("what the file is called", () => {
  test("the recorder's own extension is kept", () => {
    // It decides how the file is written on the other side, and a recording
    // called .m4a that is really webm is one whisper opens and rejects.
    expect(nameFor("file:///tmp/rec.m4a")).toBe("speech.m4a");
    expect(nameFor("file:///tmp/rec.WAV")).toBe("speech.wav");
    expect(nameFor("file:///tmp/rec.webm?x=1")).toBe("speech.webm");
  });

  test("an unknown or absent one falls back rather than passing it on", () => {
    expect(nameFor("file:///tmp/rec.bin")).toBe("speech.m4a");
    expect(nameFor("")).toBe("speech.m4a");
  });
});
