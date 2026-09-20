/*
 * "Install this plugin", from somewhere that cannot reach the Plugins pane.
 *
 * The catalogue is a web page and the app is this window; the only thing a
 * browser can hand across is a link, and the desktop shell turns
 * `agentglass://plugin/install?url=…` into one of these. The same one-slot
 * idiom as prJump.ts and openSettings.ts, for the same reason: the sender does
 * not know whether the Plugins pane is mounted, and does not have to.
 *
 * WHAT ARRIVES IS A REQUEST, NEVER AN INSTALL. The pane opens its install box
 * with the URL already in it; the person presses Install, reads what the
 * plugin declares, and switches it on. A link from a page nobody vetted may
 * ask, and only the person answers — which is the same gate a URL pasted by
 * hand goes through.
 */

export type PluginInstallRequest = {
  /** The git URL to install from, as the link carried it. */
  url: string;
  /** Rises per request, so asking twice for the same plugin is two requests
   *  rather than one the pane has already served. */
  n: number;
};

let pending: PluginInstallRequest | null = null;
const subs = new Set<() => void>();

export function subscribePluginInstall(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function pluginInstallRequest(): PluginInstallRequest | null { return pending; }

export function requestPluginInstall(url: string): void {
  pending = { url, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}

/** Cleared by the pane once it has opened its box with this in it — not on
 *  arrival, so a request made while the pane was still mounting is not lost. */
export function clearPluginInstall(): void {
  pending = null;
  subs.forEach((f) => f());
}
