/*
 * Which recogniser dictation should use, and how its live transcript is shown
 * while it is still arriving.
 *
 * ── two engines, one button ────────────────────────────────────────────────
 * `dictation.ts` describes the older path: the phone records to a file and the
 * COMPUTER transcribes it with Whisper. That still works, and it is still the
 * only path on a phone with no offline speech pack, or a build reached through
 * Expo Go where the native module below is not there at all. Where an
 * on-device recognizer IS there (see modules/agx-speech), it wins: no upload,
 * no round trip, and no dependency on what happens to be installed on the
 * machine at the other end of the socket. `voicePlan` is the rule for which
 * one runs, and it is pure so the precedence can be tested without a phone or
 * a server.
 *
 * ── the native module is reached the way every optional one is here ───────
 * `requireOptionalNativeModule("AgxSpeech")` inside a function, behind a try —
 * see src/notifications/keepAlive.ts for the same shape and the same reason:
 * a top-level import of a module that might not be linked (iOS, web, Expo Go,
 * an Android build below API 31) takes the whole route tree down with it.
 * test/native-imports.test.ts holds this rule for `expo-notifications`; this
 * file follows it for the same class of risk even though the risky import
 * here is `expo-modules-core` looking a module up, not the package itself.
 *
 * ── inserted, never sent — same rule as dictation.ts ───────────────────────
 * `applyPartial` only ever composes text into the field; it has no way to
 * append the carriage return this app's composer sends on, so a live or final
 * transcript can only ever be typed, never submitted, by anything in this
 * file.
 */
import { Platform } from "react-native";
import type { DepStatus } from "../../../shared/deps.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { joinDictated } from "./dictation.ts";

export interface VoiceAvailability {
  onDevice: boolean;
  whisper: boolean;
}

/** What dictation should do next: run the on-device recognizer, fall back to
 *  the computer's Whisper, or say why neither is there. */
export type VoicePlan = "device" | "whisper" | { unavailable: string };

/**
 * Pure precedence rule: on-device wins whenever it is there, because it needs
 * nothing from the computer and nothing leaves the phone. Whisper is the
 * fallback, never a second choice offered alongside it — a phone that can
 * recognise speech itself has no reason to also make a network round trip for
 * the same sentence.
 */
export function voicePlan({ onDevice, whisper }: VoiceAvailability): VoicePlan {
  if (onDevice) return "device";
  if (whisper) return "whisper";
  return {
    unavailable:
      "This phone has no offline speech pack, and the computer has no Whisper installed — dictation needs one of the two.",
  };
}

/**
 * The live transcript, put into what is already in the field.
 *
 * Reuses `joinDictated`'s spacing rule rather than a second copy of it: the
 * trap is the same one — a transcript run up against existing text with no
 * gap turns `git commit -m` into `git commit -mfix the thing`. What is
 * different here is what the CALLER does with the result: dictation.ts's
 * `joinDictated` is called once, on a final transcript, and its answer
 * becomes the new field. This is called on every partial result as it
 * arrives, always against the SAME `base` (what was in the field before
 * listening started) — so passing a longer partial each time replaces what
 * was shown a moment ago rather than piling partial on top of partial.
 */
export function applyPartial(base: string, partial: string): string {
  return joinDictated(base, partial);
}

/*
 * Whisper availability, read from the same `/dependencies` endpoint
 * Troubleshooting already reads (see app/troubleshoot.tsx and
 * src/model/depLook.ts) — nothing on mobile asked it about `whisper`
 * specifically before this. Fetched once per computer and cached: this is asked every time
 * the mic button might be pressed, and the answer does not change while the
 * terminal screen is open.
 */
const whisperCache = new Map<string, boolean>();

/** Reset for tests — the same shape as keepAlive.ts's __resetKeepAliveModule:
 *  module-scope state has to be resettable or one test's stub leaks into the
 *  next. */
export function __resetWhisperCache(): void {
  whisperCache.clear();
}

interface DependenciesAnswer {
  deps?: { id: string; status: DepStatus }[];
}

/**
 * Is Whisper installed on the paired computer right now?
 *
 * "installed" means the row came back `ok` — `attention` is a version the
 * server itself is not confident dictation will work in, and treating it as
 * available would trade a clear "no on-device pack, no Whisper either"
 * message for a Whisper call that then fails for a reason nobody on the phone
 * can act on. A computer that cannot be reached at all reads the same as
 * whisper not being there, for the same reason: this is asked so `voicePlan`
 * has an answer, not to draw its own error state.
 */
export async function whisperAvailable(host: Host): Promise<boolean> {
  const known = whisperCache.get(host.origin);
  if (known !== undefined) return known;
  const got = await ask<DependenciesAnswer>(host, "/dependencies");
  // A failed ask is "could not find out", not "not installed": caching it
  // would keep dictation off for as long as the screen stayed open after one
  // dropped request. Only an answer from the computer is remembered.
  if (!got.ok) return false;
  const installed = got.value.deps?.find((d) => d.id === "whisper")?.status === "ok";
  whisperCache.set(host.origin, installed);
  return installed;
}

/** The shape `modules/agx-speech`'s Kotlin side exports. `start` is async on
 *  the native side (it has to run on the main queue) but reports through the
 *  four events below rather than through its own resolved value — a phone
 *  saying words for several seconds is not one round trip. */
interface AgxSpeech {
  available(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  addListener(event: "onPartial" | "onFinal", listener: (e: { text: string }) => void): { remove(): void };
  addListener(event: "onError", listener: (e: { code: number; message: string }) => void): { remove(): void };
  addListener(event: "onEnd", listener: () => void): { remove(): void };
}

/** `undefined` until asked, `null` once asked and found missing — same three
 *  states as keepAlive.ts's `native`, and for the same reason: a build
 *  without this native module (Expo Go, iOS, web, or an Android build the
 *  module failed to link into) is not an error to retry. */
let native: typeof import("expo-modules-core") | null | undefined;

function loadCore(): typeof import("expo-modules-core") | null {
  if (native !== undefined) return native;
  try {
    // Required lazily, inside the function, behind a try — see the file
    // comment and keepAlive.ts's version of the same guard.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require("expo-modules-core") as typeof import("expo-modules-core");
  } catch {
    native = null;
  }
  return native;
}

/** Reset for tests: see `__resetWhisperCache` for the same reasoning. */
export function __resetSpeechModule(): void {
  native = undefined;
}

function loadModule(): AgxSpeech | null {
  const core = loadCore();
  if (!core) return null;
  try {
    return core.requireOptionalNativeModule<AgxSpeech>("AgxSpeech");
  } catch {
    return null;
  }
}

/**
 * Whether THIS build even has the on-device recognizer, and whether this
 * phone has a speech pack for it. Android only — the module has no iOS side.
 */
export function onDeviceAvailable(): boolean {
  if (Platform.OS !== "android") return false;
  try {
    return loadModule()?.available() ?? false;
  } catch {
    return false;
  }
}

export interface DictationHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
  onEnd(): void;
}

/** The subscriptions from one `startListening` call, torn down together by
 *  the caller once it is done with them — a screen that unmounts mid-utterance
 *  must not go on calling a handler for a component that is gone. */
export interface DictationSession {
  stop(): void;
  cancel(): void;
  unsubscribe(): void;
}

/**
 * Starts the on-device recognizer and wires its four events to `handlers`.
 * Returns `null` when the module is not there at all — the caller's own job
 * to have checked `onDeviceAvailable()` first and not to have called this
 * otherwise, but a `null` here is a safe no-op rather than a throw.
 */
export function startListening(handlers: DictationHandlers): DictationSession | null {
  const mod = loadModule();
  if (!mod) return null;
  const subs = [
    mod.addListener("onPartial", (e) => handlers.onPartial(e.text)),
    mod.addListener("onFinal", (e) => handlers.onFinal(e.text)),
    mod.addListener("onError", (e) => handlers.onError(e.message)),
    mod.addListener("onEnd", () => handlers.onEnd()),
  ];
  void mod.start().catch((e) => handlers.onError(`Speech recognition would not start: ${String(e)}`));
  return {
    stop: () => { void mod.stop(); },
    cancel: () => { void mod.cancel(); },
    unsubscribe: () => subs.forEach((s) => s.remove()),
  };
}
