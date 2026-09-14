/*
 * THE MOUSE'S BACK BUTTON, WHICH THIS APP IS NOT A BROWSER FOR.
 *
 * The thumb button is "go back to where I was", and everywhere else on the
 * machine it means that. Here it meant nothing: the app is one page, so
 * Chromium has no history entry to pop and the press fell on the floor — from
 * a pull request you had to travel back to the board with the pointer, past a
 * breadcrumb at the other end of the window.
 *
 * Button 3 is back and button 4 is forward in the DOM's numbering, which is
 * not the order the platform's own names are in — a `MouseEvent` carries the
 * index, and reading it anywhere else is how the two get swapped.
 */

/** Whether this event is the pointer's own "back", by any of the names the
 *  browser gives it. `buttons` is the mask on a `mousedown`, `button` the index
 *  on the release — both are checked because a caller may bind either. */
export function isBackButton(e: { button?: number; buttons?: number }): boolean {
  if (e.button === 3) return true;
  /* The mask: bit 3 is the fourth button, which is back. Only read when there
     is no `button` index to trust — on a `mouseup` the mask has already
     dropped the button that was released. */
  return e.button === undefined && ((e.buttons ?? 0) & 8) !== 0;
}

/** And forward, so a caller can tell them apart rather than treating every
 *  thumb button as back. */
export function isForwardButton(e: { button?: number; buttons?: number }): boolean {
  if (e.button === 4) return true;
  return e.button === undefined && ((e.buttons ?? 0) & 16) !== 0;
}
