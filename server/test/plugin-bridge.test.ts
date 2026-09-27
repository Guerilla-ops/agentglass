/*
 * Slice 3: the bridge that proxies a box's own loopback TCP port to the one
 * unix socket bwrap bind-mounted into it — no bwrap involved here at all,
 * just the proxy's own correctness: bytes flow both ways, and the wrapped
 * command's exit code comes back out. The real-bwrap version of this same
 * chain (curl inside an actual box, reaching a real plugin socket) is in
 * plugin-sandbox.test.ts, gated on `sandboxProbe().ok` like every other real
 * box test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginBridgeArgs, runPluginBridge } from "../src/plugin-bridge.ts";
import { freePort } from "./freePort.ts";

describe("parsePluginBridgeArgs", () => {
  test("the ordinary shape", () => {
    expect(parsePluginBridgeArgs(["--listen", "127.0.0.1:4000", "--socket", "/tmp/x.sock", "--", "bash", "-c", "echo hi"])).toEqual({
      listenHost: "127.0.0.1", listenPort: 4000, socketPath: "/tmp/x.sock", cmd: ["bash", "-c", "echo hi"],
    });
  });

  test("refuses a missing --listen, --socket, or command", () => {
    expect(parsePluginBridgeArgs(["--socket", "/tmp/x.sock", "--", "true"])).toBeNull();
    expect(parsePluginBridgeArgs(["--listen", "127.0.0.1:4000", "--", "true"])).toBeNull();
    expect(parsePluginBridgeArgs(["--listen", "127.0.0.1:4000", "--socket", "/tmp/x.sock", "--"])).toBeNull();
  });

  test("refuses an unknown flag rather than swallowing it into the command", () => {
    expect(parsePluginBridgeArgs(["--nope", "x", "--", "true"])).toBeNull();
  });

  test("a listen address with no port is refused", () => {
    expect(parsePluginBridgeArgs(["--listen", "127.0.0.1", "--socket", "/tmp/x.sock", "--", "true"])).toBeNull();
  });
});

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "agx-bridge-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } }
});

describe("the proxy carries bytes both ways", () => {
  test("a TCP client reaches a plain unix HTTP server through the bridge", async () => {
    const dir = scratch();
    const sock = join(dir, "srv.sock");
    const srv = Bun.serve({ unix: sock, fetch: async (req) => new Response(`echo:${new URL(req.url).pathname}`) });
    const port = await freePort();
    // The bridge's own `Bun.listen` call is synchronous inside
    // `runPluginBridge`, but the promise it returns only resolves once the
    // wrapped command exits — "sleep 1" so this test does not hang on it.
    const bridge = runPluginBridge(["--listen", `127.0.0.1:${port}`, "--socket", sock, "--", "sleep", "1"]);
    try {
      await Bun.sleep(200); // for the listener to actually be up
      const r = await fetch(`http://127.0.0.1:${port}/plugin/self`);
      expect(await r.text()).toBe("echo:/plugin/self");
    } finally {
      srv.stop(true);
    }
    expect(await bridge).toBe(0);
  });

  test("a multi-megabyte upload arrives whole — a partial `socket.write()` is queued and flushed on drain, not dropped", async () => {
    const dir = scratch();
    const sock = join(dir, "srv.sock");
    let receivedBytes = 0;
    const srv = Bun.serve({
      unix: sock,
      async fetch(req) {
        const body = await req.arrayBuffer();
        receivedBytes = body.byteLength;
        return new Response(String(body.byteLength));
      },
    });
    const port = await freePort();
    const bridge = runPluginBridge(["--listen", `127.0.0.1:${port}`, "--socket", sock, "--", "sleep", "2"]);
    try {
      await Bun.sleep(200);
      // 8 MB: comfortably past both the 1 MB a POST body was measured
      // getting silently dropped at, and the OS socket buffer that happened
      // to still cover a smaller body whole.
      const size = 8 * 1024 * 1024;
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i += 4096) payload[i] = i % 256; // not all zero, so a truncation cannot pass by accident
      const r = await fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: payload });
      expect(await r.text()).toBe(String(size));
      expect(receivedBytes).toBe(size);
    } finally {
      srv.stop(true);
    }
  }, 15000);

  test("the wrapped command's exit code comes back out, whatever it is", async () => {
    const dir = scratch();
    const port = await freePort();
    // No unix server at all: the socket path never exists. `startProxy`'s own
    // comment is the point of this assertion — a proxy that cannot connect
    // still lets the command run and still reports ITS exit code.
    const code = await runPluginBridge(["--listen", `127.0.0.1:${port}`, "--socket", join(dir, "never-exists.sock"), "--", "bash", "-c", "exit 7"]);
    expect(code).toBe(7);
  });

  test("a bind failure (port already taken) exits 1 and the command never runs", async () => {
    const dir = scratch();
    const port = await freePort();
    const hog = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    try {
      const code = await runPluginBridge(["--listen", `127.0.0.1:${port}`, "--socket", join(dir, "never-exists.sock"), "--", "bash", "-c", "exit 3"]);
      expect(code).toBe(1);
    } finally {
      hog.stop(true);
    }
  });

  test("a signalled command reports 128+signo, not a flat 128 for every signal", async () => {
    const dir = scratch();
    const port = await freePort();
    // `kill -TERM $$` inside the wrapped shell — the same shape a plugin
    // that traps a signal produces, without this test depending on timing
    // to land a signal on the process from outside.
    const code = await runPluginBridge(["--listen", `127.0.0.1:${port}`, "--socket", join(dir, "never-exists.sock"), "--", "bash", "-c", "kill -TERM $$"]);
    expect(code).toBe(128 + 15); // SIGTERM is 15 on Linux
  });

  test("a malformed invocation exits 2 without spawning anything", async () => {
    expect(await runPluginBridge(["--nonsense"])).toBe(2);
  });
});
