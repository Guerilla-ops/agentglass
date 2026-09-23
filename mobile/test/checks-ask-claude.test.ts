/*
 * A red job is one tap from Claude, and only on a phone that may hand it over.
 *
 * The Checks screen does not carry its own copy of the recipe menu: it goes
 * back to the pull request with `ask=1` and that screen opens what it already
 * has. Two rules are asserted against source because there is no renderer:
 * the button is drawn only under the full grant, and the pull request clears
 * the parameter once read, so a later visit does not reopen the menu.
 */
import { describe, expect, test } from "bun:test";

const checks = await Bun.file(new URL("../app/pr/checks.tsx", import.meta.url)).text();
const detail = await Bun.file(new URL("../app/pr/[number].tsx", import.meta.url)).text();

const code = (src: string): string =>
  src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("Checks hands a failure to Claude", () => {
  test("every Ask Claude button on Checks sits behind mayWrite", () => {
    const body = code(checks);
    const buttons = body.match(/label=\{?[^\n]*Ask Claude[^\n]*/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const line of buttons) {
      const at = body.indexOf(line);
      const before = body.slice(Math.max(0, at - 400), at);
      expect(before).toContain("mayWrite");
    }
  });

  test("it goes back to the pull request rather than pushing another", () => {
    const m = code(checks).match(/router\.dismissTo\(\{[^\n]*ask: "1"/);
    expect(m).not.toBeNull();
  });

  test("the pull request opens the menu and clears the parameter", () => {
    const body = code(detail);
    const at = body.indexOf('if (asked !== "1") return;');
    expect(at).toBeGreaterThan(-1);
    const effect = body.slice(at, body.indexOf("}, [asked", at));
    expect(effect).toContain("router.setParams({ ask: undefined })");
    expect(effect).toContain("if (mayWrite) setHanding(true)");
  });
});
