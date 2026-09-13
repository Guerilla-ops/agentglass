/*
 * Ctrl, Alt and Shift as a latch, and what a key sends while one is up.
 *
 * The bar could always send a Ctrl+C, because Ctrl+C is a byte somebody wrote
 * into a table. What it could not send was a combination nobody had thought of
 * in advance — and the app puts one on screen itself: an agent's permission
 * modes cycle on Shift+Tab, so a bar with Tab on it and no Shift is a bar
 * being asked for a key it does not have.
 *
 * Two rules carry the weight here and both fail quietly if they are wrong:
 *
 *   a latch tapped once is spent by the next key and a locked one is not,
 *   because the difference between those two is the difference between
 *   pressing Shift+Tab three times and pressing it once and then typing two
 *   letters into a control code;
 *
 *   and a key with no encoding for the combination REFUSES rather than sending
 *   itself plain. That one is the reason the bar draws it unavailable, and the
 *   failure it prevents is invisible: a Tab arriving on the line of somebody
 *   who pressed Ctrl first, with nothing to say the Ctrl went nowhere.
 */
import { describe, expect, test } from "bun:test";
import { ACCESSORY_KEYS, keyBytes, sendFor, type AccessoryKey } from "../src/terminal/keys.ts";
import {
  NOTHING_HELD, afterSending, anyHeld, armed, press, spokenState,
} from "../src/terminal/modifiers.ts";

const keyOf = (id: string): AccessoryKey => {
  const key = ACCESSORY_KEYS.find((k) => k.id === id);
  if (!key) throw new Error(`no key ${id}`);
  return key;
};

describe("the latch", () => {
  test("nothing is held to begin with", () => {
    expect(armed(NOTHING_HELD)).toEqual([]);
    expect(anyHeld(NOTHING_HELD)).toBe(false);
  });

  test("taps cycle off, once, locked, off", () => {
    const once = press(NOTHING_HELD, "ctrl");
    expect(once.ctrl).toBe("once");
    const locked = press(once, "ctrl");
    expect(locked.ctrl).toBe("locked");
    expect(press(locked, "ctrl").ctrl).toBe("off");
  });

  test("one key press spends a single tap and leaves a lock alone", () => {
    // The whole of what locking means. Getting this backwards turns the next
    // thing typed after one combination into another one.
    expect(afterSending(press(NOTHING_HELD, "ctrl")).ctrl).toBe("off");
    expect(afterSending(press(press(NOTHING_HELD, "ctrl"), "ctrl")).ctrl).toBe("locked");
  });

  test("they stack, and spend independently", () => {
    let state = press(NOTHING_HELD, "ctrl");            // once
    state = press(press(state, "shift"), "shift");      // locked
    expect(armed(state)).toEqual(["ctrl", "shift"]);

    state = afterSending(state);
    expect(armed(state)).toEqual(["shift"]);
  });

  test("the state it reports back is a new one", () => {
    // NOTHING_HELD is frozen and shared. A press that wrote into it would arm
    // the starting state for the rest of the process — a modifier that seems
    // to turn itself on, which on this bar means a stray control code.
    const before = { ...NOTHING_HELD };
    press(NOTHING_HELD, "alt");
    expect({ ...NOTHING_HELD }).toEqual(before);
  });

  test("a spent press with nothing to spend is the same object", () => {
    const locked = press(press(NOTHING_HELD, "alt"), "alt");
    expect(afterSending(locked)).toBe(locked);
  });

  test("a screen reader is told the state, not just the name", () => {
    expect(spokenState("ctrl", "off")).toBe("Control, off");
    expect(spokenState("ctrl", "once")).toBe("Control, on for the next key");
    expect(spokenState("shift", "locked")).toBe("Shift, locked on");
  });
});

describe("what a key sends while a latch is up", () => {
  test("nothing held is the byte the table always sent", () => {
    expect(sendFor(keyOf("up"), [])).toBe("\x1b[A");
    expect(sendFor(keyOf("ctrlC"), [])).toBe("\x03");
  });

  test("the combination the bar could not send before", () => {
    // Tab plus Shift is reverse tab, which is the key the app's own permission
    // cycle asks for — and the same bytes the preset ⇧Tab has always sent.
    expect(sendFor(keyOf("tab"), ["shift"])).toBe("\x1b[Z");
    expect(sendFor(keyOf("tab"), ["shift"])).toBe(keyOf("shiftTab").bytes ?? null);
  });

  test("modified cursor keys go through the encoder, not a guess", () => {
    expect(sendFor(keyOf("up"), ["ctrl"])).toBe("\x1b[1;5A");
    expect(sendFor(keyOf("left"), ["alt"])).toBe("\x1b[1;3D");
    expect(sendFor(keyOf("right"), ["ctrl", "shift"])).toBe("\x1b[1;6C");
    expect(sendFor(keyOf("home"), ["ctrl"])).toBe("\x1b[1;5H");
    expect(sendFor(keyOf("pageUp"), ["shift"])).toBe("\x1b[5;2~");
  });

  test("alt is a prefixed escape, on the keys that are not CSI", () => {
    expect(sendFor(keyOf("enter"), ["alt"])).toBe("\x1b\r");
    expect(sendFor(keyOf("escape"), ["alt"])).toBe("\x1b\x1b");
  });

  test("a control code refuses the modifier rather than sending itself plain", () => {
    /*
     * ^C IS a Ctrl press. There is nothing for a second one to encode, and the
     * dangerous answer is the quiet one: sending \x03 anyway interrupts a
     * command for somebody who was composing a combination and thought better
     * of it. Null is what makes the bar draw the key unavailable.
     */
    expect(sendFor(keyOf("ctrlC"), ["ctrl"])).toBeNull();
    expect(sendFor(keyOf("ctrlR"), ["alt"])).toBeNull();
    expect(sendFor(keyOf("shiftTab"), ["shift"])).toBeNull();
  });

  test("a macro is text, so it refuses too", () => {
    // Custom keys reach the bar as AccessoryKeys with bytes and no key name.
    const macro: AccessoryKey = { id: "custom:x", label: "gs", bytes: "git status\r", spoken: "gs" };
    expect(sendFor(macro, [])).toBe("git status\r");
    expect(sendFor(macro, ["ctrl"])).toBeNull();
  });

  test("a modifier is never itself a thing that sends", () => {
    for (const id of ["ctrl", "alt", "shift"]) {
      expect(sendFor(keyOf(id), []), id).toBeNull();
      expect(sendFor(keyOf(id), ["ctrl"]), id).toBeNull();
    }
  });

  test("a malformed modifier that also carries bytes still sends nothing", () => {
    /*
     * Not reachable from the catalogue — the invariant test in keys.test.ts
     * forbids this shape — which is exactly why it is asserted here instead.
     * The check that stops it in `sendFor` is unreachable while the catalogue
     * is well formed, so nothing else can tell whether it is still there, and
     * a latch that types a letter every time it is armed is the bug it costs.
     */
    const wrong: AccessoryKey = {
      id: "ctrl", label: "Ctrl", modifier: "ctrl", bytes: "\x03", spoken: "Control",
    };
    expect(sendFor(wrong, [])).toBeNull();
  });

  test("every named key agrees with the encoder for every combination", () => {
    /*
     * The table and the encoder are two sources for one answer, and the way
     * that goes wrong is one key: a `key` name that does not match the bytes
     * beside it sends the wrong thing only when a modifier is up, which is the
     * case nobody presses while checking.
     */
    for (const key of ACCESSORY_KEYS) {
      if (!key.key) continue;
      expect(keyBytes(key.key, []), key.id).toBe(key.bytes!);
      for (const mods of [["ctrl"], ["alt"], ["shift"], ["ctrl", "alt", "shift"]] as const) {
        expect(sendFor(key, mods), `${key.id} ${mods.join("+")}`).toBe(keyBytes(key.key, [...mods]));
      }
    }
  });
});

/*
 * And the one rule that is not in a module: the bar has to ASK.
 *
 * Everything above tests functions. The screen can pass every one of them and
 * still ignore the latch entirely, by going back to sending `key.bytes` the
 * way it did before there was anything to compose with — and the symptom is
 * three buttons that light up when tapped and change nothing, which reads as
 * a broken feature rather than a reverted one.
 *
 * Asserted against the source because there is no renderer here to press a
 * key in. Comments are stripped first: this file's own prose says `sendFor`
 * and `key.bytes` several times over, and a scan that counted those would pass
 * on the strength of the explanation for why it should not.
 */
const SCREEN = await Bun.file(new URL("../app/(tabs)/terminal.tsx", import.meta.url).pathname).text();

const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the bar itself", () => {
  test("sends what the latch says, not the key's own bytes", () => {
    const code = withoutComments(SCREEN);
    expect(code).toContain("sendFor(key, modifiers)");
    expect(code).not.toMatch(/onKey\(key\.bytes/);
  });

  test("the latch starts empty on the screen too", () => {
    // A latch seeded from anything but nothing is a Ctrl nobody pressed.
    expect(withoutComments(SCREEN)).toContain("useState<Latches>(NOTHING_HELD)");
  });
});
