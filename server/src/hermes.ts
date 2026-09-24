// Multi-chat, Hermes — the fourth agent the chat panel can drive.
//
// Same shape as chat.ts, codex.ts and antigravity.ts: the server runs the CLI
// in a scoped git directory and pipes its JSONL back untranslated. Hermes's
// one-shot form is `hermes chat --query-file - --format stream-json`. The
// prompt goes on stdin, not argv: `--query-file -` is the CLI's own way to
// take arbitrary text without a shell.
//
// Hermes exports neither hooks nor OpenTelemetry, so a chat started here is
// teed into the same ingest path Antigravity uses. A `hermes` you ran in a
// terminal still reports to nobody. The stream's token counts are per turn
// (they add). Hermes's own dollar figure, when state.db has one for the turn,
// is sent as reported_cost_usd so an unknown model is not priced as Sonnet.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AgentModel, IngestBody, TimelineEntry } from "../../shared/types.ts";
import { safeAbs, repoRootOf, gitCapability } from "./git.ts";
import { inScope, chatBypassAllowed, workspaceRoot } from "./config.ts";
import { startKeepalive, drainStderr } from "./chat.ts";
import { stopTree } from "./proctree.ts";
import { hasPrice } from "./pricing.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const err = (message: string, status = 400) => new Response(message + "\n", { status, headers: CORS });

/** How long a turn may produce nothing before we assume Hermes is stuck on a
 *  prompt it cannot ask for here. Only armed before the first byte. Python
 *  cold start is slower than the other CLIs, so the default matches Antigravity. */
const STARTUP_TIMEOUT_MS = Number(process.env.AGENTGLASS_HERMES_STARTUP_TIMEOUT_MS ?? 30_000);
/** The ingest ceiling. A figure past it is dropped rather than failing the turn. */
const MAX_REPORTED_COST_USD = 100_000;

export const HERMES_APP = "hermes";

export function hermesBin(): string | null {
  const env = process.env.AGENTGLASS_HERMES;
  if (env && existsSync(env)) return env;
  return Bun.which("hermes");
}

export const HERMES_ENABLED = (): boolean => !!hermesBin() && process.env.AGENTGLASS_HERMES_DISABLED !== "1";
export const HERMES_BYPASS_ALLOWED = chatBypassAllowed();

// Hermes session ids are `YYYYMMDD_HHMMSS_<hex>` and model ids carry slashes
// (`deepseek/deepseek-v4-flash`). Neither fits the Claude/Codex validators.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$/;
const SESSION_RE = /^\d{8}_\d{6}_[a-f0-9]{6,12}$/;
export const hermesModel = (v: unknown): string => typeof v === "string" && MODEL_RE.test(v) ? v : "";
export const hermesSession = (v: unknown): string => typeof v === "string" && SESSION_RE.test(v) ? v : "";

/** `yolo` is `--yolo`. Anything else, including a bypass the operator has not
 *  opted into, is spelled by leaving the flag off. Single-query mode then
 *  denies approval prompts it cannot show. */
export function hermesMode(mode: unknown, bypassAllowed = HERMES_BYPASS_ALLOWED): "default" | "yolo" {
  return mode === "yolo" && bypassAllowed ? "yolo" : "default";
}

export function hermesArgs(bin: string, cwd: string, model: string, resumeId: string, mode: "default" | "yolo"): string[] {
  const args = [bin, "chat", "--query-file", "-", "--format", "stream-json", "--in", cwd];
  // A resumed session otherwise cds back to the directory it was born in,
  // which can be outside the open project.
  if (resumeId) args.push("--resume", resumeId, "--no-restore-cwd");
  if (model) args.push("--model", model);
  if (mode === "yolo") args.push("--yolo");
  return args;
}

/** Hermes root, before the active profile is applied.
 *
 *  `HERMES_HOME=<root>/profiles/<name>` is already inside a profile, and the
 *  root is the grandparent. Anywhere else, `HERMES_HOME` is the root. Unset,
 *  the root is `~/.hermes`. */
function hermesRoot(): string {
  const env = process.env.HERMES_HOME?.trim();
  if (!env) return join(process.env.HOME || homedir(), ".hermes");
  const parent = dirname(env);
  return basename(parent) === "profiles" ? dirname(parent) : env;
}

/** The directory that holds config.yaml and state.db for the profile Hermes
 *  will actually run. `<root>/active_profile` names it; `default` and a missing
 *  pointer mean the root itself. A name that is not a single path segment is
 *  ignored so the pointer cannot escape the profiles directory. */
export function hermesProfileHome(): string {
  const root = hermesRoot();
  let active = "";
  try { active = readFileSync(join(root, "active_profile"), "utf8").trim(); } catch { /* no pointer */ }
  if (!active || active === "default") return root;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(active)) return root;
  const dir = join(root, "profiles", active);
  return existsSync(dir) ? dir : root;
}

const stateDb = () => process.env.AGENTGLASS_HERMES_DB || join(hermesProfileHome(), "state.db");

function withState<T>(fn: (db: Database) => T, path = stateDb()): T | null {
  if (!existsSync(path)) return null;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return fn(db);
  } catch { return null; }
  finally { db?.close(); }
}

/** The model `hermes` will use when a turn names none. Its catalogue is an
 *  interactive picker, so the dropdown offers this one configured value. */
export function hermesConfiguredModel(path = join(hermesProfileHome(), "config.yaml")): string {
  try {
    const raw = readFileSync(path, "utf8");
    const section = /^model:\s*\n((?:[ \t]+[^\n]*\n?)*)/m.exec(raw)?.[1] ?? "";
    const value = /^\s+default:\s*['"]?([^'"#\s]+)/m.exec(section)?.[1] ?? "";
    return hermesModel(value);
  } catch { return ""; }
}

export function hermesModels(path?: string): AgentModel[] {
  const id = path ? hermesConfiguredModel(path) : hermesConfiguredModel();
  return id ? [{ id, label: id }] : [{ id: "", label: "Hermes default" }];
}

/** Cumulative cost Hermes has recorded for a session, or null when the
 *  database cannot be read. `0` means the row is there and the figure is zero. */
export function hermesAbsoluteCost(id: string, path = stateDb()): number | null {
  const session = hermesSession(id);
  if (!session) return null;
  return withState((db) => {
    const row = db.query<{ actual_cost_usd: number | null; estimated_cost_usd: number | null }, [string]>(
      "SELECT actual_cost_usd, estimated_cost_usd FROM sessions WHERE id = ?",
    ).get(session);
    if (!row) return 0;
    if (typeof row.actual_cost_usd === "number" && row.actual_cost_usd > 0) return row.actual_cost_usd;
    if (typeof row.estimated_cost_usd === "number" && row.estimated_cost_usd >= 0) return row.estimated_cost_usd;
    return 0;
  }, path);
}

/** What this turn added, when both ends of the delta were readable and the
 *  delta is positive. Zero is treated as "not written yet" rather than as a
 *  free turn: reporting 0 would suppress a price the table does have. */
export function hermesTurnCost(id: string, baseline: number | null, path = stateDb()): number | null {
  if (baseline == null) return null;
  const now = hermesAbsoluteCost(id, path);
  if (now == null) return null;
  const delta = now - baseline;
  if (!Number.isFinite(delta) || delta <= 0 || delta > MAX_REPORTED_COST_USD) return null;
  return delta;
}

export function hermesSessionCwd(id: unknown, path = stateDb()): string | null {
  const session = hermesSession(id);
  if (!session) return null;
  return withState((db) => db.query<{ cwd: string | null }, [string]>(
    "SELECT cwd FROM sessions WHERE id = ?",
  ).get(session)?.cwd ?? null, path);
}

/** A scoped cockpit may only resume a session whose recorded directory is in
 *  the open project. Unscoped, the check is the CLI's own. */
export function hermesResumeAllowed(id: string, path = stateDb(), scope = workspaceRoot()): boolean {
  if (!scope) return true;
  const recorded = hermesSessionCwd(id, path);
  return !!recorded && inScope(recorded, scope);
}

const clip = (v: string | null | undefined) => v ? (v.length > 20_000 ? v.slice(0, 20_000) + "\n[trimmed]" : v) : null;

function targetOf(raw: unknown): string | null {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return raw.slice(0, 300); }
  }
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  for (const key of ["command", "cmd", "file_path", "path", "url", "query", "pattern"]) {
    if (typeof input[key] === "string") return input[key].slice(0, 300);
  }
  return null;
}

type MsgRow = {
  id: number; role: string; content: string | null; tool_call_id: string | null;
  tool_calls: string | null; tool_name: string | null; timestamp: number;
};

/** Messages rows, oldest first, folded into the timeline the chat replay uses. */
export function hermesRowsToTimeline(rows: MsgRow[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const calls = new Map<string, TimelineEntry>();
  for (const row of rows) {
    const ts = Math.round(row.timestamp * 1000) || 0;
    if ((row.role === "user" || row.role === "assistant") && row.content) {
      out.push({ kind: "message", role: row.role, text: clip(row.content) ?? "", ts });
    }
    if (row.role === "assistant" && row.tool_calls) {
      let list: unknown;
      try { list = JSON.parse(row.tool_calls); } catch { list = []; }
      for (const call of Array.isArray(list) ? list : [list]) {
        if (!call || typeof call !== "object") continue;
        const c = call as Record<string, unknown>;
        const fn = c.function && typeof c.function === "object" ? c.function as Record<string, unknown> : {};
        const cid = typeof c.id === "string" ? c.id : "";
        const tool = typeof fn.name === "string" ? fn.name : typeof c.name === "string" ? c.name : "tool";
        const entry: TimelineEntry = {
          kind: "tool", ts, tool, target: targetOf(fn.arguments ?? c.arguments),
          tool_use_id: cid || null, output: null, is_error: false,
        };
        out.push(entry);
        if (cid) calls.set(cid, entry);
      }
    }
    if (row.role === "tool") {
      const prior = calls.get(row.tool_call_id ?? "");
      const output = clip(row.content);
      if (prior) prior.output = output;
      else out.push({
        kind: "tool", ts, tool: row.tool_name || "tool", tool_use_id: row.tool_call_id,
        output, target: null, is_error: false,
      });
    }
  }
  return out;
}

/** Hermes keeps the conversation in state.db. Empty when the id is not one of
 *  its sessions, the file is missing, or the session sits outside the open
 *  project — a guessed id must not return another checkout's transcript. */
export function hermesTranscript(id: unknown, path = stateDb(), scope = workspaceRoot()): TimelineEntry[] {
  const session = hermesSession(id);
  if (!session) return [];
  const cwd = hermesSessionCwd(session, path);
  if (!cwd || !inScope(cwd, scope)) return [];
  const rows = withState((db) => db.query<MsgRow, [string]>(
    `SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp
     FROM (SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp
           FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1000) ORDER BY id`,
  ).all(session), path);
  return rows ? hermesRowsToTimeline(rows) : [];
}

// --- putting a chat on the radar --------------------------------------------

export type FrameContext = {
  sessionId: string;
  model: string;
  cwd: string;
  projectPath: string;
  /** tool_call_id → name, so a result that omits the name still pairs. */
  tools: Map<string, string>;
  /** Cumulative cost before this turn. Null when state.db could not be read. */
  costBaseline: number | null;
  /** This turn's dollar delta, filled when the result frame arrives. */
  reportedCost: number | null;
};

export const newFrameContext = (cwd = ""): FrameContext => ({
  sessionId: "",
  model: "",
  cwd,
  projectPath: cwd ? (repoRootOf(cwd) || cwd) : "",
  tools: new Map(),
  costBaseline: null,
  reportedCost: null,
});

const scope = (ctx: FrameContext) => ({
  source_app: HERMES_APP,
  session_id: ctx.sessionId,
  model_name: ctx.model || undefined,
});
const located = (ctx: FrameContext, payload: Record<string, unknown>) => ({
  ...payload,
  ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
  ...(ctx.projectPath ? { project_path: ctx.projectPath } : {}),
});

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;

/** The prompt is not a frame. Emitted once, after the session id is known. */
export function promptEvent(ctx: FrameContext, message: string): IngestBody | null {
  if (!ctx.sessionId || !hermesSession(ctx.sessionId)) return null;
  return {
    ...scope(ctx),
    hook_event_type: "UserPromptSubmit",
    payload: located(ctx, { prompt: message.slice(0, 20_000) }),
  };
}

/**
 * One Hermes stream-json frame as an event, or null for frames that are not
 * events (text deltas, unknowns).
 *
 * Usage on `result` is per turn — this process answered once — so the store
 * adds it. A positive dollar delta Hermes wrote to state.db is
 * `reported_cost_usd`. Without one, a model the price table does not know is
 * recorded at $0 rather than at the Sonnet fallback: that fallback is a guess,
 * and a Hermes model id usually misses the table.
 */
export function frameToEvent(frame: Record<string, unknown>, ctx: FrameContext): IngestBody | null {
  if (frame.type === "system" && frame.subtype === "init") {
    const id = hermesSession(frame.session_id);
    if (!id) return null;
    ctx.sessionId = id;
    const model = hermesModel(frame.model);
    if (model) ctx.model = model;
    return {
      ...scope(ctx),
      hook_event_type: "SessionStart",
      payload: located(ctx, { message: ctx.cwd }),
    };
  }

  if (frame.type === "tool_use") {
    if (!ctx.sessionId) return null;
    const name = typeof frame.name === "string" && frame.name ? frame.name : "tool";
    const id = typeof frame.tool_call_id === "string" && frame.tool_call_id
      ? frame.tool_call_id
      : `h${ctx.tools.size}`;
    ctx.tools.set(id, name);
    const input = frame.input && typeof frame.input === "object" ? frame.input as Record<string, unknown> : {};
    return {
      ...scope(ctx),
      hook_event_type: "PreToolUse",
      payload: located(ctx, { tool_name: name, tool_use_id: id, tool_input: input }),
    };
  }

  if (frame.type === "tool_result") {
    if (!ctx.sessionId) return null;
    const id = typeof frame.tool_call_id === "string" ? frame.tool_call_id : "";
    const name = typeof frame.name === "string" && frame.name ? frame.name : ctx.tools.get(id) ?? "";
    if (!name) return null;
    const output = typeof frame.output === "string" ? frame.output.slice(0, 20_000) : "";
    return {
      ...scope(ctx),
      hook_event_type: frame.is_error === true ? "PostToolUseFailure" : "PostToolUse",
      payload: located(ctx, { tool_name: name, tool_use_id: id || null, tool_response: output }),
    };
  }

  if (frame.type === "result") {
    const id = hermesSession(frame.session_id);
    if (id) ctx.sessionId = ctx.sessionId || id;
    if (!ctx.sessionId) return null;
    const tokens = frame.tokens && typeof frame.tokens === "object" ? frame.tokens as Record<string, unknown> : {};
    const usage = {
      input_tokens: num(tokens.input),
      output_tokens: num(tokens.output),
      cache_read_tokens: num(tokens.cache_read),
      cache_creation_tokens: num(tokens.cache_write),
    };
    const body: IngestBody = {
      ...scope(ctx),
      hook_event_type: "Turn complete",
      payload: located(ctx, { usage, message: typeof frame.error === "string" ? frame.error : "" }),
    };
    const cost = ctx.reportedCost;
    if (typeof cost === "number" && cost > 0 && cost <= MAX_REPORTED_COST_USD) body.reported_cost_usd = cost;
    else if (!hasPrice(ctx.model)) body.reported_cost_usd = 0;
    return body;
  }

  return null;
}

const active = new Set<string>();
export const hermesActiveTurns = (): string[] => [...active];

/** Start one Hermes turn. The prompt is the process's stdin. */
export function hermesStream(
  cwd: unknown,
  message: unknown,
  model: unknown,
  resumeId: unknown,
  mode: unknown,
  images?: unknown,
  emit?: (body: IngestBody) => void,
): Response {
  const bin = hermesBin();
  if (!bin) return err("no local `hermes` CLI — install Hermes to chat", 403);
  if (process.env.AGENTGLASS_HERMES_DISABLED === "1") return err("Hermes chat is disabled (AGENTGLASS_HERMES_DISABLED=1)", 403);
  const dir = safeAbs(cwd);
  if (!dir || !repoRootOf(dir)) {
    const cap = gitCapability();
    return err(cap.available ? "invalid or non-repo directory" : cap.reason || "git is not installed");
  }
  if (!inScope(dir)) return err("outside the open project — open the parent folder to work across repos", 403);
  if (Array.isArray(images) && images.length) return err("Hermes chats cannot take pasted images yet — send the turn without it, or use a Claude chat");
  if (typeof message !== "string" || !message.trim() || message.length > 100_000) return err("invalid message");
  if (resumeId && !hermesSession(resumeId)) return err("invalid Hermes session id");
  if (model && !hermesModel(model)) return err("invalid Hermes model id");
  const rid = hermesSession(resumeId);
  if (rid && active.has(rid)) return err("that Hermes session is mid-turn — wait for it to finish", 409);
  if (rid && !hermesResumeAllowed(rid)) return err("that Hermes session is not in the open project", 403);
  const selected = hermesMode(mode);
  const args = hermesArgs(bin, dir, hermesModel(model), rid, selected);

  // Its own process group when `setsid` exists, so stopping a turn reaches the
  // shells Hermes starts. Same spelling as antigravity.ts: on macOS the binary
  // is usually absent and the direct child is what gets stopped.
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
    cwd: dir,
    stdin: new TextEncoder().encode(message),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const stderr = drainStderr(proc.stderr as ReadableStream<Uint8Array>);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ctx = newFrameContext(dir);
  // A new session has no row yet, so the baseline is zero when the database
  // can be read and unknown when it cannot. A probe id matches the session
  // shape and is not a real row; a failed open returns null.
  ctx.costBaseline = rid
    ? hermesAbsoluteCost(rid)
    : (hermesAbsoluteCost("00000000_000000_000000") === null ? null : 0);

  let cancelled = false;
  let busyId = rid;
  if (rid) active.add(rid);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (busyId) active.delete(busyId);
  };
  const noteSession = (id: string) => {
    if (!id || busyId === id) return;
    if (busyId) active.delete(busyId);
    busyId = id;
    active.add(id);
  };

  let pending = "";
  let prompted = false;
  const prompt = message;
  const feed = (chunk: Uint8Array | null) => {
    pending += chunk ? dec.decode(chunk, { stream: true }) : "\n";
    for (;;) {
      const nl = pending.indexOf("\n");
      if (nl < 0) break;
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(line) as Record<string, unknown>; }
      catch { continue; }
      const seen = hermesSession(frame.session_id);
      if (seen) {
        noteSession(seen);
        if (!ctx.sessionId) ctx.sessionId = seen;
      }
      if (frame.type === "result" && ctx.sessionId) ctx.reportedCost = hermesTurnCost(ctx.sessionId, ctx.costBaseline);
      if (!emit) continue;
      try {
        const ev = frameToEvent(frame, ctx);
        if (ev) emit(ev);
        if (!prompted && ctx.sessionId) {
          prompted = true;
          const row = promptEvent(ctx, prompt);
          if (row) emit(row);
        }
      } catch { /* a bad frame is the browser's problem */ }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const stopKeepalive = startKeepalive(controller);
      let firstByte = false;
      const watchdog = setTimeout(() => {
        if (firstByte || cancelled) return;
        const hint = stderr.soFar().trim();
        try {
          controller.enqueue(enc.encode(JSON.stringify({
            type: "agx_error",
            code: null,
            errorType: "first_run_setup_required",
            setupCommand: "hermes model",
            error: hint || `Hermes produced no output in ${STARTUP_TIMEOUT_MS / 1000}s — run \`hermes model\` in a terminal to configure a provider, then try again.`,
          }) + "\n"));
        } catch { /* the client already went away */ }
        stopTree(proc, !!setsid);
      }, STARTUP_TIMEOUT_MS);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            firstByte = true;
            clearTimeout(watchdog);
            feed(value);
            controller.enqueue(value);
          }
        }
      } catch { /* closed */ }
      feed(null);
      clearTimeout(watchdog);
      stopKeepalive();
      const code = await proc.exited;
      release();
      if (cancelled) return;
      if (code !== 0) {
        const why = (await stderr.all).trim();
        controller.enqueue(enc.encode(JSON.stringify({ type: "agx_error", code, error: why || `Hermes exited ${code}` }) + "\n"));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
      release();
      stopTree(proc, !!setsid);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...CORS },
  });
}
