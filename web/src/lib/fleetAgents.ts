/**
 * Live AgentCards for surfaces that are not under the dashboard tree.
 *
 * Diff and SessionModal need the same fleet Fleet already has, so they can
 * flag shared working trees. App publishes; consumers subscribe. No extra poll.
 */
import type { AgentCard } from "./derive.ts";

let agents: readonly AgentCard[] = [];
const listeners = new Set<() => void>();

function tell(): void {
  for (const l of listeners) {
    try { l(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** App writes the derived fleet here whenever it recomputes. */
export function publishAgents(next: readonly AgentCard[]): void {
  agents = next;
  tell();
}

export function agentsOf(): readonly AgentCard[] {
  return agents;
}

export function subscribeAgents(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
