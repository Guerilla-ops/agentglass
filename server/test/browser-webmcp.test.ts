/*
 * `tools` reads what a page offers an agent and `call-tool` runs one of those
 * offers. Both are behind a flag, because a page's tool description is text
 * somebody else wrote and an agent will read it: the fence is decided here, in
 * the server, before anything reaches a window.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BROWSER_OPS, parseAsk, redactAskForTest } from "../src/browserdrive.ts";

const FLAG = "AGENTGLASS_BROWSER_WEBMCP";
beforeEach(() => { process.env[FLAG] = "1"; });
afterEach(() => {
  delete process.env[FLAG];
  delete process.env.AGENTGLASS_BROWSER_READONLY;
});

describe("the flag", () => {
  test("both verbs exist", () => {
    expect(BROWSER_OPS).toContain("tools");
    expect(BROWSER_OPS).toContain("call-tool");
  });

  test("without it, both are refused and the refusal names the flag", () => {
    delete process.env[FLAG];
    for (const [op, body] of [["tools", {}], ["call-tool", { name: "add_to_cart" }]] as const) {
      const p = parseAsk(op, body);
      if (!("error" in p)) throw new Error(`${op} was accepted with the flag off`);
      expect(p.error).toContain(FLAG);
    }
  });

  test("only the exact value 1 turns it on", () => {
    for (const v of ["0", "true", "yes", ""]) {
      process.env[FLAG] = v;
      expect("error" in parseAsk("tools", {})).toBe(true);
    }
    process.env[FLAG] = "1";
    expect("ask" in parseAsk("tools", {})).toBe(true);
  });
});

describe("call-tool's arguments", () => {
  test("a name is required, and short and single-line", () => {
    expect("error" in parseAsk("call-tool", {})).toBe(true);
    expect("error" in parseAsk("call-tool", { name: "" })).toBe(true);
    expect("error" in parseAsk("call-tool", { name: "a\nb" })).toBe(true);
    expect("error" in parseAsk("call-tool", { name: "x".repeat(101) })).toBe(true);
  });

  test("args must be an object no bigger than 20 KB", () => {
    expect("error" in parseAsk("call-tool", { name: "t", args: [1] })).toBe(true);
    expect("error" in parseAsk("call-tool", { name: "t", args: "str" })).toBe(true);
    expect("error" in parseAsk("call-tool", { name: "t", args: { big: "x".repeat(20_001) } })).toBe(true);
    const ok = parseAsk("call-tool", { name: "t", args: { sku: "ORBIT-1042" } });
    if (!("ask" in ok)) throw new Error("refused a good call");
    expect(ok.ask.args).toEqual({ name: "t", args: { sku: "ORBIT-1042" } });
  });

  test("args default to an empty object", () => {
    const ok = parseAsk("call-tool", { name: "t" });
    if (!("ask" in ok)) throw new Error("refused a good call");
    expect(ok.ask.args.args).toEqual({});
  });
});

describe("read-only mode", () => {
  test("refuses call-tool, which acts, and still lets tools look", () => {
    process.env.AGENTGLASS_BROWSER_READONLY = "1";
    const c = parseAsk("call-tool", { name: "add_to_cart" });
    if (!("error" in c)) throw new Error("read-only mode ran a page tool");
    expect(c.error).toContain("read-only");
    expect("ask" in parseAsk("tools", {})).toBe(true);
  });
});

describe("the audit row", () => {
  test("every argument value is blanked and the names stay, whatever the page called them", () => {
    const out = redactAskForTest("call-tool", { name: "login", args: {
      username: "a@orbit.example", password: "hunter2-Orbit", cvv: "123", card: "4111111111111111", note: "ghp_" + "a".repeat(30),
    } });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|4111|123"|ghp_|a@orbit/);
    expect(Object.keys(out.args as object).sort()).toEqual(["card", "cvv", "note", "password", "username"]);
    expect(out.name).toBe("login");
  });

  test("a call with no args logs an empty object", () => {
    expect(redactAskForTest("call-tool", { name: "t", args: {} }).args).toEqual({});
  });
});

describe("timeouts and the tool list", () => {
  const src = readFileSync(new URL("../src/browserdrive.ts", import.meta.url), "utf8");
  test("tools waits 15 s and call-tool 30 s", () => {
    expect(src).toMatch(/tools: 15_000/);
    expect(src).toMatch(/"call-tool": 30_000/);
  });

  test("the MCP keeps both out of the core profile", () => {
    const mcp = readFileSync(new URL("../../bin/agentglass-browser-mcp", import.meta.url), "utf8");
    const core = mcp.slice(mcp.indexOf("CORE_TOOLS = ("), mcp.indexOf(")\n", mcp.indexOf("CORE_TOOLS = (")));
    expect(core).not.toContain('"tools"');
    expect(core).not.toContain('"call-tool"');
    expect(mcp).toContain('"browser_tools"');
    expect(mcp).toContain('"browser_call-tool"');
  });

  test("the skill says the DOM path stays the default", () => {
    const skill = readFileSync(new URL("../../skills/browser-use/SKILL.md", import.meta.url), "utf8");
    expect(skill).toMatch(/DOM path stays the default/);
    expect(skill).toContain("AGENTGLASS_BROWSER_WEBMCP");
  });
});
