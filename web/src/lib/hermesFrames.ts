// Hermes stream-json frames folded into the shared chat transcript.
//
// The CLI writes `system/init`, `text` deltas, `tool_use` / `tool_result`,
// and one `result`. Text is appended. The result's `text` is used only when
// no delta arrived. Token counts on `result` are this turn's, so they add.
// The stream does not carry a price; the fleet reads Hermes's own figure from
// state.db. Guessing one here would disagree with that.
import type { Chat, ChatTool, ChatUsage } from "./chatStore.ts";

const str = (v: unknown): string | null => typeof v === "string" && v.length ? v : null;
const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
const MAX_OUTPUT = 20_000;
const clip = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n[trimmed]" : text;
};

function inputOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const o: unknown = JSON.parse(v);
      if (o && typeof o === "object") return o as Record<string, unknown>;
    } catch { return { command: v }; }
  }
  return {};
}

function targetOf(input: Record<string, unknown>): string | null {
  for (const key of ["command", "cmd", "file_path", "path", "url", "query", "pattern"]) {
    const value = str(input[key]);
    if (value) return value.slice(0, 300);
  }
  return null;
}

function reply(c: Chat) {
  const last = c.messages[c.messages.length - 1];
  if (last?.role === "assistant") return last;
  const next = { role: "assistant" as const, text: "", tools: [] as ChatTool[], ts: Date.now() };
  c.messages.push(next);
  return next;
}

function addUsage(prev: ChatUsage | undefined, tokens: Record<string, unknown>): ChatUsage {
  const input = num(tokens.input);
  const output = num(tokens.output);
  const cacheRead = num(tokens.cache_read);
  const cacheWrite = num(tokens.cache_write);
  return {
    input: (prev?.input ?? 0) + input,
    output: (prev?.output ?? 0) + output,
    cacheRead: (prev?.cacheRead ?? 0) + cacheRead,
    cacheWrite: (prev?.cacheWrite ?? 0) + cacheWrite,
    // The latest prompt size is the context, not the sum of every turn's.
    contextTokens: input + cacheRead + cacheWrite,
    costUsd: prev?.costUsd ?? 0,
  };
}

export function applyHermesFrame(c: Chat, frame: Record<string, unknown>): void {
  switch (frame.type) {
    case "system": {
      if (frame.subtype !== "init") return;
      const id = str(frame.session_id);
      if (id) { c.sessionId = id; c.liveFrom = Date.now(); }
      const model = str(frame.model);
      if (model) c.resolvedModel = model;
      return;
    }
    case "text": {
      const delta = str(frame.text);
      if (delta) reply(c).text += delta;
      return;
    }
    case "tool_use": {
      const name = str(frame.name) ?? "tool";
      const input = inputOf(frame.input);
      const row: ChatTool = {
        id: str(frame.tool_call_id) ?? str(frame.id) ?? `hermes-${Date.now()}-${reply(c).tools.length}`,
        name, target: targetOf(input), output: null, error: false, ts: Date.now(),
      };
      reply(c).tools.push(row);
      return;
    }
    case "tool_result": {
      const rows = reply(c).tools;
      const id = str(frame.tool_call_id) ?? str(frame.id);
      const name = str(frame.name);
      const row = [...rows].reverse().find((r) => r.output === null && (id ? r.id === id : !name || r.name === name));
      if (!row) return;
      row.output = clip(frame.output);
      row.error = frame.is_error === true;
      return;
    }
    case "result": {
      const id = str(frame.session_id);
      if (id && !c.sessionId) c.sessionId = id;
      const last = reply(c);
      if (!last.text && str(frame.text)) last.text = String(frame.text);
      const tokens = frame.tokens && typeof frame.tokens === "object" ? frame.tokens as Record<string, unknown> : {};
      c.usage = addUsage(c.usage, tokens);
      if (num(frame.exit_code) !== 0) {
        const why = str(frame.error) ?? "Hermes ended without completing the turn";
        last.text += `${last.text ? "\n" : ""}[error] ${why}`;
        c.attention = "blocked";
      }
      return;
    }
  }
}
