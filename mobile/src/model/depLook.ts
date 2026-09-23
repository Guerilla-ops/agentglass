/*
 * What each dependency status is called on the phone, and how loud it is.
 *
 * Typed against the server's own `DepStatus` rather than a list written here,
 * because the list written here was one short. `/dependencies` answers
 * `unsupported` for a tool a platform does not use — Docker Desktop on Linux,
 * `apt` on a Mac — and the Troubleshooting screen indexed a three-entry table
 * with it: `LOOK[dep.status]` was `undefined`, `.word` on that threw, and the
 * screen somebody opens to find out why things are broken was itself the thing
 * that was broken. A `Record<DepStatus, …>` cannot be one short; `tsc` says so.
 *
 * The words are the desk's (web/src/components/SettingsModal.tsx): the two
 * surfaces describe one machine, and two vocabularies for one fact is how they
 * drift.
 */
import type { DepStatus } from "../../../shared/deps.ts";

/** Which ink the row takes. Resolved to a colour by the screen, which owns the
 *  palette; this file only knows how serious each status is. */
export type DepTone = "good" | "warn" | "bad" | "mute";

export const DEP_LOOK: Record<DepStatus, { word: string; tone: DepTone }> = {
  ok: { word: "installed", tone: "good" },
  attention: { word: "needs a look", tone: "warn" },
  missing: { word: "missing", tone: "bad" },
  // Not a problem, so not a warning colour: there is nothing to install and
  // nothing to do, and a row that looked broken would send somebody to the
  // computer to fix a tool their platform never uses.
  unsupported: { word: "not used here", tone: "mute" },
};

/**
 * Does this row belong in the "what is wrong" set — expanded from the start,
 * and counted against "everything is installed"?
 *
 * `unsupported` does not: it is neither installed nor absent, and counting it
 * would make the summary line say something is missing on every machine that
 * has a platform.
 */
export const depNeedsAttention = (status: DepStatus): boolean =>
  status === "attention" || status === "missing";

/**
 * The one line at the top of Troubleshooting: how many tools were found, and
 * whether what is missing matters.
 *
 * The screen was a list of twenty rows with a dot each, and the answer to the
 * question somebody arrives with — is anything I need missing — had to be
 * counted off it. A required tool missing is red and said first; an optional
 * one is amber and said as optional; "not used here" is neither, and counts as
 * neither found nor missing.
 */
export function depSummary(deps: { status: DepStatus; required: boolean }[]): {
  tone: "good" | "warn" | "bad";
  title: string;
  sub: string;
} {
  const relevant = deps.filter((d) => d.status !== "unsupported");
  const found = relevant.filter((d) => d.status === "ok").length;
  const required = relevant.filter((d) => d.required && depNeedsAttention(d.status)).length;
  const optional = relevant.filter((d) => !d.required && depNeedsAttention(d.status)).length;
  const title = `${found} of ${relevant.length} tools found`;
  if (required) {
    return { tone: "bad", title, sub: `${required} required ${required === 1 ? "tool is" : "tools are"} missing or need a look.` };
  }
  if (optional) {
    return {
      tone: "warn",
      title,
      sub: `Everything required is there. ${optional === 1 ? "One optional tool is" : `${optional} optional tools are`} missing.`,
    };
  }
  return { tone: "good", title, sub: "Everything this app shells out to is installed." };
}
