/*
 * S6: `lane new --from-template NAME` — a fork seeded with a signed-in page
 * instead of a login screen, and gone (in-memory jar, no `persist:` prefix)
 * the moment it closes. `newtab --from-template NAME`, below, is its
 * visible-tab twin: same jar, same seeding order, a TAB in the person's own
 * window instead of a hidden lane — for a task that wants to be watched
 * rather than run out of sight.
 *
 * Server calls in order — `lane new` (`ephemeral: true`), cookies (CDP, no
 * page needed), `open` the template's own origin, then storage ONLY once the
 * tab is confirmed to have landed on that same origin — and this is where the
 * CHAINING is checked, along with the one thing that chaining exists to
 * prevent: a site that redirects on an empty jar (a login wall, an IdP
 * bounce) must never get the template's localStorage written into ITS
 * origin instead. The individual writes are covered by
 * browser-template-store.test.ts's `_capture_state` path and by
 * session-load's own tests. The lane is closed again if `open` itself fails,
 * so a broken seed never leaves an orphaned fork behind for the 15-minute
 * sweep to find; a redirect is not that fatal (cookies are seeded either
 * way), so that case is a warning and a live lane, not a refusal.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_PY = !!Bun.which("python3");
const BIN = (name: string) => new URL(`../../bin/${name}`, import.meta.url).pathname;

function probe(file: string, body: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const src = `
import json, os, sys
from types import SimpleNamespace
ns = {"__name__": "probe", "__file__": ${JSON.stringify(file)}}
exec(compile(open(${JSON.stringify(file)}).read(), ${JSON.stringify(file)}, "exec"), ns)
${body}
`;
  const p = Bun.spawnSync(["python3", "-c", src], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const SEED_TEMPLATE = `ns["template_save"]("acme-corp", "", None)`;
const CAPTURE_ANSWERS = `
answers = {
  "cdp": {"ok": True, "value": {"result": {"cookies": [{"name": "sid", "value": "s", "domain": "app.example.invalid", "expires": 4102444800}]}}},
  "eval": {"ok": True, "value": {"value": {"origin": "https://app.example.invalid", "localStorage": {}, "sessionStorage": {}}}},
}
`;

/** `fake_call` for the happy-path tests: answers `lane`/`open`/`eval
 *  location.origin` and records every call, in order. */
const FAKE_CALL_LANDING = (origin: string) => `
calls = []
def fake_call(op, body=None, *a, **k):
    calls.append((op, dict(body or {})))
    if op == "lane" and (body or {}).get("action") == "new":
        return {"ok": True, "value": {"lane": {"id": "labc123", "container": "ephemeral"}}}
    if op == "lane" and (body or {}).get("action") == "close":
        return {"ok": True}
    if op == "open":
        return {"ok": True, "value": {}}
    if op == "eval" and (body or {}).get("js") == "location.origin":
        return {"ok": True, "value": {"value": ${JSON.stringify(origin)}}}
    return answers.get(op, {"ok": True, "value": {}})
ns["call"] = fake_call
`;

describe.skipIf(!HAVE_PY)("lane new --from-template", () => {
  test("opens an ephemeral lane, writes cookies BEFORE navigating, then confirms the landing before seeding storage", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${CAPTURE_ANSWERS}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}
${FAKE_CALL_LANDING("https://app.example.invalid")}
code = ns["lane_new_from_template"]("acme-corp", SimpleNamespace())
print(json.dumps({"code": code, "calls": [[op, b.get("action") or b.get("url") or b.get("js") or op] for op, b in calls]}))
`, { XDG_DATA_HOME: dataHome });
      expect(r.code, r.err).toBe(0);
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; calls: [string, string][] };
      expect(last.code).toBe(0);
      // cdp (the cookie) BEFORE open, not after — a redirect must never get
      // to race the cookie write. No "storage" call: the template's
      // localStorage/sessionStorage were both empty.
      expect(last.calls).toEqual([
        ["lane", "new"],
        ["cdp", "cdp"],
        ["open", "https://app.example.invalid"],
        ["eval", "location.origin"],
      ]);
      expect(r.out).toContain("labc123");
      expect(r.out).toContain("acme-corp");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("a redirect on the empty jar seeds cookies but never writes storage into the wrong origin", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
answers = {
  "cdp": {"ok": True, "value": {"result": {"cookies": [{"name": "sid", "value": "s", "domain": "app.example.invalid", "expires": 4102444800}]}}},
  "eval": {"ok": True, "value": {"value": {"origin": "https://app.example.invalid", "localStorage": {"token": "secret-token"}, "sessionStorage": {}}}},
}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}
${FAKE_CALL_LANDING("https://login.example.invalid")}
code = ns["lane_new_from_template"]("acme-corp", SimpleNamespace())
print(json.dumps({"code": code, "storageCalls": sum(1 for op, _ in calls if op == "storage")}))
`, { XDG_DATA_HOME: dataHome });
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; storageCalls: number };
      expect(last.code, r.err).toBe(0); // a redirect is a warning, not a failure — cookies still seeded
      expect(last.storageCalls).toBe(0);
      expect(r.err).toContain("landed on https://login.example.invalid instead of https://app.example.invalid");
      expect(r.err).not.toContain("secret-token");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("a template that was never saved never opens a lane at all", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
called = []
ns["call"] = lambda op, body=None, *a, **k: called.append(op) or {"ok": True, "value": {}}
code = ns["lane_new_from_template"]("nope", SimpleNamespace())
print(json.dumps({"code": code, "called": called}))
`, { XDG_DATA_HOME: dataHome });
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; called: string[] };
      expect(last.code).toBe(1);
      expect(last.called).toEqual([]); // no lane opened for a template that does not exist
      expect(r.err).toContain("no template called nope");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("when the lane cannot open, the template file is never even read for its cookies", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${CAPTURE_ANSWERS}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}
ns["call"] = lambda op, body=None, *a, **k: {"ok": False, "error": "4 lanes are already open"}
code = ns["lane_new_from_template"]("acme-corp", SimpleNamespace())
print(code)
`, { XDG_DATA_HOME: dataHome });
      expect(r.out.trim().split("\n").pop()).toBe("1");
      expect(r.err).toContain("4 lanes are already open");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("when navigation to the origin fails, the lane is closed rather than left seedless", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${CAPTURE_ANSWERS}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}

calls = []
def fake_call(op, body=None, *a, **k):
    calls.append((op, dict(body or {})))
    if op == "lane" and body.get("action") == "new":
        return {"ok": True, "value": {"lane": {"id": "labc123"}}}
    if op == "lane" and body.get("action") == "close":
        return {"ok": True}
    if op == "open":
        return {"ok": False, "error": "origin refused"}
    return answers.get(op, {"ok": True, "value": {}})
ns["call"] = fake_call

code = ns["lane_new_from_template"]("acme-corp", SimpleNamespace())
print(json.dumps({"code": code, "closed": any(op == "lane" and b.get("action") == "close" and b.get("id") == "labc123" for op, b in calls)}))
`, { XDG_DATA_HOME: dataHome });
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; closed: boolean };
      expect(last.code).toBe(1);
      expect(last.closed).toBe(true);
      expect(r.err).toContain("origin refused");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });
});

/** `fake_call` for the tab happy-path tests: answers `newtab`/`open`/`eval
 *  location.origin` and records every call, in order — the same shape as
 *  `FAKE_CALL_LANDING` above, mint op and id field swapped for a tab's. */
const FAKE_CALL_LANDING_TAB = (origin: string) => `
calls = []
def fake_call(op, body=None, *a, **k):
    calls.append((op, dict(body or {})))
    if op == "newtab":
        return {"ok": True, "value": {"id": "t9zz8yy7"}}
    if op == "open":
        return {"ok": True, "value": {}}
    if op == "eval" and (body or {}).get("js") == "location.origin":
        return {"ok": True, "value": {"value": ${JSON.stringify(origin)}}}
    if op == "closetab":
        return {"ok": True}
    return answers.get(op, {"ok": True, "value": {}})
ns["call"] = fake_call
`;

describe.skipIf(!HAVE_PY)("newtab --from-template", () => {
  test("opens an ephemeral tab, writes cookies BEFORE navigating, then confirms the landing before seeding storage", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-tab-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${CAPTURE_ANSWERS}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}
${FAKE_CALL_LANDING_TAB("https://app.example.invalid")}
code = ns["newtab_from_template"]("acme-corp", SimpleNamespace())
print(json.dumps({"code": code, "calls": [[op, b.get("url") or b.get("js") or op] for op, b in calls]}))
`, { XDG_DATA_HOME: dataHome });
      expect(r.code, r.err).toBe(0);
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; calls: [string, string][] };
      expect(last.code).toBe(0);
      // cdp (the cookie) BEFORE open, not after — same ordering guarantee as
      // the lane's, for the same reason: a redirect must never race the
      // cookie write. No "storage" call: the template's localStorage/
      // sessionStorage were both empty.
      expect(last.calls).toEqual([
        ["newtab", "about:blank"],
        ["cdp", "cdp"],
        ["open", "https://app.example.invalid"],
        ["eval", "location.origin"],
      ]);
      expect(r.out).toContain("t9zz8yy7");
      expect(r.out).toContain("acme-corp");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("every call after the mint addresses the tab explicitly, by id", () => {
    // The one real difference from a lane: a lane owns its one page
    // implicitly (`a.lane`), but a window can hold many tabs, so this rides
    // an explicit `page` the same way `--page` lets any verb name one.
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-tab-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${CAPTURE_ANSWERS}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}
${FAKE_CALL_LANDING_TAB("https://app.example.invalid")}
code = ns["newtab_from_template"]("acme-corp", SimpleNamespace())
print(json.dumps({"pages": [b.get("page") for op, b in calls if op in ("cdp", "open", "eval")]}))
`, { XDG_DATA_HOME: dataHome });
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { pages: (string | null)[] };
      expect(last.pages).toEqual(["t9zz8yy7", "t9zz8yy7", "t9zz8yy7"]);
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("a redirect on the empty jar seeds cookies but never writes storage into the wrong origin", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-tab-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
answers = {
  "cdp": {"ok": True, "value": {"result": {"cookies": [{"name": "sid", "value": "s", "domain": "app.example.invalid", "expires": 4102444800}]}}},
  "eval": {"ok": True, "value": {"value": {"origin": "https://app.example.invalid", "localStorage": {"token": "secret-token"}, "sessionStorage": {}}}},
}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}
${FAKE_CALL_LANDING_TAB("https://login.example.invalid")}
code = ns["newtab_from_template"]("acme-corp", SimpleNamespace())
print(json.dumps({"code": code, "storageCalls": sum(1 for op, _ in calls if op == "storage")}))
`, { XDG_DATA_HOME: dataHome });
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; storageCalls: number };
      expect(last.code, r.err).toBe(0); // a redirect is a warning, not a failure — cookies still seeded
      expect(last.storageCalls).toBe(0);
      expect(r.err).toContain("landed on https://login.example.invalid instead of https://app.example.invalid");
      expect(r.err).not.toContain("secret-token");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("a template that was never saved never opens a tab at all", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-tab-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
called = []
ns["call"] = lambda op, body=None, *a, **k: called.append(op) or {"ok": True, "value": {}}
code = ns["newtab_from_template"]("nope", SimpleNamespace())
print(json.dumps({"code": code, "called": called}))
`, { XDG_DATA_HOME: dataHome });
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; called: string[] };
      expect(last.code).toBe(1);
      expect(last.called).toEqual([]); // no tab opened for a template that does not exist
      expect(r.err).toContain("no template called nope");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("when the tab cannot open, the template file is never even read for its cookies", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-tab-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${CAPTURE_ANSWERS}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}
ns["call"] = lambda op, body=None, *a, **k: {"ok": False, "error": "8 ephemeral tabs are already open"}
code = ns["newtab_from_template"]("acme-corp", SimpleNamespace())
print(code)
`, { XDG_DATA_HOME: dataHome });
      expect(r.out.trim().split("\n").pop()).toBe("1");
      expect(r.err).toContain("8 ephemeral tabs are already open");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });

  test("when navigation to the origin fails, the tab is closed rather than left seedless", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "agx-tmpl-fork-tab-"));
    try {
      const r = probe(BIN("agentglass-browser"), `
${CAPTURE_ANSWERS}
ns["call"] = lambda op, body=None, *a, **k: answers.get(op, {"ok": True, "value": {}})
${SEED_TEMPLATE}

calls = []
def fake_call(op, body=None, *a, **k):
    calls.append((op, dict(body or {})))
    if op == "newtab":
        return {"ok": True, "value": {"id": "t9zz8yy7"}}
    if op == "open":
        return {"ok": False, "error": "origin refused"}
    if op == "closetab":
        return {"ok": True}
    return answers.get(op, {"ok": True, "value": {}})
ns["call"] = fake_call

code = ns["newtab_from_template"]("acme-corp", SimpleNamespace())
print(json.dumps({"code": code, "closed": any(op == "closetab" and b.get("id") == "t9zz8yy7" for op, b in calls)}))
`, { XDG_DATA_HOME: dataHome });
      const last = JSON.parse(r.out.trim().split("\n").pop()!) as { code: number; closed: boolean };
      expect(last.code).toBe(1);
      expect(last.closed).toBe(true);
      expect(r.err).toContain("origin refused");
    } finally { rmSync(dataHome, { recursive: true, force: true }); }
  });
});
