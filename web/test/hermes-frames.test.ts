import { beforeAll, describe, expect, test } from "bun:test";

let frames: typeof import("../src/lib/hermesFrames.ts");
beforeAll(async () => {
  (globalThis as any).location ??= new URL("http://localhost:5173/");
  (globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  frames = await import("../src/lib/hermesFrames.ts");
});

const SID = "20260917_104709_fdc54d";
const chat = () => ({
  id: "c1", cwd: "/repo", agent: "hermes", model: "",
  mode: "default", title: "t", messages: [{ role: "assistant", text: "", tools: [], ts: 1 }],
  sessionId: "", sending: true, draft: "", attachments: [], queued: [],
  createdAt: 1, abort: null, unread: false, attention: "none",
}) as any;

describe("hermes frames", () => {
  test("init adopts the session and the model that actually ran", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "system", subtype: "init", session_id: SID, model: "deepseek/deepseek-v4-flash" });
    expect(c.sessionId).toBe(SID);
    expect(c.resolvedModel).toBe("deepseek/deepseek-v4-flash");
  });

  test("text deltas concatenate", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "text", text: "hel" });
    frames.applyHermesFrame(c, { type: "text", text: "lo" });
    expect(c.messages[0].text).toBe("hello");
  });

  test("a tool result attaches to the call id the stream actually sends", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "tool_use", name: "terminal", tool_call_id: "call_1", input: { command: "ls" } });
    frames.applyHermesFrame(c, { type: "tool_result", tool_call_id: "call_1", output: "ok", is_error: false });
    expect(c.messages[0].tools[0]).toMatchObject({ id: "call_1", name: "terminal", target: "ls", output: "ok", error: false });
  });

  test("usage adds across turns and does not invent a price", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "result", session_id: SID, exit_code: 0, text: "", tokens: { input: 10, output: 4, cache_read: 1, cache_write: 2 } });
    frames.applyHermesFrame(c, { type: "result", exit_code: 0, tokens: { input: 3, output: 1, cache_read: 0, cache_write: 0 } });
    expect(c.usage).toMatchObject({ input: 13, output: 5, cacheRead: 1, cacheWrite: 2, costUsd: 0 });
    // Context is the latest prompt, not the sum.
    expect(c.usage.contextTokens).toBe(3);
  });

  test("a failed turn says so on the reply", () => {
    const c = chat();
    frames.applyHermesFrame(c, { type: "result", exit_code: 1, error: "no provider", tokens: {} });
    expect(c.messages[0].text).toContain("no provider");
    expect(c.attention).toBe("blocked");
  });
});
