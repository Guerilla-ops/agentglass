/*
 * WHERE THE DESKTOP KEEPS ITS PALETTE.
 *
 * One provider today, Omarchy: every theme it applies is staged into
 * `~/.local/state/omarchy/current/theme/`, with the palette as `colors.toml` and
 * the theme's slug beside it in `theme.name`. Both are rewritten on every
 * switch, so the file's mtime is the whole change signal — nothing to install
 * into the desktop, no hook of ours in its config, no command run per poll.
 *
 * A machine without it answers null and costs one failed stat. That is the
 * whole of what this does to anybody not on that desktop: "System" keeps
 * meaning what it always did, dark or light off the OS.
 *
 * The next desktop is another function returning the same shape, tried in turn.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { desktopTheme, parseColors, type DesktopTheme } from "../../shared/desktopPalette.ts";

export interface DesktopPalette {
  /** Which desktop it came from, for the label under the switch. */
  source: "omarchy";
  /** The theme as the desktop names it. */
  name: string;
  /** Changes whenever the palette does — what a client compares to repaint. */
  stamp: string;
  theme: DesktopTheme;
}

function omarchyDir(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(state, "omarchy", "current");
}

/** `tokyo-night` reads as `Tokyo Night`, the way the desktop's own menu shows it. */
function titled(slug: string): string {
  return slug.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

let cache: { stamp: string; palette: DesktopPalette | null } | null = null;

function omarchy(): DesktopPalette | null {
  const dir = omarchyDir();
  const file = join(dir, "theme", "colors.toml");
  let mtime: number;
  try { mtime = statSync(file).mtimeMs; } catch { return null; }
  let slug = "";
  try { slug = readFileSync(join(dir, "theme.name"), "utf8").trim(); } catch { /* unnamed is still a palette */ }
  const stamp = `${mtime}:${slug}`;
  /* Read once per change rather than once per ask: a client in System mode
     asks every few seconds, and the file moves a handful of times a day. */
  if (cache?.stamp === stamp) return cache.palette;
  let palette: DesktopPalette | null = null;
  try {
    const name = titled(slug) || "Omarchy";
    const theme = desktopTheme(parseColors(readFileSync(file, "utf8")), name);
    if (theme) palette = { source: "omarchy", name, stamp, theme };
  } catch { /* unreadable mid-write: the next ask gets it */ }
  cache = { stamp, palette };
  return palette;
}

/** The desktop's palette, or null on a desktop that publishes none. */
export function desktopPalette(): DesktopPalette | null {
  return omarchy();
}

/** For a test that points XDG_STATE_HOME somewhere else between cases. */
export function __forgetDesktopPalette(): void { cache = null; }

/**
 * The desktop's own mark, read off the machine rather than shipped.
 *
 * This repository is public and the mark is somebody else's; carrying a copy
 * would be redistributing it. Every machine this can be shown on already has it
 * installed, so it is served from there — recoloured to `currentColor` so the
 * button can draw it in whatever tone the segment is using — and a machine
 * without it gets nothing and the button falls back to the word.
 */
export function desktopLogo(): string | null {
  if (!omarchy()) return null;
  const share = process.env.OMARCHY_PATH || "/usr/share/omarchy";
  try {
    const svg = readFileSync(join(share, "logo.svg"), "utf8");
    if (!svg.trimStart().startsWith("<svg") || svg.length > 64_000) return null;
    return svg.replace(/fill="#(?:000|000000)"/gi, 'fill="currentColor"');
  } catch { return null; }
}
