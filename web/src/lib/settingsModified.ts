/*
 * Whether a settings page has anything to reset.
 *
 * A page's rows each know whether they differ from their shipped default;
 * the header's "Reset page" is shown only when at least one does, so the
 * button never offers to undo nothing.
 */
export const resetShown = (modified: readonly boolean[]): boolean => modified.some(Boolean);
