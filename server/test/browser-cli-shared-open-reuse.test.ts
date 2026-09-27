/*
 * `open --shared` A SECOND TIME MUST NOT LOOK LIKE A FOREIGN CONTAINER.
 *
 * The first `open --shared <url>` mints a tab and remembers its id. Every
 * `open --shared` after that sends `page: <that id>` instead of a profile, so
 * the panel's cross-container check runs — and that check compares the tab's
 * container (the literal `"default"`) against whatever the CLI stamped as
 * `as`. `stamped()` used to send `as: "(default)"` (SHARED_KEY) whenever a
 * caller was truthy, `--shared` included, and `"default" !== "(default)"`: a
 * refusal the panel computed but could not deliver (see
 * browser-tab-ownership.test.ts for why that refusal itself never reaches the
 * CLI), so the SECOND `open --shared` against the tab the FIRST one just made
 * sat for the full 45s "browser did not answer in time" instead of navigating.
 *
 * `--shared` is meant to carry no `as` at all — "unverifiable, not a
 * mismatch" is the whole point (browser-tab-ownership.test.ts) — so this pins
 * the CLI's half of that: the wire body for a page-addressed `open --shared`
 * never carries `as`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
let answers: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
let askedArgs: Record<string, unknown>[] = [];
const CLIENT = "test-window-shared-reuse";

async function setup() {
  dir = mkdtempSync(join(tmpdir(), "agx-shared-reuse-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws!.addEventListener("open", r));
  ws!.send(JSON.stringify({ type: "hello", clientId: CLIENT, browser: true }));
  ws.addEventListener("message", async (ev) => {
    let frame: any;
    try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (frame.type !== "browser") return;
    askedArgs.push(frame.data.args ?? {});
    const reply = answers[frame.data.op] ?? { ok: false, error: "the stand-in was not told what to say" };
    await fetch(base + "/browser/result", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      body: JSON.stringify({ client: CLIENT, id: frame.data.id, ...reply }),
    });
  });
  await fetch(base + "/browser/ready", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify({ client: CLIENT, on: true }),
  });
  await Bun.sleep(150);
}

function teardown() {
  try { ws?.close(); } catch { /* already gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
}

async function cli(...args: string[]) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      AGENTGLASS_SERVER: base,
      AGENTGLASS_BROWSER_STATE_DIR: join(dir, "cache"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

describe.skipIf(!HAVE_PY)("open --shared, called twice", () => {
  test("neither call stamps `as` on the wire", async () => {
    await setup();
    try {
      answers = {
        open: {
          ok: true,
          value: { id: "t-shared-1", url: "https://orbit.example/a", title: "Orbit" },
        },
      };
      askedArgs = [];
      const first = await cli("--shared", "open", "https://orbit.example/a");
      expect(first.code).toBe(0);
      expect(askedArgs).toHaveLength(1);
      /* The mint: routed by `profile`, and `as` must still be absent. */
      expect(askedArgs[0]!.profile).toBe("");
      expect(askedArgs[0]!.as).toBeUndefined();

      askedArgs = [];
      const second = await cli("--shared", "open", "https://orbit.example/b");
      expect(second.code).toBe(0);
      expect(askedArgs).toHaveLength(1);
      /* The reuse: routed by `page`, addressed at the tab `open` just
         remembered — this is the call that used to carry `as: "(default)"`
         and hang. */
      expect(askedArgs[0]!.page).toBe("t-shared-1");
      expect(askedArgs[0]!.as).toBeUndefined();
    } finally {
      teardown();
    }
  }, SERVER_BOOT_MS);
});
