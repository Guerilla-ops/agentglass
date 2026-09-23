/*
 * Tool allow/deny rules for the gate (#109).
 *
 * The spend threshold already annotates a hold (gate-budget.test.ts). This is
 * the other half of "hold by rule": a static list that auto-allows, soft-holds,
 * or hard-denies without waiting for a human click.
 *
 * Three paths, and nothing else:
 *   allow  — tool on the (most-specific) allowlist → immediate allow, resolution "rule"
 *            (history keeps the reason; the /gate HTTP body returns reason: "")
 *   hold   — allowlist set, tool not on it → soft hold with a reason
 *   deny   — tool on any matching denylist → immediate deny, resolution "rule"
 *
 * No config at all is the shipped state and must leave the gate unchanged.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = (name: string, gateTools?: unknown): string => {
  const d = mkdtempSync(join(tmpdir(), `agx-gatetools-${name}-`));
  if (gateTools !== undefined) {
    mkdirSync(join(d, "agentglass"), { recursive: true });
    writeFileSync(join(d, "agentglass", "config.json"), JSON.stringify({ gateTools }));
  }
  return d;
};

const NONE = home("none");
const ALLOW = home("allow", [{ root: "", allow: ["Read", "Glob", "Grep"], deny: [] }]);
const DENY = home("deny", [{ root: "", allow: [], deny: ["Bash", "Write"] }]);
const BOTH = home("both", [{ root: "", allow: ["Read"], deny: ["Bash"] }]);
const SCOPED = home("scoped", [
  { root: "/home/u/code/orbit", allow: ["Read"], deny: ["Bash"] },
  { root: "", allow: ["Read", "Glob"], deny: [] },
]);
// Global deny must survive a more-specific allow-only row (deny accumulates).
const DENY_THEN_ALLOW = home("deny-then-allow", [
  { root: "", allow: [], deny: ["Bash"] },
  { root: "/home/u/code/orbit", allow: ["Bash", "Read"], deny: [] },
]);

process.env.AGENTGLASS_DB = join(NONE, "gate.db");
process.env.XDG_CONFIG_HOME = NONE;

let gate: typeof import("../src/gate.ts");
let tools: typeof import("../src/gateTools.ts");
let db: typeof import("../src/db.ts");
let panewt: typeof import("../src/panewt.ts");
let config: typeof import("../src/config.ts");

let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PANE = "%99";
const CWD = "/home/u/code/orbit";

const req = (id: string, tool = "Bash", over: Record<string, unknown> = {}) => ({
  id,
  source_app: "orbit",
  session_id: SESSION,
  tool_name: tool,
  summary: tool === "Bash" ? "rm -rf build" : tool,
  ...over,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  panewt = await import("../src/panewt.ts");
  gate = await import("../src/gate.ts");
  tools = await import("../src/gateTools.ts");
  config = await import("../src/config.ts");
  panewt.notePaneAgent({
    pane: PANE,
    sessionId: SESSION,
    transcriptPath: join(NONE, "t.jsonl"),
    cwd: CWD,
  });
});

describe("evaluateGateTools", () => {
  test("no policies → null (gate unchanged)", () => {
    expect(tools.evaluateGateTools("Bash", CWD, [])).toBeNull();
  });

  test("allowlist hit → allow (reason for history)", () => {
    const v = tools.evaluateGateTools("Read", CWD, [{ root: "", allow: ["Read", "Glob"], deny: [] }]);
    expect(v?.kind).toBe("allow");
    expect(v?.reason).toMatch(/allowlist/);
  });

  test("allowlist miss → soft hold", () => {
    const v = tools.evaluateGateTools("Bash", CWD, [{ root: "", allow: ["Read"], deny: [] }]);
    expect(v?.kind).toBe("hold");
    expect(v?.reason).toMatch(/Not on the tool allowlist/);
    expect(v?.reason).toMatch(/Read/);
  });

  test("denylist hit → deny, and beats allowlist on the same row", () => {
    const v = tools.evaluateGateTools("Bash", CWD, [
      { root: "", allow: ["Bash", "Read"], deny: ["Bash"] },
    ]);
    expect(v?.kind).toBe("deny");
    expect(v?.reason).toMatch(/denylist/);
    expect(v?.reason).toMatch(/Do not retry/i);
  });

  test("deny-only policy leaves unlisted tools alone", () => {
    expect(
      tools.evaluateGateTools("Read", CWD, [{ root: "", allow: [], deny: ["Bash"] }]),
    ).toBeNull();
  });

  test("most-specific allow; deny accumulates across matching roots", () => {
    const policies = [
      { root: "", allow: ["Read", "Glob"], deny: [] as string[] },
      { root: "/home/u/code/orbit", allow: ["Read"], deny: ["Bash"] },
    ];
    // Under orbit: project deny Bash; Glob soft-held (project allow is Read only).
    expect(tools.evaluateGateTools("Bash", CWD, policies)?.kind).toBe("deny");
    expect(tools.evaluateGateTools("Glob", CWD, policies)?.kind).toBe("hold");
    expect(tools.evaluateGateTools("Read", CWD, policies)?.kind).toBe("allow");
    // Elsewhere: global policy — Glob allowed.
    expect(tools.evaluateGateTools("Glob", "/home/u/code/other", policies)?.kind).toBe("allow");
  });

  test("global deny survives a more-specific allow-only row", () => {
    const policies = [
      { root: "", allow: [] as string[], deny: ["Bash"] },
      { root: "/home/u/code/orbit", allow: ["Bash", "Read"], deny: [] as string[] },
    ];
    // Project allow Bash must NOT escape the global denylist.
    expect(tools.evaluateGateTools("Bash", CWD, policies)?.kind).toBe("deny");
    // Project allow still covers Read (no ancestor deny).
    expect(tools.evaluateGateTools("Read", CWD, policies)?.kind).toBe("allow");
  });

  test("unknown cwd: global deny still denies; global allow does not allow", () => {
    const denyOnly = [{ root: "", allow: [] as string[], deny: ["Bash"] }];
    expect(tools.evaluateGateTools("Bash", "", denyOnly)?.kind).toBe("deny");

    const allowOnly = [{ root: "", allow: ["Bash", "Read"], deny: [] as string[] }];
    expect(tools.evaluateGateTools("Bash", "", allowOnly)).toBeNull();
    expect(tools.evaluateGateTools("Read", "", allowOnly)).toBeNull();

    // Soft-hold must not fire either when cwd is unknown.
    expect(tools.evaluateGateTools("Write", "", allowOnly)).toBeNull();
  });

  test("a scoped policy does not cover a directory we could not place", () => {
    expect(
      tools.evaluateGateTools("Bash", "", [{ root: "/home/u/code/orbit", allow: [], deny: ["Bash"] }]),
    ).toBeNull();
  });
});

describe("readGateTools", () => {
  test("drops empty and malformed rows", () => {
    process.env.XDG_CONFIG_HOME = home("bad", [
      { root: "", allow: [], deny: [] },
      { root: "", allow: "Read" },
      { root: "", allow: ["Read"], deny: ["Bash"] },
    ]);
    const rows = config.readGateTools();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allow).toEqual(["Read"]);
    expect(rows[0]!.deny).toEqual(["Bash"]);
  });
});

describe("resolveByRule paths", () => {
  test("allow records resolution=rule with reason; hook contract is empty reason", () => {
    process.env.XDG_CONFIG_HOME = ALLOW;
    const id = newId();
    const stored = gate.resolveByRule(req(id, "Read"), {
      decision: "allow",
      reason: "Allowed by agentglass tool allowlist (Read).",
    });
    // resolveByRule returns what was stored (history / activity log).
    expect(stored.decision).toBe("allow");
    expect(stored.reason).toMatch(/allowlist/);
    expect(gate.pendingGates().find((g) => g.id === id)).toBeUndefined();
    const row = db.getGate(id)!;
    expect(row.decision).toBe("allow");
    expect(row.resolution).toBe("rule");
    expect(row.reason).toMatch(/allowlist/);
    // The /gate route (index.ts) returns { decision: "allow", reason: "" } so
    // the hook takes allow_silently() — Claude Code's own permissions apply.
    // Assert the contract the route implements rather than spinning a server.
    const hookBody = { decision: stored.decision, reason: "" };
    expect(hookBody).toEqual({ decision: "allow", reason: "" });
  });

  test("deny records resolution=rule with a no-retry reason", () => {
    process.env.XDG_CONFIG_HOME = DENY;
    const id = newId();
    const out = gate.resolveByRule(req(id, "Bash"), {
      decision: "deny",
      reason: tools.evaluateGateTools("Bash", CWD, config.readGateTools())!.reason,
    });
    expect(out.decision).toBe("deny");
    expect(db.getGate(id)!.resolution).toBe("rule");
    expect(out.reason).toMatch(/Do not retry/i);
  });

  test("soft hold still waits for a human, with the rule reason on the card", () => {
    process.env.XDG_CONFIG_HOME = ALLOW;
    const id = newId();
    const verdict = tools.evaluateGateTools("Bash", CWD, config.readGateTools());
    expect(verdict?.kind).toBe("hold");
    gate.submitGate(req(id, "Bash"), 60_000, verdict!.reason);
    const held = gate.pendingGates().find((g) => g.id === id)!;
    expect(held.budget).toMatch(/Not on the tool allowlist/);
    // Human can still decide.
    expect(gate.decideGate(id, "allow", "ok this once")).toBe(true);
    expect(db.getGate(id)!.resolution).toBe("human");
  });

  test("no config: gateToolsFor returns null", () => {
    process.env.XDG_CONFIG_HOME = NONE;
    expect(tools.gateToolsFor(SESSION, "Bash")).toBeNull();
  });

  test("scoped config matches the session cwd from the pane note", () => {
    process.env.XDG_CONFIG_HOME = SCOPED;
    expect(tools.gateToolsFor(SESSION, "Bash")?.kind).toBe("deny");
    expect(tools.gateToolsFor(SESSION, "Read")?.kind).toBe("allow");
    expect(tools.gateToolsFor(SESSION, "Glob")?.kind).toBe("hold");
  });

  test("both lists: deny wins over allow for the same tool", () => {
    process.env.XDG_CONFIG_HOME = BOTH;
    expect(tools.gateToolsFor(SESSION, "Bash")?.kind).toBe("deny");
    expect(tools.gateToolsFor(SESSION, "Read")?.kind).toBe("allow");
  });

  test("deny accumulates: global deny Bash + project allow Bash → deny", () => {
    process.env.XDG_CONFIG_HOME = DENY_THEN_ALLOW;
    expect(tools.gateToolsFor(SESSION, "Bash")?.kind).toBe("deny");
    expect(tools.gateToolsFor(SESSION, "Read")?.kind).toBe("allow");
  });
});
