/*
 * A linked pull request opens in the app; a started issue opens its window.
 *
 * Linked pull requests on issues and cards opened the browser, and a started
 * issue said "Open it in the terminal." with nothing to press.
 */
import { describe, expect, test } from "bun:test";
import { prRef, repoOf } from "../src/model/prRef.ts";
import { paneFor } from "../src/model/checkout.ts";

const read = (rel: string): Promise<string> => Bun.file(new URL(rel, import.meta.url)).text();
const issue = await read("../app/issue/[number].tsx");
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");
const card = await read("../app/card/[id].tsx");

describe("prRef", () => {
  test("a pull request link names its repository and number", () => {
    expect(prRef("https://github.com/acme/orbit/pull/482")).toEqual({ repo: "acme/orbit", number: 482 });
    expect(prRef("https://github.com/acme/orbit/pull/482/files#diff-1")).toEqual({ repo: "acme/orbit", number: 482 });
  });
  test("anything else is not one, and goes to the browser", () => {
    expect(prRef("https://github.com/acme/orbit/issues/231")).toBeNull();
    expect(prRef("https://example.com/acme/orbit/pull/1")).toBeNull();
    expect(prRef("https://github.com/acme/orbit/pull/12x")).toBeNull();
  });
  test("an issue's own link says which repository it is in", () => {
    expect(repoOf("https://github.com/Acme/Orbit/issues/231")).toBe("acme/orbit");
  });
});

describe("paneFor", () => {
  const tabs = [
    { label: "1 claude", where: "/w/orbit" },
    { label: "2 i231", where: "/w/orbit-wt/i231" },
    { label: "3 build", where: "/w/orbit-wt/i231/src" },
  ];
  test("the window the work was given, by name", () => {
    expect(paneFor(tabs, "/w/orbit-wt/i231", "i231")?.label).toBe("2 i231");
  });
  test("its directory, when the window was renamed", () => {
    expect(paneFor(tabs, "/w/orbit-wt/i231", "gone")?.label).toBe("2 i231");
  });
  test("nothing, when the strip does not have it yet", () => {
    expect(paneFor(tabs, "/w/lantern", "i41")).toBeNull();
  });
  test("a split pane's suffix is not part of the name", () => {
    expect(paneFor([{ label: "4 i231·p2", where: "/x" }], "/elsewhere", "i231")?.label).toBe("4 i231·p2");
  });
});

describe("the screens, read", () => {
  test("neither detail sends a linked pull request to the browser directly", () => {
    expect(issue).toContain("openLinkedPr(host, router, pr.url");
    expect(card).toContain("openLinkedPr(host, router, pr.url)");
  });
  test("a started issue has a button, not a sentence", () => {
    expect(issue).toContain('label="Open in terminal"');
    expect(code(issue)).not.toContain("Open it in the terminal.");
  });
});
