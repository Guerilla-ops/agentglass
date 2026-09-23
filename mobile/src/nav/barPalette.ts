/*
 * The palette the bar wears under the terminal.
 *
 * The terminal is one surface in the pane's colours from its header to its
 * composer, and the bar is the last strip of that screen: drawn in the phone's
 * palette it put the seam back, one row lower. The terminal says what it is
 * wearing here, and the bar wears it while the terminal is the destination on
 * screen. Every other destination is the phone's, so nothing else sets this.
 *
 * A module value with listeners rather than context: the bar and the terminal
 * are siblings under the navigator, and the terminal's palette changes only
 * when the computer's theme does.
 */
import { useSyncExternalStore } from "react";
import type { Palette } from "../theme.ts";

let current: Palette | null = null;
const listeners = new Set<() => void>();

export function setTerminalPalette(next: Palette | null): void {
  if (next === current || (next && current && JSON.stringify(next) === JSON.stringify(current))) return;
  current = next;
  for (const fn of [...listeners]) fn();
}

export function useTerminalPalette(): Palette | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => current,
  );
}

/** Whether a background is dark, for the status bar's icons over it. The
 *  relative luminance of the sRGB colour, against the midpoint. */
export function isDark(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const n = parseInt(m[1]!, 16);
  const lin = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L < 0.18;
}
