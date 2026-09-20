/*
 * A link on a web page can ask this app to install a plugin. That sentence is
 * the whole attack surface, so it is pinned here.
 *
 * What the link may do: open the window and put a URL in the install box.
 * What it may not do: install, enable, name a local path, or reach anything
 * other than the one route it was built for. The parsing lives in the main
 * process because a malformed link should die where it can simply be dropped,
 * and these read that parser rather than a description of it.
 */
import { describe, expect, test } from "bun:test";

const MAIN = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();
const APP = await Bun.file(new URL("../../web/src/App.tsx", import.meta.url)).text();
const PANE = await Bun.file(new URL("../../web/src/components/PluginsPane.tsx", import.meta.url)).text();

/** A function of `main.js`, from its declaration to the first `}` at the
 *  start of a line — never a fixed window. */
function fn(name: string): string {
  const at = MAIN.indexOf(`function ${name}(`);
  expect(at, `${name} moved`).toBeGreaterThan(-1);
  const end = MAIN.indexOf("\n}", at);
  return MAIN.slice(at, end + 2);
}

/** The parser, run the way the main process runs it. It is plain JavaScript
 *  over a URL, so it can be lifted out and exercised rather than described. */
const parse = new Function("APP_SCHEME", `${fn("parseDeepLink")}; return parseDeepLink;`)("agentglass") as
  (link: string) => { kind: string; url: string } | null;

describe("what a deep link may ask for", () => {
  test("a plugin's https URL, and that is the whole vocabulary", () => {
    expect(parse("agentglass://plugin/install?url=https%3A%2F%2Fgithub.com%2Facme%2Forbit-lint"))
      .toEqual({ kind: "plugin-install", url: "https://github.com/acme/orbit-lint" });
    for (const other of [
      "agentglass://plugin/enable?name=orbit-lint",
      "agentglass://plugin/install",
      "agentglass://app/settings",
      "agentglass://terminal/run?cmd=rm",
      "https://github.com/acme/orbit-lint",
      "agentglass:plugin/install?url=https://github.com/acme/orbit-lint",
    ]) {
      expect(parse(other), other).toBeNull();
    }
  });

  test("a local path is not a URL it will carry", () => {
    /* `installPlugin` takes an absolute path as happily as a git URL. A link
       that could name one would let a page point the install box at somebody's
       home directory — at a folder they downloaded, at /etc. */
    for (const url of ["/home/somebody/.ssh", "file:///etc", "http://example.com/p.git", "../../etc"]) {
      expect(parse(`agentglass://plugin/install?url=${encodeURIComponent(url)}`), url).toBeNull();
    }
  });

  test("the app's own origin is never a deep link, whatever follows it", () => {
    // It closes over the scheme, the app's own origin and the length cap, so
    // it is rebuilt with all three rather than imported.
    const pick = new Function("APP_SCHEME", "APP_ORIGIN", "DEEP_LINK_MAX", `${fn("deepLinkFrom")}; return deepLinkFrom;`)(
      "agentglass", "agentglass://app", 2048) as (argv: string[]) => string | null;
    expect(pick(["agentglass://app/index.html"])).toBeNull();
    expect(pick(["agentglass://app"])).toBeNull();
    expect(pick(["/usr/bin/agentglass", "agentglass://plugin/install?url=https://x.example/p"]))
      .toBe("agentglass://plugin/install?url=https://x.example/p");
    // A megabyte of link is not a link.
    expect(pick([`agentglass://plugin/install?url=https://x.example/${"a".repeat(4000)}`])).toBeNull();
  });
});

describe("what happens to it in the window", () => {
  test("it fills the install box and waits for the person", () => {
    expect(APP, "the window opens the pane rather than installing").toContain("requestPluginInstall(link.url)");
    expect(APP).toContain('openSettings("plugins")');
    expect(PANE).toContain("prefill={prefill}");
    // The install call belongs to the button, not to the link.
    const effect = APP.slice(APP.indexOf("followDeepLinks("), APP.indexOf("followDeepLinks(") + 400);
    expect(effect).not.toContain("pluginInstall(");
    expect(effect).not.toContain("enable");
  });

  test("the scheme is claimed only by an installed app", () => {
    /* From a checkout the executable is Electron itself with this directory as
       an argument; registering that would point the whole scheme at whatever
       ran last. */
    const ready = MAIN.slice(MAIN.indexOf("app.whenReady()"), MAIN.indexOf("app.whenReady()") + 1200);
    expect(ready).toContain("app.isPackaged");
    expect(ready).toContain("setAsDefaultProtocolClient");
  });
});
