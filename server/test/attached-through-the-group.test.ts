/*
 * Who counts as "somebody is looking at this session".
 *
 * The phone's tab strip lists the scratch only while a client is on it — a
 * floating window is not a destination once it has been dismissed. That made
 * the question `session_attached` answers the wrong one, because the phone's
 * client is never on the session by name: attaching groups a new
 * `agx-phone-…` session onto the target and the client sits on that.
 *
 * So the desk dismisses the popup, `session_attached` drops to 0 while the
 * phone is still reading it, the row leaves the strip, and the phone's open
 * tab stops matching anything — TerminalView unmounts into "Nothing open".
 * Losing the screen you are reading because somebody at the desk pressed
 * Escape is the appear-and-disappear the panes route already calls worse than
 * either answer.
 *
 * The rows below are `tmux list-sessions -F ATTACHED_FORMAT` as an isolated
 * server actually answered it, walked through the five states in order.
 */
import { describe, expect, test } from "bun:test";
import { attachedFrom } from "../src/tmuxctl.ts";

const rows = (...lines: string[]): string => lines.join("\n");

describe("a session somebody is looking at", () => {
  test("nobody on it, and it is not grouped", () => {
    expect([...attachedFrom(rows("scratch\t0\t"))]).toEqual([]);
  });

  test("the popup is up on the desk", () => {
    expect([...attachedFrom(rows("scratch\t1\t"))]).toEqual(["scratch"]);
  });

  test("the popup is up and the phone has grouped onto it", () => {
    const live = attachedFrom(rows(
      "agx-phone-p1-abc\t1\t2",
      "scratch\t1\t2",
    ));
    expect([...live].sort()).toEqual(["agx-phone-p1-abc", "scratch"]);
  });

  /* The one this exists for. */
  test("the popup is dismissed while the phone is still reading it", () => {
    const live = attachedFrom(rows(
      "agx-phone-p1-abc\t1\t1",
      "scratch\t0\t1",
    ));
    expect(live.has("scratch")).toBe(true);
  });

  test("the phone leaves too, and the group empties", () => {
    expect([...attachedFrom(rows("scratch\t0\t0"))]).toEqual([]);
  });

  test("a blank line is not a session", () => {
    expect([...attachedFrom(rows("work\t1\t", "", "  \t0\t"))]).toEqual(["work"]);
  });
});
