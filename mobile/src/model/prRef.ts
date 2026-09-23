/*
 * Which pull request a GitHub link names.
 *
 * Linked pull requests on an issue and on a card opened the BROWSER, which is
 * the one place a phone app should send you last: the pull request screen is
 * right here and reads the same thing. It needs a checkout on the computer as
 * well as a number, so the link's `owner/name` is what the computer is asked to
 * find (`/prs/locate`), and the browser is only the fallback when it has none.
 */
export interface PrRef { repo: string; number: number }

export function prRef(url: string): PrRef | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(url.trim());
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

/** The `owner/name` of any GitHub link — an issue's own URL included. */
export function repoOf(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)(?:[/?#]|$)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}
