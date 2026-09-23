// Search must honour the same cockpit window + provider scope as /stats (#248 F14).
//
// Project scope was already applied; the time window and provider chip were not,
// so Search returned hits from outside the header filters while every other pane
// respected them. These drive the real query layer against a throwaway DB.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-search-scope-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "search-scope.db");
process.env.AGENTGLASS_ROOT = ROOT;
process.env.XDG_CONFIG_HOME = dir;

let db: typeof import("../src/db.ts");

const NOW = Date.now();
const RECENT = NOW - 30_000;           // 30s ago — inside a 1h window
const OLD = NOW - 3 * 3_600_000;       // 3h ago — outside a 1h window

const event = (
  summary: string,
  session: string,
  over: { timestamp?: number; model?: string | null } = {},
) => ({
  source_app: "proj",
  session_id: session,
  hook_event_type: "PreToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: over.model === undefined ? "claude-opus-4-8" : over.model,
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary,
  timestamp: over.timestamp ?? RECENT,
  payload: { project_path: ROOT, tool_input: { command: summary } },
  chat: null,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  // Unique needles so FTS hits cannot collide with other suite DBs accidentally
  // sharing process state — this file owns its own AGENTGLASS_DB.
  db.insertEvent(event("searchscope recent anthropic needle", "ss-recent-ant", {
    timestamp: RECENT, model: "claude-opus-4-8",
  }) as any);
  db.insertEvent(event("searchscope old anthropic needle", "ss-old-ant", {
    timestamp: OLD, model: "claude-opus-4-8",
  }) as any);
  db.insertEvent(event("searchscope recent openai needle", "ss-recent-oai", {
    timestamp: RECENT, model: "gpt-4o",
  }) as any);
});

describe("search without window/provider filters still works (project scope only)", () => {
  test("both recent and old anthropic events match the shared needle", () => {
    const hits = db.searchEvents("searchscope anthropic needle", 60);
    const sessions = hits.map((h) => h.session_id).sort();
    expect(sessions).toEqual(["ss-old-ant", "ss-recent-ant"]);
  });
});

describe("search with since excludes older events", () => {
  test("a 1h since drops the 3h-old event", () => {
    const since = NOW - 3_600_000;
    const hits = db.searchEvents("searchscope anthropic needle", 60, { since });
    expect(hits.map((h) => h.session_id)).toEqual(["ss-recent-ant"]);
  });
});

describe("search with provider excludes other providers", () => {
  test("OpenAI filter keeps only the gpt event", () => {
    const hits = db.searchEvents("searchscope needle", 60, { provider: "OpenAI" });
    expect(hits.map((h) => h.session_id)).toEqual(["ss-recent-oai"]);
  });

  test("Anthropic filter keeps only the claude events", () => {
    const hits = db.searchEvents("searchscope needle", 60, { provider: "Anthropic" });
    expect(hits.map((h) => h.session_id).sort()).toEqual(["ss-old-ant", "ss-recent-ant"]);
  });

  test("since + provider compose", () => {
    const since = NOW - 3_600_000;
    const hits = db.searchEvents("searchscope needle", 60, { since, provider: "Anthropic" });
    expect(hits.map((h) => h.session_id)).toEqual(["ss-recent-ant"]);
  });
});

describe("ftsQuery rewrite is preserved alongside the new filters", () => {
  test("path-style query still finds its text when filters are open", () => {
    // Reuse the rewrite contract: separators stay as a quoted phrase.
    expect(db.ftsQuery("src/db.ts")).toBe('"src/db.ts"*');
    expect(db.ftsQuery("foo-bar")).toBe('"foo-bar"*');
  });
});
