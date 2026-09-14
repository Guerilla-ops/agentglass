/*
 * THE TRACKER'S OWN ORDER, COMPARED WITHOUT LOSING IT.
 *
 * `orderindex` arrives as a decimal wider than a double can hold: fourteen
 * digits and six more on a real board, and the scheme that produces it inserts
 * a card by halving the gap to its neighbour. Today's values survive a parse —
 * measured — but how many decimals a pair differs at is a matter of how often
 * somebody has dragged that card, and two that collapse to the same double sort
 * in whatever order they arrived, which is the shuffle this exists to prevent.
 *
 * So it is compared as the decimal it is: integer part by length then by
 * digits, fraction left-aligned. No arithmetic, nothing to round.
 */

/** Split into a sign, an integer part and a fraction, with nothing assumed
 *  about how long either is. */
function parts(v: string): { neg: boolean; int: string; frac: string } {
  const s = v.trim();
  const neg = s.startsWith("-");
  const body = neg || s.startsWith("+") ? s.slice(1) : s;
  const dot = body.indexOf(".");
  const int = (dot < 0 ? body : body.slice(0, dot)).replace(/^0+(?=\d)/, "") || "0";
  const frac = dot < 0 ? "" : body.slice(dot + 1).replace(/0+$/, "");
  return { neg, int, frac };
}

/**
 * Ascending, the way the tracker's own page draws a column.
 *
 * A card with no order sorts last rather than first: an unknown is not a
 * position, and putting it at the top moves whatever was actually there.
 */
export function compareOrder(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a === b) return 0;
  const x = parts(a);
  const y = parts(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const flip = x.neg ? -1 : 1;
  if (x.int.length !== y.int.length) return (x.int.length < y.int.length ? -1 : 1) * flip;
  if (x.int !== y.int) return (x.int < y.int ? -1 : 1) * flip;
  const n = Math.max(x.frac.length, y.frac.length);
  const fx = x.frac.padEnd(n, "0");
  const fy = y.frac.padEnd(n, "0");
  if (fx === fy) return 0;
  return (fx < fy ? -1 : 1) * flip;
}
