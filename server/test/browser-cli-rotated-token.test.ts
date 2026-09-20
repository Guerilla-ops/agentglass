/*
 * A pane opened before the app last rotated its token.
 *
 * The token reaches a pane once, in the environment it is opened with, and the
 * desktop app makes a new one when it restarts. Every panel older than that
 * restart is therefore holding a string the server has stopped accepting, and
 * every `agentglass-browser` command from it answered `unauthorized` with
 * nothing to act on — which is how a reader ends up digging the current value
 * out of `/proc/<pid>/environ` of another process.
 *
 * So the CLI reads the token the app wrote, and only after the one it was
 * given was refused. The environment still decides first: a shell that exports
 * a token on purpose is not overruled by a file.
 *
 * Nothing here widens what the CLI can reach. The file is the app's own, 0600,
 * under the person's config directory, and the CLI runs as that person. The
 * thing the server deliberately does NOT do — put the token in tmux's global
 * environment, so a pane nobody handed it cannot inherit one — is untouched by
 * a file read on a 401.
 *
 * A stand-in server, not the real one: what is under test is which credential
 * the CLI presents and what it says when none of them work.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");
const CURRENT = "the-token-the-app-has-now";

let home = "", origin = "", server: ReturnType<typeof Bun.serve> | null = null;
/** Every Authorization header the CLI presented, in order. */
let presented: (string | null)[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agx-rotated-"));
  mkdirSync(join(home, "agentglass"), { recursive: true });
  server = Bun.serve({
    port: 0,
    fetch(req) {
      presented.push(req.headers.get("authorization"));
      const ok = req.headers.get("authorization") === `Bearer ${CURRENT}`;
      return Response.json(ok ? { ok: true, tabs: [] } : { ok: false, error: "unauthorized" }, { status: ok ? 200 : 401 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* fine */ }
});

/** The CLI, run the way a pane runs it: its own config home, its own token.
 *
 *  Spawned and awaited rather than `spawnSync`: the stand-in server is this
 *  same process, and a synchronous spawn holds the loop it would have to
 *  answer on — the CLI then waits for a reply nobody can send, and the test
 *  times out looking like the CLI hung. */
async function run(env: Record<string, string>) {
  presented = [];
  const p = Bun.spawn(["python3", CLI, "tabs", "--shared"], {
    env: { ...process.env, AGENTGLASS_SERVER: origin, XDG_CONFIG_HOME: home, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

const writeToken = (value: string) => writeFileSync(join(home, "agentglass", "token"), value + "\n", { mode: 0o600 });
const removeToken = () => { try { rmSync(join(home, "agentglass", "token")); } catch { /* fine */ } };

describe.if(HAVE_PY)("a token from before the last rotation", () => {
  test("is retried against the one the app wrote, and the command works", async () => {
    writeToken(CURRENT);
    const r = await run({ AGENTGLASS_TOKEN: "issued-before-the-restart" });
    expect(r.code).toBe(0);
    expect(presented).toEqual(["Bearer issued-before-the-restart", `Bearer ${CURRENT}`]);
  });

  test("the environment is still asked first, so an exported token decides", async () => {
    // Not a detail: a shell pointed at another agentglass, or a token narrowed
    // on purpose, must not be silently replaced by whatever is on this disk.
    writeToken("a-different-one");
    const r = await run({ AGENTGLASS_TOKEN: CURRENT });
    expect(r.code).toBe(0);
    expect(presented).toEqual([`Bearer ${CURRENT}`]);
  });

  test("and with nothing readable on disk it says what to do about it", async () => {
    removeToken();
    const r = await run({ AGENTGLASS_TOKEN: "issued-before-the-restart" });
    expect(r.code).not.toBe(0);
    const said = r.out + r.err;
    expect(said).toContain("not one the server accepts");
    expect(said).toContain("Open a new pane from agentglass");
    // The bare word on its own is what sent people to /proc.
    expect(said.trim()).not.toBe("unauthorized");
  });

  test("a file that is also stale is not reported as if it had not been tried", async () => {
    writeToken("also-from-before");
    const r = await run({ AGENTGLASS_TOKEN: "issued-before-the-restart" });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("holds one it does not accept either");
    expect(presented).toHaveLength(2);
  });
});
