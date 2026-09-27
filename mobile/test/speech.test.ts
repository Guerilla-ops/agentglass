/*
 * The pure rules behind dictation: which engine runs, and how a live
 * transcript is shown while it is still arriving.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "../src/lib/host.ts";

// react-native's entry point is Flow, not TypeScript, and importing it under
// `bun test` is a syntax error — see test/keep-alive.test.ts's identical
// comment. speech.ts wants exactly Platform.OS, a constant, so it is stood up
// rather than the module. speech.ts itself is imported dynamically below,
// after this call, rather than with a static `import` at the top: a static
// import is hoisted above this mock and would load the real react-native
// first.
mock.module("react-native", () => ({ Platform: { OS: "android" } }));

let speech: typeof import("../src/terminal/speech.ts");

beforeAll(async () => {
  speech = await import("../src/terminal/speech.ts");
});

const host: Host = {
  origin: "http://192.168.7.20:4000",
  token: "a-device-token",
  label: "Test phone",
  scope: "full",
  pairedAt: 0,
};

describe("voicePlan", () => {
  test("the on-device recognizer wins when it is there", () => {
    expect(speech.voicePlan({ onDevice: true, whisper: true })).toBe("device");
  });

  test("falls back to whisper when there is no on-device recognizer", () => {
    expect(speech.voicePlan({ onDevice: false, whisper: true })).toBe("whisper");
  });

  test("neither available says so, with a message explaining both gaps", () => {
    const plan = speech.voicePlan({ onDevice: false, whisper: false });
    expect(typeof plan).toBe("object");
    expect((plan as { unavailable: string }).unavailable.length).toBeGreaterThan(0);
  });

  test("exact precedence: on-device beats whisper even when both are there", () => {
    expect(speech.voicePlan({ onDevice: true, whisper: false })).toBe("device");
    expect(speech.voicePlan({ onDevice: true, whisper: true })).toBe("device");
  });
});

describe("applyPartial", () => {
  test("an empty base takes the first partial with no leading space", () => {
    expect(speech.applyPartial("", "run the")).toBe("run the");
  });

  test("a later partial REPLACES the one before it, not appends to it", () => {
    // The caller passes the same base each time and a fresh partial — so two
    // partials in a row must not accumulate into "run the run the tests".
    const base = "";
    const first = speech.applyPartial(base, "run the");
    const second = speech.applyPartial(base, "run the tests");
    expect(second).toBe("run the tests");
    expect(second).not.toContain("run the run the");
    void first;
  });

  test("applies on top of text already in the field, with the same spacing rule", () => {
    expect(speech.applyPartial("git commit -m", "fix the thing")).toBe("git commit -m fix the thing");
    expect(speech.applyPartial("git commit -m ", "fix the thing")).toBe("git commit -m fix the thing");
  });

  test("an empty partial leaves the base untouched", () => {
    expect(speech.applyPartial("git commit -m ", "")).toBe("git commit -m ");
  });

  test("a final result lands in the draft but never carries a send", () => {
    // This composer sends on a carriage return appended by the caller — a
    // committed transcript must never itself contain one, or inserting it
    // would submit whatever else was on the line.
    const committed = speech.applyPartial("run the tests", "please");
    expect(committed).not.toMatch(/[\r\n]/);
  });
});

describe("whisperAvailable", () => {
  const realFetch = globalThis.fetch;
  let answer: () => Response;

  beforeEach(() => {
    speech.__resetWhisperCache();
    answer = () => new Response("{}", { status: 200 });
    globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(answer())) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    speech.__resetWhisperCache();
  });

  test("true when /dependencies reports whisper installed", async () => {
    answer = () => Response.json({ deps: [{ id: "whisper", status: "ok" }] });
    expect(await speech.whisperAvailable(host)).toBe(true);
  });

  test("false when whisper is missing or the row is absent", async () => {
    answer = () => Response.json({ deps: [{ id: "whisper", status: "missing" }] });
    expect(await speech.whisperAvailable(host)).toBe(false);
    speech.__resetWhisperCache();
    answer = () => Response.json({ deps: [] });
    expect(await speech.whisperAvailable(host)).toBe(false);
  });

  test("the answer is fetched once and cached, not re-asked on every call", async () => {
    let calls = 0;
    answer = () => { calls++; return Response.json({ deps: [{ id: "whisper", status: "ok" }] }); };
    await speech.whisperAvailable(host);
    await speech.whisperAvailable(host);
    expect(calls).toBe(1);
  });

  test("each computer has its own answer", async () => {
    answer = () => Response.json({ deps: [{ id: "whisper", status: "ok" }] });
    expect(await speech.whisperAvailable(host)).toBe(true);
    answer = () => Response.json({ deps: [] });
    expect(await speech.whisperAvailable({ ...host, origin: "http://192.168.7.21:4000" })).toBe(false);
    expect(await speech.whisperAvailable(host)).toBe(true);
  });

  test("a failed ask is not cached: the next call asks again", async () => {
    answer = () => new Response("", { status: 500 });
    expect(await speech.whisperAvailable(host)).toBe(false);
    answer = () => Response.json({ deps: [{ id: "whisper", status: "ok" }] });
    expect(await speech.whisperAvailable(host)).toBe(true);
  });

  test("a computer that cannot be reached is not whisper available", async () => {
    answer = () => new Response("", { status: 500 });
    expect(await speech.whisperAvailable(host)).toBe(false);
  });
});

const kt = readFileSync(
  join(import.meta.dir, "..", "modules/agx-speech/android/src/main/java/app/agentglass/speech/SpeechModule.kt"),
  "utf8",
);

/** Source of one `Name("...") { ... }` block in the module, up to the end of the
 *  line its own closing brace is on (a chained `.runOnQueue` counts), comment lines stripped. */
function block(open: string): string {
  const from = kt.indexOf(open);
  expect(from).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = kt.indexOf("{", from); i < kt.length; i++) {
    if (kt[i] === "{") depth++;
    if (kt[i] === "}" && --depth === 0) {
      return kt.slice(from, kt.indexOf("\n", i)).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    }
  }
  throw new Error("unclosed block");
}

describe("SpeechModule.kt threading", () => {
  // A SpeechRecognizer belongs to the thread that made it. stop/cancel ran on
  // the bridge thread, threw inside their own try, and the throw was swallowed:
  // the second press did nothing at all.
  test("stop and cancel run on the main queue", () => {
    expect(block('AsyncFunction("stop")')).toContain("runOnQueue(Queues.MAIN)");
    expect(block('AsyncFunction("cancel")')).toContain("runOnQueue(Queues.MAIN)");
  });

  test("teardown on module destroy is posted to the main looper", () => {
    const destroy = block("OnDestroy");
    expect(destroy).toContain("Looper.getMainLooper()");
    expect(destroy).toContain("teardown()");
  });
});

describe("SpeechModule.kt start() failure paths", () => {
  // The unavailable branch sent onError and returned. JS only clears its
  // "listening" state on onEnd, so the button stayed stuck listening.
  test("every onError in start() is followed by onEnd", () => {
    const start = block('AsyncFunction("start")');
    const errors = start.split('sendEvent("onError"').length - 1;
    const ends = start.split('sendEvent("onEnd"').length - 1;
    expect(errors).toBeGreaterThanOrEqual(3);
    expect(ends).toBeGreaterThanOrEqual(errors); // onResults ends too
    const unavailable = start.slice(start.indexOf("isOnDeviceRecognitionAvailable(context))"), start.indexOf("val lang"));
    expect(unavailable).toContain('sendEvent("onEnd"');
  });

  // Expo's AsyncFunction lambda returns `Any?`. A bare `return@AsyncFunction`
  // is `Unit`, and kotlinc refuses the module ("Return type mismatch: expected
  // 'Any?', actual 'Unit'"), so the release APK does not build at all.
  test("early returns inside start() return a value", () => {
    const start = block('AsyncFunction("start")');
    expect(start).toContain("return@AsyncFunction");
    expect(start).not.toMatch(/return@AsyncFunction\s*$/m);
  });

  test("error messages are full sentences", () => {
    expect(kt).not.toContain('"microphone not allowed"');
    expect(kt).not.toContain('"No on-device speech recognizer on this phone"');
    expect(kt).not.toContain('"Speech recognition could not start"');
  });
});

describe("SpeechModule.kt missing language model", () => {
  // Error 13 (API 33+) means the model for this language is not downloaded.
  // The message told the person to go add it by hand while the platform can
  // start that download itself.
  test("error 13 triggers the model download before the engine is torn down", () => {
    const start = block('AsyncFunction("start")');
    const onError = start.slice(start.indexOf("override fun onError"));
    const download = onError.indexOf("engine.triggerModelDownload(intent)");
    expect(download).toBeGreaterThan(-1);
    expect(onError.indexOf("error == 13")).toBeGreaterThan(-1);
    expect(onError.indexOf("error == 13")).toBeLessThan(download);
    expect(download).toBeLessThan(onError.indexOf("teardown()"));
    expect(start.indexOf("val intent")).toBeLessThan(start.indexOf("override fun onError"));
  });
});

const terminalSrc = await Bun.file(join(import.meta.dir, "..", "app/(tabs)/terminal.tsx")).text();

describe("terminal.tsx asks whisper only when the phone cannot dictate", () => {
  test("whisperAvailable is behind the on-device answer", () => {
    const line = terminalSrc.split("\n").find((l) => l.includes("voicePlan({"));
    expect(line).toBeDefined();
    expect(line).toMatch(/onDevice \? false : await whisperAvailable\(host\)/);
  });
});
