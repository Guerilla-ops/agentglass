/**
 * Which lane this window hosts, from `#lane=<id>`, or null for the app itself.
 *
 * A lane host is a window nobody sees (electron/main.js, createLaneHost). It
 * loads the same bundle, and this is the one question that decides whether it
 * mounts the whole app or only a webview for an agent to drive. The id is
 * short and plain on purpose: it names a window, and anything else in the
 * hash is not a lane.
 */
export function laneFromHash(hash: string): string | null {
  return parseLaneHash(hash)?.id ?? null;
}

const LANE_HASH = /^#lane=([A-Za-z0-9_-]{1,64})(?:&p=([a-z0-9]{1,16})|&t=(eph))?$/;

/** One `exec` for the three readers below, instead of one each. */
function parseLaneHash(hash: string): { id: string; profile: string; ephemeral: boolean } | null {
  const m = LANE_HASH.exec(hash);
  if (!m) return null;
  return { id: m[1], profile: m[2] ?? "", ephemeral: m[3] === "eph" };
}

/**
 * The container a lane browses in, from the same hash: the profile id after
 * `&p=`, or "" (the person's own container) when there is none. A private lane
 * names its own id there, so the jar is its alone. `""` for an ephemeral lane
 * too — see `laneIsEphemeral`, which is what LaneHost.tsx checks first.
 */
export function laneProfileFromHash(hash: string): string {
  return parseLaneHash(hash)?.profile ?? "";
}

/**
 * S6: whether this hash names an ephemeral lane (`lane new --from-template`) —
 * `&t=eph` instead of `&p=<slug>`, since it has no profile slug at all: its
 * partition is its own in-memory jar, never a slot in the persisted family.
 */
export function laneIsEphemeral(hash: string): boolean {
  return parseLaneHash(hash)?.ephemeral ?? false;
}
