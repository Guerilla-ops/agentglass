/*
 * The lane host window (electron/main.js, createLaneHost).
 *
 * The measured reason it is offscreen is in the comment above the function: a
 * hidden window's webview gets no painted frames, so `shot` and `screencast`
 * fail there. These pin the three things that keep that true and keep the
 * window off the person's screen.
 */
import { describe, expect, test } from "bun:test";

const PRELOAD = await Bun.file(new URL("../../electron/preload.js", import.meta.url)).text();
const MAIN = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();

/** The source of `function name(` up to its own closing brace, comments out. */
function body(name: string): string {
  const start = MAIN.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  // From the brace that opens the body, not one in a default parameter.
  for (let i = MAIN.indexOf(") {", start) + 2; i < MAIN.length; i++) {
    if (MAIN[i] === "{") depth++;
    else if (MAIN[i] === "}" && --depth === 0) {
      return MAIN.slice(start, i + 1).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    }
  }
  throw new Error(`unbalanced ${name}`);
}

describe("createLaneHost", () => {
  const host = body("createLaneHost");

  test("is never shown and paints offscreen", () => {
    expect(host).toContain("show: false,");
    expect(host).toContain("offscreen: true,");
    expect(host).toContain("webviewTag: true,");
    expect(host).not.toMatch(/\.show(Inactive)?\(/);
  });

  test("its webviews go through the same guest guard, as a lane, named by its own id", () => {
    expect(host).toContain("guardWebviews(host, { lane: true, laneId: id });");
  });

  test("loads the app as a lane", () => {
    expect(host).toContain("#lane=${encodeURIComponent(id)}");
  });
});

describe("a lane's guest", () => {
  test("never becomes the front tab the zoom and the unaddressed capture use", () => {
    const guard = body("guardWebviews");
    expect(guard).toContain("browserGuests.add(guest);");
    expect(guard).toContain("if (!opts.lane) browserGuest = guest;");
    expect(guard).not.toMatch(/^\s*browserGuest = guest;/m);
  });
});

describe("lanes are made on request, and only by the app's own window", () => {
  test("there is no spike gate any more", () => {
    expect(MAIN).not.toContain("AGENTGLASS_LANE_SPIKE");
  });

  test("ag:laneOpen answers only the app window, validates what it is given, and caps count and memory", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:laneOpen"');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.handle("ag:laneClose"', at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("/^[A-Za-z0-9_-]{1,64}$/.test(id)");
    expect(block).toContain("/^[a-z0-9]{0,16}$/.test(slug)");
    expect(block).toContain("laneHosts.size >= LANE_MAX");
    expect(block).toContain("used > LANE_RSS_MB");
    // The order matters: refuse before making anything.
    expect(block.indexOf("used > LANE_RSS_MB")).toBeLessThan(block.indexOf("createLaneHost(id, slug, ephemeral"));
  });

  test("ag:laneClose answers only the app window too", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:laneClose"');
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.on("ag:deskKey"', at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("destroyLaneHost(id)");
  });

  test("the preload offers both, and nothing that takes a partition name", () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke("ag:laneOpen", id, slug, ephemeral)');
    expect(PRELOAD).toContain('ipcRenderer.invoke("ag:laneClose", id)');
  });

  test("a lane host is handed the desk key although its contents are typed offscreen, and only a lane host", () => {
    expect(MAIN).toContain("const isLaneHost = (wc) => [...laneHosts.values()].some((l) => !l.host.isDestroyed() && l.host.webContents === wc);");
    expect(MAIN).toContain('(e.sender.getType() === "window" || isLaneHost(e.sender)) ? deskKey : null');
  });

  test("a restarted server has no lanes, so their windows go with the old one", () => {
    const fn = body("restartSidecar");
    expect(fn.indexOf("destroyLaneHost(id)")).toBeGreaterThan(-1);
    expect(fn.indexOf("destroyLaneHost(id)")).toBeLessThan(fn.indexOf("killSidecar()"));
  });

  test("a host the server forgot is destroyed on the next heartbeat, and every host goes when the sidecar exits", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:laneKeep"');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.handle("ag:laneClose"', at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("!ids.includes(id) && destroyLaneHost(id)");
    const exit = MAIN.indexOf('child.on("exit", (code, signal) => {');
    expect(MAIN.slice(exit, MAIN.indexOf("if (sidecar !== child || stopped) return;", exit))).toContain("destroyLaneHost(id)");
  });

  test("a lane's guest may not open a window, and a lane host cannot save its bounds as the app's", () => {
    const guard = body("guardWebviews");
    expect(guard).toContain("if (opts.lane) return { action: \"deny\" };");
    // The one thing a lane may do with a window request is fetch an armed
    // download in its own tab (browser-blank-download.test.ts); the denial
    // still precedes anything that opens a tab or a window.
    expect(guard.indexOf("if (opts.lane) return { action: \"deny\" };")).toBeLessThan(guard.indexOf("ag:browser-open-tab"));
    expect(guard.indexOf("if (opts.lane) return { action: \"deny\" };")).toBeLessThan(guard.indexOf('action: "allow"'));
    const at = MAIN.indexOf('ipcMain.on("ag:setWindowBackground"');
    expect(MAIN.slice(at, at + 400)).toContain("if (isLaneHost(e.sender)) return;");
  });

  test("every lane dies with the app's window, or the app would run on with nothing to see", () => {
    const at = MAIN.indexOf('win.on("closed", () => {\n    if (mainWindow === win) mainWindow = null;');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf("});", at));
    expect(block).toContain("destroyLaneHost(id)");
  });

  test("a private lane's jar is wiped when it closes, and only a private one", () => {
    const fn = body("destroyLaneHost");
    expect(fn).toContain("if (l.private) {");
    expect(fn).toContain("clearStorageData()");
    const make = body("createLaneHost");
    expect(make).toContain("private: !ephemeral && slug === id");
  });

  test("the host loads its container after &p=, and none for the person's own", () => {
    expect(body("createLaneHost")).toContain('${ephemeral ? "&t=eph" : slug ? `&p=${slug}` : ""}');
  });
});

describe("S6: an ephemeral lane, seeded from a template, forgets itself on close", () => {
  test("ag:laneOpen validates the ephemeral flag and never asks createLaneHost for a slug alongside it", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:laneOpen"');
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.handle("ag:laneClose"', at));
    expect(block).toContain('typeof ephemeral !== "boolean"');
    expect(block).toContain("createLaneHost(id, slug, ephemeral");
  });

  test("its jar is chosen by the renderer's webview partition, and the host never builds a persist: string for it", () => {
    // LaneHost.tsx (web/test/lane-host.test.ts) is where the partition string
    // itself is built; main.js only ever names the id it belongs to.
    const make = body("createLaneHost");
    expect(make).not.toMatch(/`persist:agentglass-browser-eph-/);
  });

  test("closing one clears its storage AND its cache, same order as a private lane's", () => {
    const fn = body("destroyLaneHost");
    expect(fn).toContain("if (l.ephemeral)");
    // Built through guest-guard.js's own helper, not a second copy of the literal.
    expect(fn).toContain("ephemeralPartition(id)");
    expect(fn).toContain("clearStorageData().then(() => ses.clearCache())");
    expect(MAIN).toContain('require("./guest-guard.js")');
  });

  test("a lane's guest may only attach on the ONE partition its own table entry names, not any family member", () => {
    const guard = body("guardWebviews");
    // Fails closed: no entry (or none passed) is `expected = null`, which no
    // real `webPreferences.partition` string ever equals.
    expect(guard).toContain("const entry = laneId ? laneHosts.get(laneId) : undefined;");
    expect(guard).toContain("entry.ephemeral ? ephemeralPartition(laneId)");
    expect(guard).toContain("entry.slug ? `persist:agentglass-browser-${entry.slug}`");
    expect(guard).toContain(": BROWSER_PARTITION;");
    expect(guard).toContain("if (webPreferences.partition !== expected) { e.preventDefault(); return; }");
  });

  test("a NON-lane window (the app's own) may attach a guest on an ephemeral partition "
    + "ONLY through the decision in guest-guard.js, never by inlining the check again", () => {
    const guard = body("guardWebviews");
    const at = guard.indexOf("if (!opts.lane) {");
    expect(at).toBeGreaterThan(-1);
    const block = guard.slice(at, guard.indexOf("} else {", at));
    expect(block).toContain("mayAttachOnMainWindow(webPreferences.partition, tabEphemerals)");
    // The old blanket refusal is gone from HERE — see the next describe block
    // for where the exception (the window's own tab-ephemeral mint) lives,
    // and web/test/browser-guest-guard.test.ts for the decision itself.
    expect(block).not.toContain("isEphemeralPartition(webPreferences.partition)) { e.preventDefault();");
  });

  test("the host's hash carries the ephemeral marker instead of &p=", () => {
    expect(body("createLaneHost")).toContain("&t=eph");
  });
});

describe("newtab --from-template: the visible-tab twin of an ephemeral lane", () => {
  test("ag:tabEphemeralOpen answers only the app window, caps count, and mints through guest-guard's helper", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:tabEphemeralOpen"');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.handle("ag:tabEphemeralClose"', at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("tabEphemerals.size >= TAB_EPHEMERAL_MAX");
    expect(block).toContain("ephemeralPartition(require(\"crypto\").randomUUID().slice(0, 8))");
    expect(block).toContain("tabEphemerals.add(partition)");
  });

  test("ag:tabEphemeralClose answers only the app window, refuses a partition it never minted, and wipes through the shared helper", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:tabEphemeralClose"');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf("ipcMain.on(\"ag:deskKey\"", at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("!tabEphemerals.has(partition)");
    expect(block).toContain("tabEphemerals.delete(partition)");
    expect(block).toContain("wipeEphemeralPartition(partition)");
  });

  test("a lane's ephemeral wipe and a tab's share one function, not two copies of clearStorageData/clearCache", () => {
    expect(MAIN).toContain("function wipeEphemeralPartition(partition)");
    const lane = body("destroyLaneHost");
    expect(lane).toContain("wipeEphemeralPartition(ephemeralPartition(id));");
    // Only the shared helper calls clearStorageData now — destroyLaneHost's
    // own ephemeral branch does not inline it a second time.
    expect(lane.split("clearStorageData").length - 1).toBe(1); // once, for the private-lane branch
  });

  test("the preload offers both, taking no partition name of its own", () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke("ag:tabEphemeralOpen")');
    expect(PRELOAD).toContain('ipcRenderer.invoke("ag:tabEphemeralClose", partition)');
  });

  test("the app's window may attach on a partition it minted, and guest-guard.js is where that decision is checked", () => {
    // The behaviour itself (allow when minted, refuse a lane's or a guess) is
    // pinned in web/test/browser-guest-guard.test.ts against
    // `mayAttachOnMainWindow` directly — this only pins that main.js reads
    // the SAME table the IPC handlers above write to, not a second one.
    const guard = body("guardWebviews");
    expect(guard).toContain("mayAttachOnMainWindow(webPreferences.partition, tabEphemerals)");
    expect(MAIN).toContain("const tabEphemerals = new Set();");
  });
});
