/*
 * A start refused because another instance owns the plugin socket must not
 * leak the refused plugin's own grant descriptors.
 *
 * `buildBoxArgv` used to call `openGrantFds` (which opens a real fd per
 * `read`/`write` grant, held open for bwrap to bind-mount) BEFORE awaiting
 * `ensurePluginSocketServer`. When that await throws — a live socket another
 * instance owns, refused rather than stolen — `startProcess`'s catch
 * returned without ever closing `opened.parentFds`: every enable, resume, or
 * settings restart against a socket someone else holds leaked that plugin's
 * open grant fds, one per attempt, for ever (until the process exits).
 *
 * The fix reorders `buildBoxArgv` so the throw happens before any grant fd
 * is opened at all — nothing to leak by construction. This proves it end to
 * end: a real grant, a real live socket standing in for the other instance,
 * a real enable attempt, and `/proc/self/fd` (Linux only, like
 * `openGrantFds` itself) checked for a descriptor pointing at the granted
 * file both before and after.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetPlugins, enablePlugin, installPlugin, MANIFEST_NAME } from "../src/plugins.ts";
import { __resetSandboxProbe, sandboxProbe } from "../src/plugin-sandbox.ts";
import { ensurePluginSocketServer, pluginSocketPath, stopPluginSocketServer } from "../src/plugin-socket.ts";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Every fd this process currently has open onto `path`'s real inode —
 *  Linux-only, same mechanism `openGrantFds` itself verifies with. */
function fdsPointingAt(path: string): number[] {
  const real = realpathSync(path);
  const found: number[] = [];
  for (const entry of readdirSync("/proc/self/fd")) {
    const fd = Number(entry);
    try {
      if (readlinkSync(`/proc/self/fd/${entry}`) === real) found.push(fd);
    } catch {
      /* fd closed between the readdir and the readlink: not a leak, a race with our own process */
    }
  }
  return found;
}

const savedBwrap = process.env.AGENTGLASS_BWRAP;
const savedUnboxed = process.env.AGENTGLASS_PLUGINS_UNBOXED;
const savedHome = process.env.HOME;
afterAll(() => {
  if (savedBwrap === undefined) delete process.env.AGENTGLASS_BWRAP; else process.env.AGENTGLASS_BWRAP = savedBwrap;
  if (savedUnboxed === undefined) delete process.env.AGENTGLASS_PLUGINS_UNBOXED; else process.env.AGENTGLASS_PLUGINS_UNBOXED = savedUnboxed;
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  __resetSandboxProbe();
});

describe("a refused start over a live plugin socket", () => {
  delete process.env.AGENTGLASS_BWRAP;
  __resetSandboxProbe();
  const probe = sandboxProbe();
  const maybe = probe.ok ? test : test.skip;
  if (!probe.ok) console.warn(`fd-leak test skipped: this host cannot build a box (${probe.reason}: ${probe.detail})`);

  let impostor: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(async () => {
    delete process.env.AGENTGLASS_PLUGINS_UNBOXED;
    process.env.XDG_CONFIG_HOME = scratch("agx-fdleak-cfg-");
    await __resetPlugins();
  });

  afterEach(async () => {
    impostor?.stop(true);
    impostor = null;
    stopPluginSocketServer();
    await __resetPlugins();
  });

  maybe("does not leave the plugin's own grant fd open", async () => {
    // Stands in for a second agentglass instance already holding the
    // socket, exactly like plugin-sandbox.test.ts's "refuses to steal a
    // live socket" test — `ensurePluginSocketServer` connects, finds it
    // live, and throws rather than binding over it.
    const path = pluginSocketPath();
    impostor = Bun.serve({ unix: path, fetch: () => new Response("other instance") });

    // Under a scratch HOME, not just any /tmp path: `resolveGrants` refuses
    // an absolute grant that resolves under /tmp UNLESS it is inside HOME's
    // own tree (the narrow exemption a test harness's own scratch home
    // needs) — a bare tmpdir() grant would be refused before it ever got
    // near `openGrantFds`, proving nothing about the fd order this test is
    // for.
    const home = scratch("agx-fdleak-home-");
    process.env.HOME = home;
    const file = join(home, "data.txt");
    writeFileSync(file, "granted-content");

    const before = fdsPointingAt(file).length;

    const src = mkdtempSync(join(tmpdir(), "agx-fdleak-src-"));
    writeFileSync(join(src, MANIFEST_NAME), JSON.stringify({
      name: "orbit-fd-leak", publisher: "acme", description: "idles, boxed, networked",
      entrypoint: "sleep 60", scope: "read",
      // `~/data.txt`, not the absolute scratch path: the manifest-time
      // validator in shared/pluginSandbox.ts refuses any LITERAL /tmp
      // spelling outright, with no home exemption at all (that exemption
      // is the later, spawn-time `resolveGrants` check only) — an absolute
      // grant under a /tmp-based scratch home would never get this far.
      sandbox: { network: "agentglass", read: ["~/data.txt"], write: [], programs: [] },
    }));

    const inst = await installPlugin(src);
    expect(inst.ok, JSON.stringify(inst)).toBe(true);
    // enablePlugin awaits startProcess directly, and startProcess's own
    // catch (the fix) swallows the ensurePluginSocketServer throw and
    // returns without spawning — so this resolves ok:true rather than
    // rejecting or refusing; the assertion that matters is what it leaves
    // open, not whether enabling itself "succeeded" in the ordinary sense.
    const en = await enablePlugin("orbit-fd-leak");
    expect(en.ok, JSON.stringify(en)).toBe(true);

    const after = fdsPointingAt(file).length;
    expect(after, "a grant fd for the refused plugin's own file was left open").toBe(before);

    // And the impostor is still the one answering — nothing stole its socket.
    const r = await fetch("http://placeholder/", { unix: path } as any);
    expect(await r.text()).toBe("other instance");
  });
});
