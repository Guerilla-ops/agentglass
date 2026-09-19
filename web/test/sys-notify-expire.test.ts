/*
 * A popup that closes itself.
 *
 * The notification daemon decides how long one lives when the app does not
 * say, and the one on this desk keeps them until they are dismissed by hand —
 * so a week of "Claude is waiting for your input" sat on screen at once. The
 * durable copy is the bell (recordNote), never the popup.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/lib/sysNotify.tsx".replace(".tsx", ".ts"), import.meta.url)).text();

describe("every desktop popup expires", () => {
  it("closes itself, sooner for news than for a blockage", () => {
    expect(src).toContain("export const POPUP_MS = 8_000;");
    expect(src).toContain("export const BLOCKING_POPUP_MS = 60_000;");
    expect(src).toMatch(/setTimeout\(\(\) => \{ try \{ n\.close\(\); \}[\s\S]{0,120}a\.urgency === 2 \? BLOCKING_POPUP_MS : POPUP_MS\)/);
  });
});
