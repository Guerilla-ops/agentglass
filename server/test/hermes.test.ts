import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  frameToEvent, hermesArgs, hermesConfiguredModel, hermesMode, hermesModel, hermesResumeAllowed,
  hermesProfileHome, hermesRowsToTimeline, hermesSession, hermesTranscript, hermesTurnCost, newFrameContext, promptEvent,
} from "../src/hermes.ts";
const BIN = "/usr/bin/hermes";
const SID = "20260917_104709_fdc54d";

describe("the command line", () => {
  test("reads the prompt from stdin and asks for the streaming format", () => {
    const a = hermesArgs(BIN, "/repo", "", "", "default");
    expect(a).toEqual([BIN, "chat", "--query-file", "-", "--format", "stream-json", "--in", "/repo"]);
    expect(a).not.toContain("--yolo");
    expect(a).not.toContain("--model");
  });

  test("a follow-up resumes without leaving the open project", () => {
    const a = hermesArgs(BIN, "/repo", "deepseek/deepseek-v4-flash", SID, "yolo");
    expect(a).toContain("--resume");
    expect(a[a.indexOf("--resume") + 1]).toBe(SID);
    expect(a).toContain("--no-restore-cwd");
    expect(a).toContain("--model");
    expect(a).toContain("--yolo");
  });

  test("the prompt is not an argument, however odd it looks", () => {
    const nasty = "--model evil\n'; rm -rf /";
    const a = hermesArgs(BIN, "/repo", "", "", "default");
    expect(a).not.toContain(nasty);
    expect(a.filter((x) => x === "--model")).toHaveLength(0);
  });

  test("bypass is refused unless the operator opted in", () => {
    expect(hermesMode("yolo", false)).toBe("default");
    expect(hermesMode("yolo", true)).toBe("yolo");
    expect(hermesMode("default", true)).toBe("default");
    expect(hermesMode("always-proceed", true)).toBe("default");
  });
});

describe("ids", () => {
  test("accepts Hermes's own shapes and refuses the other CLIs'", () => {
    expect(hermesSession(SID)).toBe(SID);
    expect(hermesSession("78126291-f204-4b7a-b218-9a7e7ba9ac9a")).toBe("");
    expect(hermesModel("deepseek/deepseek-v4-flash-0731")).toBe("deepseek/deepseek-v4-flash-0731");
    expect(hermesModel("not a model")).toBe("");
    expect(hermesModel("")).toBe("");
  });
});

describe("the active profile", () => {
  const prev = process.env.HERMES_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prev;
  });

  test("config and state are read from the named profile, not the root", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-home-")));
    try {
      writeFileSync(join(dir, "active_profile"), "main\n");
      writeFileSync(join(dir, "config.yaml"), "model:\n  default: not-this\n");
      mkdirSync(join(dir, "profiles", "main"), { recursive: true });
      writeFileSync(join(dir, "profiles", "main", "config.yaml"), "model:\n  default: grok-4.7\n");
      process.env.HERMES_HOME = dir;
      expect(hermesProfileHome()).toBe(join(dir, "profiles", "main"));
      expect(hermesConfiguredModel()).toBe("grok-4.7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a profile name that is not a single path segment is ignored", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-home-")));
    try {
      writeFileSync(join(dir, "active_profile"), "../secret");
      process.env.HERMES_HOME = dir;
      expect(hermesProfileHome()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the configured model", () => {
  test("reads model.default and nothing else in that section", () => {
    const dir = mkdtempSync(join(tmpdir(), "agx-hermes-cfg-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, "model:\n  provider: nous\n  default: deepseek/deepseek-v4-flash-0731\n  base_url: https://example.test\nother: 1\n");
    expect(hermesConfiguredModel(path)).toBe("deepseek/deepseek-v4-flash-0731");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("frames as events", () => {
  const ctx = () => newFrameContext("/repo");

  test("init opens the session", () => {
    const c = ctx();
    const ev = frameToEvent({ type: "system", subtype: "init", session_id: SID, model: "deepseek/deepseek-v4-flash" }, c);
    expect(ev?.hook_event_type).toBe("SessionStart");
    expect(ev?.source_app).toBe("hermes");
    expect(ev?.session_id).toBe(SID);
    expect(ev?.model_name).toBe("deepseek/deepseek-v4-flash");
    expect(c.sessionId).toBe(SID);
  });

  test("an init without a Hermes session id is not an event", () => {
    expect(frameToEvent({ type: "system", subtype: "init", session_id: "" }, ctx())).toBeNull();
  });

  test("tools pair on tool_call_id, and an error is a failure", () => {
    const c = ctx();
    c.sessionId = SID;
    const pre = frameToEvent({ type: "tool_use", name: "terminal", tool_call_id: "call_1", input: { command: "ls" } }, c);
    expect(pre?.hook_event_type).toBe("PreToolUse");
    expect(pre?.payload).toMatchObject({ tool_name: "terminal", tool_use_id: "call_1" });
    const post = frameToEvent({ type: "tool_result", name: "terminal", tool_call_id: "call_1", output: "ok", is_error: true }, c);
    expect(post?.hook_event_type).toBe("PostToolUseFailure");
  });

  test("text deltas are not fleet events", () => {
    const c = ctx();
    c.sessionId = SID;
    expect(frameToEvent({ type: "text", text: "hello" }, c)).toBeNull();
  });

  test("a turn's tokens are sent through, and an unknown model is not priced as Sonnet", () => {
    const c = ctx();
    c.sessionId = SID;
    c.model = "nous/hermes-4";
    const ev = frameToEvent({
      type: "result", session_id: SID, exit_code: 0,
      tokens: { input: 10, output: 4, cache_read: 2, cache_write: 1 },
    }, c);
    expect(ev?.hook_event_type).toBe("Turn complete");
    expect(ev?.payload).toMatchObject({
      usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2, cache_creation_tokens: 1 },
    });
    expect(ev?.reported_cost_usd).toBe(0);
  });

  test("Hermes's own dollar delta wins over the price table", () => {
    const c = ctx();
    c.sessionId = SID;
    c.model = "anthropic/claude-sonnet-4";
    c.reportedCost = 0.02;
    const ev = frameToEvent({ type: "result", session_id: SID, tokens: { input: 10, output: 4 } }, c);
    expect(ev?.reported_cost_usd).toBe(0.02);
  });

  test("a priced model with no Hermes figure is left for the table", () => {
    const c = ctx();
    c.sessionId = SID;
    c.model = "anthropic/claude-sonnet-4";
    const ev = frameToEvent({ type: "result", session_id: SID, tokens: { input: 10, output: 4 } }, c);
    expect(ev?.reported_cost_usd).toBeUndefined();
  });

  test("the prompt is its own event once the session exists", () => {
    const c = ctx();
    expect(promptEvent(c, "hello")).toBeNull();
    c.sessionId = SID;
    expect(promptEvent(c, "hello")?.hook_event_type).toBe("UserPromptSubmit");
  });
});

describe("the transcript", () => {
  function fixture() {
    // realpath, because inScope resolves the session directory and a temp dir
    // behind a symlink would otherwise fail the prefix check.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-hermes-db-")));
    const inside = join(dir, "repo");
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, actual_cost_usd REAL, estimated_cost_usd REAL)`);
    db.run(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL)`);
    db.run(`INSERT INTO sessions VALUES (?, ?, 0, 0.01)`, [SID, inside]);
    db.run(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, 'user', 'hello', NULL, 1790000001)`, [SID]);
    db.run(
      `INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, 'assistant', 'working', ?, 1790000002)`,
      [SID, JSON.stringify([{ id: "call_1", function: { name: "terminal", arguments: { command: "ls" } } }])],
    );
    db.run(
      `INSERT INTO messages (session_id, role, content, tool_call_id, tool_name, timestamp) VALUES (?, 'tool', 'ok', 'call_1', 'terminal', 1790000003)`,
      [SID],
    );
    const outside = "20260101_000000_abc123";
    db.run(`INSERT INTO sessions VALUES (?, '/tmp/somewhere-else', 0, 0)`, [outside]);
    db.close();
    return { dir, dbPath, inside, outside };
  }

  test("replays messages and the tool that ran between them", () => {
    const { dir, dbPath } = fixture();
    const timeline = hermesTranscript(SID, dbPath, dir);
    expect(timeline.map((e) => e.kind)).toEqual(["message", "message", "tool"]);
    const tool = timeline.find((e) => e.kind === "tool");
    expect(tool?.tool).toBe("terminal");
    expect(tool?.target).toBe("ls");
    expect(tool?.output).toBe("ok");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a session outside the open project is not readable", () => {
    const { dir, dbPath, outside } = fixture();
    expect(hermesTranscript(outside, dbPath, dir)).toEqual([]);
    expect(hermesResumeAllowed(outside, dbPath, dir)).toBe(false);
    expect(hermesResumeAllowed(SID, dbPath, dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a cost delta is the growth since the baseline, and zero is not a figure", () => {
    const { dir, dbPath } = fixture();
    expect(hermesTurnCost(SID, 0, dbPath)).toBeCloseTo(0.01);
    expect(hermesTurnCost(SID, 0.01, dbPath)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rows fold the same way without a database", () => {
    const timeline = hermesRowsToTimeline([
      { id: 1, role: "user", content: "hi", tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 10 },
    ]);
    expect(timeline).toEqual([{ kind: "message", role: "user", text: "hi", ts: 10_000 }]);
  });
});
