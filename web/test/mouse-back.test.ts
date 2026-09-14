/**
 * Button 3 is back and button 4 is forward in the DOM's numbering — which is
 * not the order the platform's own names are in, so the two are easy to swap
 * and the swap is invisible until somebody with a five-button mouse tries it.
 */
import { test, expect } from "bun:test";
import { isBackButton, isForwardButton } from "../src/lib/mouseBack.ts";

test("the thumb buttons are told apart by index", () => {
  expect(isBackButton({ button: 3 })).toBe(true);
  expect(isForwardButton({ button: 4 })).toBe(true);
  expect(isBackButton({ button: 4 })).toBe(false);
  expect(isForwardButton({ button: 3 })).toBe(false);
});

test("the ordinary buttons are neither", () => {
  for (const button of [0, 1, 2]) {
    expect(isBackButton({ button })).toBe(false);
    expect(isForwardButton({ button })).toBe(false);
  }
});

test("a press with no index is read off the mask instead", () => {
  /* `mousedown` carries both; a caller that has only the mask still gets an
     answer, and bit 3 is the fourth button. */
  expect(isBackButton({ buttons: 8 })).toBe(true);
  expect(isForwardButton({ buttons: 16 })).toBe(true);
  expect(isBackButton({ buttons: 1 })).toBe(false);
  expect(isBackButton({ buttons: 0 })).toBe(false);
});

test("an index of zero is the left button, not a missing one", () => {
  /* The mask fallback must not fire for a plain left click that happens to
     carry no `buttons` — `button: 0` is an index, and a falsy one. */
  expect(isBackButton({ button: 0, buttons: 8 })).toBe(false);
});

/*
 * And it is wired to the one view that has somewhere to go back TO. A helper
 * nothing calls is a helper that passes its own tests.
 */
test("the pull request page listens for it while one is open", async () => {
  const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
  expect(src).toContain('import { isBackButton } from "../lib/mouseBack.ts";');
  /* Bound on the detail and nowhere else: `selected == null` is the list, and
     there the gesture has nothing to mean. */
  expect(src).toMatch(/if \(selected == null\) return;[\s\S]{0,900}?addEventListener\("auxclick", go\)/);
  /* The press is prevented too, or the platform turns it into a navigation of
     its own before the click ever arrives. */
  expect(src).toMatch(/addEventListener\("mousedown", stop\)/);
  /* And both are taken off again — a window listener that outlives the view is
     a gesture that fires on a page it was never meant for. */
  expect(src).toMatch(/removeEventListener\("auxclick", go\)/);
  expect(src).toMatch(/removeEventListener\("mousedown", stop\)/);
});
