import { useState } from "react";
import { SERVER, withToken } from "../../lib/api.ts";

/**
 * A plugin's face: the icon it ships, on a tile in the colour it declared.
 *
 * The icon is an `<img>` pointed at the server, never markup put into the
 * page — an SVG loaded as an image runs no script and fetches nothing, and
 * the server sends it with a sandboxing CSP besides. A plugin with no icon, or
 * one that fails to load, gets its initials on the same tile, tinted by its
 * colour or, without one, by a hue derived from its name, so every plugin in
 * a list looks like itself.
 */
export function PluginMark({ name, icon, color, size = 44, stamp }: {
  name: string; icon?: string; color?: string; size?: number;
  /** Changes when the plugin is reinstalled, so a new icon is not a cached old one. */
  stamp?: string;
}) {
  const [broken, setBroken] = useState(false);
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const tint = color ?? `oklch(0.7 0.12 ${h})`;
  const letters = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/)
    .slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  const src = icon && !broken
    ? withToken(`${SERVER}/plugins/icon?name=${encodeURIComponent(name)}${stamp ? `&v=${encodeURIComponent(stamp.slice(0, 12))}` : ""}`)
    : null;
  return (
    <span aria-hidden className="shrink-0 grid place-items-center overflow-hidden"
      style={{
        width: size, height: size, borderRadius: Math.round(size * 0.28),
        background: `linear-gradient(145deg, color-mix(in srgb, ${tint} 34%, transparent), color-mix(in srgb, ${tint} 12%, transparent))`,
        border: `1px solid color-mix(in srgb, ${tint} 45%, transparent)`,
        boxShadow: `0 6px 18px -10px color-mix(in srgb, ${tint} 70%, transparent)`,
        color: `color-mix(in srgb, ${tint} 70%, var(--text))`,
      }}>
      {src
        ? <img src={src} alt="" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} draggable={false}
            onError={() => setBroken(true)} style={{ objectFit: "contain" }} />
        : <span className="font-semibold" style={{ fontSize: Math.round(size * 0.32) }}>{letters}</span>}
    </span>
  );
}
