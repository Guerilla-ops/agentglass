/*
 * What is left of the plan, on every header.
 *
 * It was a card at the bottom of Settings, three taps from anywhere, and the
 * question it answers — can I start a long one — is asked right before
 * starting one. These hold the three things that make the chip honest: it is
 * on every destination, it draws nothing it does not have, and there is one
 * poll behind however many of it are mounted.
 */
import { describe, expect, test } from "bun:test";
import { windowName } from "../src/model/quota.ts";

const read = (rel: string): Promise<string> => Bun.file(new URL(rel, import.meta.url)).text();
const usage = await read("../src/usage/Usage.tsx");
const hook = await read("../src/state/use-usage.ts");
const tabs = await read("../app/(tabs)/_layout.tsx");
const root = await read("../app/_layout.tsx");
const settings = await read("../app/(tabs)/settings.tsx");

const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("the chip", () => {
  test("is on the header of every destination that draws the navigator's header", () => {
    const trailing = tabs.slice(tabs.indexOf("const trailing ="), tabs.indexOf("const back ="));
    expect(trailing).toContain("<UsageChip />");
    expect(tabs).toContain("headerRight: () => trailing");
  });

  test("draws nothing until there is a window to draw", () => {
    const body = code(usage.slice(usage.indexOf("export function UsageChip("), usage.indexOf("function Meter(")));
    expect(body).toMatch(/const top = tightestWindow\(rows\);\s*if \(!top\) return null;/);
  });

  test("names a window the way a person says it", () => {
    expect(windowName("5h")).toBe("5-hour");
    expect(windowName("weekly")).toBe("Weekly");
    expect(windowName("Opus weekly")).toBe("Opus weekly");
  });
});

describe("one poll", () => {
  test("the hook reads a provider, and the provider is mounted once at the root", () => {
    const useUsage = code(hook.slice(hook.indexOf("export function useUsage(")));
    expect(useUsage).toContain("useContext(UsageContext)");
    expect(useUsage).not.toContain("setInterval");
    expect(root).toMatch(/<HostProvider>\s*<UsageProvider>/);
  });

  test("and Settings no longer carries a copy of the plan", () => {
    expect(code(settings)).not.toContain("useUsage");
  });
});
