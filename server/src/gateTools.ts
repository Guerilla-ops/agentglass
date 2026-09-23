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
 *   - allowlist hit → auto-allow with a reason (no wait; skips Claude's prompt)
 *   - allowlist set and tool not on it → soft hold (surfaces in What needs you)
 *   - neither list set for the matching scope → unchanged human gate
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

/** Longest matching root wins — same instinct as #14's path match, without
 *  boiling the rest of that proposal. A blank root matches everything and loses
 *  to any more specific one that also covers the cwd. */
function pickPolicy(cwd: string, policies: GateToolsPolicy[]): GateToolsPolicy | null {
  let best: GateToolsPolicy | null = null;
  for (const p of policies) {
    if (!inScope(cwd, p.root)) continue;
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
 * applies (no config, no matching root, or a matching row with neither list).
 */
export function evaluateGateTools(
  toolName: string,
  cwd: string,
  policies: GateToolsPolicy[] = readGateTools(),
): GateToolsVerdict | null {
  if (!toolName || !policies.length) return null;
  const policy = pickPolicy(cwd, policies);
  if (!policy) return null;

  if (policy.deny.length && listed(policy.deny, toolName)) {
    return {
      kind: "deny",
      reason:
        `Denied by agentglass tool denylist (${toolName}). Do not retry the same call — it will be denied again. Use a different tool, or ask a person to change the denylist.`,
    };
  }

  if (policy.allow.length) {
    if (listed(policy.allow, toolName)) {
      return {
        kind: "allow",
        reason: `Allowed by agentglass tool allowlist (${toolName}).`,
      };
    }
    const sample = policy.allow.slice(0, 8).join(", ") + (policy.allow.length > 8 ? ", …" : "");
    return {
      kind: "hold",
      reason:
        `Not on the tool allowlist (${toolName}; allowed: ${sample}) — held for a human to decide.`,
    };
  }

  // Deny-only policy and this tool is not on it: fall through to the normal
  // human hold. The denylist is a hard stop, not an allowlist-by-absence.
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
