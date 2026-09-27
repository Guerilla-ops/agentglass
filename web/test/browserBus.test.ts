/*
 * §9: the isolated contexts, now that an agent can name one.
 *
 * The spec is blunt about why tabs were never enough — "tabs alone are not
 * sufficient: they share a session". Two actors at once, one watching a board
 * while the other changes its state, needs two IDENTITIES. The panel has had
 * profiles the whole time and nothing outside it could address them, which is
 * the same complaint that produced the tab verbs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { onBrowserTabs, serveTabsForTest } from "../src/lib/browserBus.ts";


describe("isolated contexts, addressable at last", () => {
  /*
   * §9. The spec is blunt about why tabs were never enough: "tabs alone are
   * not sufficient: they share a session". Two actors at once — one watching a
   * board while the other changes its state — needs two identities, and the
   * panel has had profiles the whole time with nothing able to name them.
   */
  test("profiles lists what exists", async () => {
    const stop = onBrowserTabs({
      list: () => [],
      select: () => true,
      open: () => ({ id: "t1" }),
      close: () => true,
      profiles: () => ["support", "agent"],
    });
    const r = await serveTabsForTest({ id: "1", op: "profiles", args: {} } as never);
    expect((r.value as any).profiles).toEqual(["support", "agent"]);
    stop();
  });

  test("newtab carries the profile through, or the tab opens as the wrong person", async () => {
    let got: string | undefined = "never called";
    const stop = onBrowserTabs({
      list: () => [],
      select: () => true,
      open: (_url, profile) => { got = profile; return { id: "t1" }; },
      close: () => true,
    });
    await serveTabsForTest({ id: "1", op: "newtab", args: { url: "https://example.com", profile: "support" } } as never);
    expect(got).toBe("support");
    stop();
  });

  test("newtab awaits an async open — `newtab --from-template` mints its partition before the tab exists", async () => {
    // `TabOps.open` returns a Promise when the panel has to ask main for an
    // ephemeral partition first (electron/main.js `ag:tabEphemeralOpen`) —
    // `serveTabs` has to await it rather than reporting `[object Promise]`
    // as the id, which is what a bare `tabs.open(...)` call would do.
    const stop = onBrowserTabs({
      list: () => [],
      select: () => true,
      open: async (url) => {
        await Promise.resolve();
        return { id: `eph-for-${url}` };
      },
      close: () => true,
    });
    const r = await serveTabsForTest({ id: "1", op: "newtab", args: { url: "https://acme.example", ephemeral: true } } as never);
    expect(r.ok).toBe(true);
    expect((r.value as any).id).toBe("eph-for-https://acme.example");
    stop();
  });

  test("and a panel too old to know about profiles still answers", async () => {
    // `profiles` is optional on the interface: an older panel registers
    // without it, and an empty list is a true answer rather than a crash.
    const stop = onBrowserTabs({
      list: () => [], select: () => true, open: () => ({ id: "t1" }), close: () => true,
    });
    const r = await serveTabsForTest({ id: "1", op: "profiles", args: {} } as never);
    expect(r.ok).toBe(true);
    expect((r.value as any).profiles).toEqual([]);
    stop();
  });
});

describe("two agents, two tabs, no crossed evidence", () => {
  /*
   * The isolation was most of the way there and the last step was missing in
   * the worst place. Verbs route to the tab named by `--page`, and profiles
   * give each tab its own cookies and storage — but the CAPTURE went through
   * the shell, and the shell took whichever guest was in front.
   *
   * So agent A asking for a shot of its own tab, while agent B had a different
   * one in front, got back a picture of B's page: right dimensions, plausible
   * content, wrong page, and nothing anywhere saying so. That is the kind of
   * wrong evidence that survives review.
   */
  test("the capture is told which guest, not left to guess", () => {
    const src = readFileSync(new URL("../src/lib/browserBus.ts", import.meta.url), "utf8");
    expect(src, "the capture still goes out without a guest id").toContain("guestIdOf(el)");
  });

  test("the CDP events are drained from the named tab too", () => {
    /* Measured on an isolated instance: an agent on a background tab ran
       Runtime/Network enable, reloaded a page that threw and got a 500, and
       drained zero events: the drain carried no id and main.js read the front
       tab's buffer. */
    const src = readFileSync(new URL("../src/lib/browserBus.ts", import.meta.url), "utf8");
    expect(src, "the drain still goes out without a guest id").toMatch(/browserCdpEvents\(guest/);
    const preload = readFileSync(new URL("../../electron/preload.js", import.meta.url), "utf8");
    expect(preload).toMatch(/cdpEvents: \(guestId\) => ipcRenderer\.invoke\("ag:browserCdp", \{ drain: true, guestId \}\)/);
    const desk = readFileSync(new URL("../src/lib/desktop.ts", import.meta.url), "utf8");
    expect(desk).toContain("b.cdpEvents(guestId)");
  });

  test("and the shell refuses an id it does not know rather than falling back", () => {
    /*
     * A fallback to the active tab is exactly how this bug returns: it would
     * turn "I could not find that tab" back into "here is a picture of some
     * other page". Refusing is the safe way round.
     */
    const main = readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8");
    const at = main.indexOf('ipcMain.handle("ag:captureBrowser"');
    const body = main.slice(at, at + 2500);
    expect(body).toContain("browserGuestById");
    expect(body, "an unknown id falls back to the active tab").toContain("not a browser pane in this window");
  });
});
