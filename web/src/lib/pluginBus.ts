/**
 * "A plugin drew something" — one signal, every consumer. The same shape as
 * understudyBus, for the same reason: the app holds one /stream socket and
 * `useLive` announces what arrives on it. Unlike the understudy frame this one
 * carries no content, only where to look again (a panel list, or one pull
 * request), because what a plugin drew is fetched over the token rather than
 * broadcast to every client on the socket.
 */
export type PluginFrame = { kind: "panels"; plugin?: string; panel?: string } | { kind: "pr"; repo: string; number: number };

const listeners = new Set<(frame: PluginFrame) => void>();

export function emitPlugin(frame: PluginFrame): void {
  for (const fn of listeners) {
    try { fn(frame); } catch { /* one bad listener must not stop the rest */ }
  }
}

export function subscribePluginFrame(fn: (frame: PluginFrame) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
