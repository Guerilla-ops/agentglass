/**
 * The tracker hands a column's order back as a decimal wider than a double can
 * hold: `10001789361656.577303` is fourteen digits and six more, and the scheme
 * that produces it inserts a card by halving the gap to its neighbour. Those two
 * survive a `Number()` — measured, they round to different values — but how many
 * decimals a pair differs at is a matter of how often somebody has dragged that
 * card, and two that collapse to the same double sort in whatever order they
 * arrived. So it is compared as the decimal it is, and never parsed.
 */
import { test, expect } from "bun:test";
import { compareOrder } from "../../shared/orderIndex.ts";

test("two values a double collapses are still ordered", () => {
  /* Far enough apart to survive a double, and this is the pair off a real
     board, so the ordinary case is covered too. */
  const [a, b] = ["10001789361656.577303", "10001789361656.574855"];
  expect(compareOrder(b, a)).toBeLessThan(0);
  expect(compareOrder(a, b)).toBeGreaterThan(0);

  /* And a pair the parse cannot separate at all — one more halving of the gap
     and this is what a column looks like. */
  const [c, d] = ["10001789361656.57730300000000001", "10001789361656.57730300000000002"];
  expect(Number(c)).toBe(Number(d));
  expect(compareOrder(c, d)).toBeLessThan(0);
  expect(compareOrder(d, c)).toBeGreaterThan(0);
});

test("a column sorts the way the tracker draws it", () => {
  const column = [
    "10001789361656.577303", "10001789361656.574855", "10001789361656.572447",
    "10001789205780.043455", "10001785700540.165315",
  ];
  expect([...column].sort(compareOrder)).toEqual([
    "10001785700540.165315", "10001789205780.043455", "10001789361656.572447",
    "10001789361656.574855", "10001789361656.577303",
  ]);
});

test("a shorter integer part is smaller, whatever its digits", () => {
  expect(compareOrder("9999999999", "10000000000")).toBeLessThan(0);
});

test("a missing order sorts last, because an unknown is not a position", () => {
  expect(compareOrder(undefined, "1")).toBeGreaterThan(0);
  expect(compareOrder("1", null)).toBeLessThan(0);
  expect(compareOrder(null, undefined)).toBe(0);
});

test("trailing zeros and leading zeros are not differences", () => {
  expect(compareOrder("12.500", "012.5")).toBe(0);
  expect(compareOrder("7", "7.0")).toBe(0);
});

test("negatives run the other way", () => {
  expect(compareOrder("-2", "-1")).toBeLessThan(0);
  expect(compareOrder("-1", "1")).toBeLessThan(0);
});

/*
 * And the board uses it. Two wrongs hid each other here: the API returns a list
 * in descending order while the tracker's page draws it ascending, and the board
 * lifted the flagged cards on top of that — which the page does not do.
 */
test("the board orders a column by the tracker's hand, not by priority", async () => {
  const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
  expect(src).toContain('import { compareOrder } from "../../../shared/orderIndex.ts";');
  expect(src).toMatch(/compareOrder\(a\.t\.order, b\.t\.order\)/);
  /* The lift is gone, not merely outranked. */
  expect(src).not.toContain("byPriority");
});

test("the server carries the order through instead of dropping it", async () => {
  const src = await Bun.file(new URL("../../server/src/clickup.ts", import.meta.url)).text();
  /* As a string. `order: Number(...)` would typecheck and lose the one thing
     the field is for. */
  expect(src).toMatch(/order: String\(raw\.orderindex\)/);
});
