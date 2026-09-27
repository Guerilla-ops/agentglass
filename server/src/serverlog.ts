/*
 * The server's console.error / console.warn, kept.
 *
 * They used to go to stderr and nowhere else: Electron holds a rolling tail of
 * the child's stderr in memory and writes it to disk only when the server DIES,
 * so an error the server logged and recovered from left no trace once the
 * process kept running. Measured: the recurring ones were invisible until
 * somebody was watching the terminal at the moment.
 *
 * One JSON line per entry, one rotation at LOG_MAX (two files is the whole
 * policy, as with the browser audit log), owner-only. Logging never breaks what
 * it logs: an unwritable disk is a blind spot again, not a thrown error inside
 * an error handler.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { parseLog, type LogEntry, type LogLevel } from "./logdigest.ts";

export const LOG_MAX = 1024 * 1024;
const LINE_MAX = 2000;

export function serverLogPath(): string | null {
  const named = process.env.AGENTGLASS_SERVER_LOG;
  if (named) return named;
  if (process.env.NODE_ENV === "test") return null;
  const dir = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, "server-errors.log");
  } catch { return null; }
}

export function formatEntry(level: LogLevel, args: unknown[], at: number): string | null {
  let text: string;
  try { text = format(...args); } catch { return null; }
  return JSON.stringify({ at, level, text: text.slice(0, LINE_MAX) });
}

export function appendEntry(path: string, level: LogLevel, args: unknown[], at = Date.now()): void {
  const line = formatEntry(level, args, at);
  if (!line) return;
  try {
    try {
      if (statSync(path).size > LOG_MAX) renameSync(path, `${path}.1`);
    } catch { /* no file yet, or it cannot be rotated: append anyway */ }
    appendFileSync(path, line + "\n", { mode: 0o600 });
  } catch { /* said above */ }
}

/** Both files, oldest first. A missing file is an empty log. */
export function readEntries(path: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const p of [`${path}.1`, path]) {
    try { out.push(...parseLog(readFileSync(p, "utf8"))); } catch { /* absent */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

let installed = false;

/** Tap console.error/warn once; the original still prints. Returns the path
 *  logged to, or null when there is none (tests, unwritable state dir). */
export function installServerLog(): string | null {
  const path = serverLogPath();
  if (!path || installed) return path;
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      appendEntry(path, level, args);
    };
  }
  appendEntry(path, "boot", ["server started"]);
  return path;
}
