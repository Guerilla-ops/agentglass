import { ICON } from "../../lib/iconSize.ts";

/**
 * The icon a panel names in its manifest, drawn from this set and no other
 * (PANEL_ICONS in shared/pluginUi.ts). A plugin picks a word; it cannot ship
 * an image, so every tab in the Plugins view is drawn in the same hand.
 */
const svg = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PATHS: Record<string, React.ReactNode> = {
  puzzle: <path d="M9 4h4v2.2a1.8 1.8 0 0 0 3 1.3 1.8 1.8 0 0 1 3 1.3V13h-2.2a1.8 1.8 0 0 0 0 3.6H19v4h-4v-2.2a1.8 1.8 0 0 0-3.6 0V21H9v-4.5H6.8a1.8 1.8 0 0 1 0-3.6H9V9H6.8a1.8 1.8 0 0 1-1.3-3 1.8 1.8 0 0 1 3-1.3V4z" />,
  review: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8.5 10.5l2 2 4-4" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chart: <><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 16v-5" /><path d="M12 16V8" /><path d="M16 16v-3" /></>,
  list: <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>,
  bug: <><rect x="7" y="7" width="10" height="13" rx="5" /><path d="M12 7V4" /><path d="M4 12h3" /><path d="M17 12h3" /><path d="M5 18l2.5-1.5" /><path d="M19 18l-2.5-1.5" /></>,
  book: <><path d="M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4z" /><path d="M5 16a4 4 0 0 1 4-4h9" /></>,
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.5" /></>,
};

export function PanelGlyph({ icon, size = ICON.md }: { icon?: string; size?: number }) {
  return (
    <svg {...svg} width={size} height={size} aria-hidden>
      {PATHS[icon ?? "puzzle"] ?? PATHS.puzzle}
    </svg>
  );
}
