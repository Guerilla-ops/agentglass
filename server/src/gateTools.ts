import type { GateToolsPolicy } from "../../shared/types.ts";
import { readGateTools, inScope } from "./config.ts";
import { paneForSession, paneAgentNote } from "./panewt.ts";

/**
 * Tool allow/deny rules for the gate (#109).
 *
 * The spend threshold already annotates a hold when a project is over budget
 * (see budget.ts). This is the other half of "hold by rule": a static list of
 * tools that may proceed, and a list that may not, evaluated when /gate is
 * POSTed — before a human is asked.
 *
 * v1 behaviour, deliberately small:
 *   - denylist hit  → hard deny with a reason (no wait)
 *   - allowlist hit → auto-allow (no wait); history keeps the reason, the
 *     HTTP body returns an empty reason so the hook takes allow_silently()
 *     and Claude Code's own permissions still apply
 *   - allowlist set and tool not on it → soft hold (surfaces in What needs you)
 *   - neither list set for the matching scope → unchanged human gate
 *
 * Matching: every policy whose root covers the session cwd contributes its
 * denylist (any hit → deny). Allow and soft-hold come only from the longest
 * matching root — a more-specific allow-only row cannot escape an ancestor
 * deny. Unknown cwd (`""`, no pane note) still applies denials from the
 * global row, but never auto-allows or soft-holds: fall through to the human
 * gate instead of guessing.
 *
 * Lives beside the gate rather than inside it for the same reason budgetHoldFor
 * does: reaching config from gate.ts would pull the database layer into every
 * consumer of the gate at load time. The route already imports both halves.
 *
 * Never throws. A corrupt config or a missing pane note must not turn /gate
 * into a 500 — fail-open hooks would allow, fail-closed ones would deny, and
 * neither is a decision a rule should make by crashing.
 */

export type GateToolsVerdict =
  | { kind: "allow"; reason: string }
  | { kind: "deny"; reason: string }
  | { kind: "hold"; reason: string };

/** Longest matching root among policies that cover cwd. Blank root matches
 *  everything and loses to any more specific one that also covers the cwd. */
function mostSpecific(matching: GateToolsPolicy[]): GateToolsPolicy | null {
  let best: GateToolsPolicy | null = null;
  for (const p of matching) {
    if (!best || p.root.length > best.root.length) best = p;
  }
  return best;
}

/** Exact tool-name match. Claude Code names (`Bash`, `Read`) and MCP verbs
 *  (`mcp__x__y`) are compared as the hook sent them — no case folding, no
 *  globbing. A typo in the list is a miss, which for an allowlist means a hold
 *  and for a denylist means the call is not stopped; both are recoverable. */
function listed(names: string[], tool: string): boolean {
  return names.includes(tool);
}

/**
 * What a configured rule says about this tool call, or null when no rule
 * applies (no config, no matching root, or a matching row with neither list
 * that fires — deny miss + empty allow, or unknown cwd with no deny hit).
 */
export function evaluateGateTools(
  toolName: string,
  cwd: string,
  policies: GateToolsPolicy[] = readGateTools(),
): GateToolsVerdict | null {
  if (!toolName || !policies.length) return null;

  const matching = policies.filter((p) => inScope(cwd, p.root));
  if (!matching.length) return null;

  // Deny = union across every matching row. A more-specific allow-only policy
  // must not erase an ancestor's hard stop.
  for (const p of matching) {
    if (p.deny.length && listed(p.deny, toolName)) {
      return {
        kind: "deny",
        reason:
          `Denied by agentglass tool denylist (${toolName}). Do not retry the same call — it will be denied again. Use a different tool, or ask a person to change the denylist.`,
      };
    }
  }

  // Unknown cwd: denials still bind (global root:"" matched above), but never
  // auto-allow or soft-hold — we cannot place the session, so the human gate
  // decides. Project denylists still cannot bind without a cwd.
  if (!cwd) return null;

  const best = mostSpecific(matching);
  if (!best) return null;

  if (best.allow.length) {
    if (listed(best.allow, toolName)) {
      return {
        kind: "allow",
        // Stored on the history row via resolveByRule; the /gate route returns
        // reason: "" to the hook so Claude Code's own permissions still apply.
        reason: `Allowed by agentglass tool allowlist (${toolName}).`,
      };
    }
    const sample = best.allow.slice(0, 8).join(", ") + (best.allow.length > 8 ? ", …" : "");
    return {
      kind: "hold",
      reason:
        `Not on the tool allowlist (${toolName}; allowed: ${sample}) — held for a human to decide.`,
    };
  }

  // Deny-only (or no allow on the most-specific row) and this tool is not on
  // any matching denylist: fall through to the normal human hold.
  return null;
}

/**
 * The rule verdict for a gated call, or null when none applies.
 *
 * Resolves the session's cwd the same way budgetHoldFor does — from the pane
 * note the hook recorded — so a project-scoped rule can match without the gate
 * payload carrying a path.
 */
export function gateToolsFor(session: string, toolName: string): GateToolsVerdict | null {
  try {
    const pane = paneForSession(session);
    const cwd = pane ? paneAgentNote(pane)?.cwd ?? "" : "";
    return evaluateGateTools(toolName, cwd);
  } catch (e) {
    console.warn("[gate] tool policy check skipped:", e instanceof Error ? e.message : e);
    return null;
  }
}
