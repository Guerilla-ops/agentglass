// LOCAL_SINKS (auth.ts) exempts a loopback caller from the token on the
// reasoning "a same-user process can already read the 0600 token file" — a
// reasoning that says nothing about another account, or a host-networked
// container under a different uid, dialing the same port. This locks down
// the uid check that narrows the exemption to the server's own uid, and that
// index.ts actually wires it into the two isAuthExempt calls in the request
// path (a check that does not run is not a fix).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopbackPeerIsOtherUser, __resetProxyProbe, __setProcNetFiles } from "../src/remote.ts";

describe("loopbackPeerIsOtherUser", () => {
  if (process.platform !== "linux") {
    it.skip("linux-only (/proc/net/tcp)", () => {});
  } else {
    const ours = 4000;
    const peerPort = 51234;
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
    const me = typeof process.getuid === "function" ? process.getuid() : 1000;
    const other = me + 1;
    const addrHex = (ip: string) =>
      ip.split(".").map((o) => Number(o).toString(16).toUpperCase().padStart(2, "0")).reverse().join("");
    const rowFor = (uid: number, localIp: string, localPort: number) =>
      `   0: ${addrHex(localIp)}:${hex(localPort)} 0100007F:${hex(ours)} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 4242 1 0000000000000000 20 4 30 10 -1`;
    const row = (uid: number) => rowFor(uid, "127.0.0.1", peerPort);
    const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
    let dir = "";
    const fake = (body: string) => {
      const f = join(dir, `tcp-${Math.random().toString(36).slice(2)}`);
      writeFileSync(f, header + "\n" + body + "\n");
      __resetProxyProbe();
      __setProcNetFiles([f]);
      return f;
    };

    afterAll(() => {
      __setProcNetFiles(null);
      __resetProxyProbe();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("says true for a loopback peer owned by a different uid", () => {
      dir = dir || mkdtempSync(join(tmpdir(), "agx-peeruid-"));
      fake(row(other));
      expect(loopbackPeerIsOtherUser({ address: "127.0.0.1", port: peerPort }, ours)).toBe(true);
    });

    it("says false for a loopback peer owned by this uid", () => {
      dir = dir || mkdtempSync(join(tmpdir(), "agx-peeruid-"));
      fake(row(me));
      expect(loopbackPeerIsOtherUser({ address: "127.0.0.1", port: peerPort }, ours)).toBe(false);
    });

    it("says false (fail open) when there is no socket table to consult", () => {
      dir = dir || mkdtempSync(join(tmpdir(), "agx-peeruid-"));
      __resetProxyProbe();
      __setProcNetFiles([join(dir, "no-such-table")]);
      expect(loopbackPeerIsOtherUser({ address: "127.0.0.1", port: peerPort }, ours)).toBe(false);
    });

    it("says false for a peer that is not loopback at all", () => {
      __resetProxyProbe();
      expect(loopbackPeerIsOtherUser({ address: "192.168.1.77", port: peerPort }, ours)).toBe(false);
    });

    // M1: the table used to be keyed by port alone, so a row for a DIFFERENT
    // loopback address sharing the same port was trusted as this peer's own —
    // reachable in practice because a source port is a client's own pick and
    // this same file already told an unrelated uid which port a live
    // connection was using.
    it("does not trust a same-port row bound to a DIFFERENT loopback address", () => {
      dir = dir || mkdtempSync(join(tmpdir(), "agx-peeruid-"));
      fake(rowFor(me, "127.0.0.2", peerPort)); // same uid as us, wrong address
      expect(loopbackPeerIsOtherUser({ address: "127.0.0.1", port: peerPort }, ours)).toBe(true);
    });

    // L3: a readable table with no row for THIS connection is not the same
    // fact as no table at all, and must not fail the same way.
    it("fails CLOSED when the table is readable but has no row for this connection", () => {
      dir = dir || mkdtempSync(join(tmpdir(), "agx-peeruid-"));
      fake(rowFor(me, "127.0.0.1", peerPort + 1)); // some other connection entirely
      expect(loopbackPeerIsOtherUser({ address: "127.0.0.1", port: peerPort }, ours)).toBe(true);
    });
  }
});

describe("index.ts wires the uid-aware origin into the token gate", () => {
  it("passes sinkFrom, not from, to both isAuthExempt calls in the request path", async () => {
    // A fixed window would drift the moment a line above these calls changes;
    // this slices the whole handler by its own braces instead, then strips
    // comments so a mention of "isAuthExempt(pathname, from)" in prose cannot
    // pass a check that only cares about the call.
    const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    const marker = "async function handleServerRequest(req: Request, srv: Server<WsData>): Promise<Response> {";
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const calls = body.match(/isAuthExempt\(pathname,\s*\w+\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toBe("isAuthExempt(pathname, sinkFrom)");
    expect(body).toContain("loopbackPeerIsOtherUser(peerSock");
  });
});
