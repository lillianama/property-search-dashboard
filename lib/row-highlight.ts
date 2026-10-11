// Pure logic for the editor-close return highlight on the My Search list
// view: when the property editor that was opened from a list row closes,
// that originating row is briefly highlighted and then fades back to
// normal so the eye can re-find it — without scrolling or repositioning
// the list. The decision of WHICH row (if any) to highlight lives here so
// it is unit-testable; the fade itself is CSS (see .funnel-row-editor-return
// in app/styles.css), with a non-animated static cue under
// prefers-reduced-motion.

import type { HousesView } from "./url-state";

/** How long the highlight class stays applied before React removes it.
 * Matches the CSS fade duration (1.6s) so the animated fade completes
 * exactly when the class is dropped; under prefers-reduced-motion the same
 * timer bounds the static (non-animated) cue. */
export const ROW_HIGHLIGHT_DURATION_MS = 1600;

/**
 * Returns the property id whose row should be highlighted after an editor
 * transition, or null when nothing should happen. A highlight fires only
 * when an open editor (previousEditingId) just closed (editingId became
 * null) while the List view is showing — opening an editor, switching
 * editors, or closing one over the Map view never highlights anything.
 */
export function rowHighlightOnEditorClose(
  previousEditingId: string | null,
  editingId: string | null,
  view: HousesView,
): string | null {
  if (view !== "list") return null;
  if (previousEditingId === null || editingId !== null) return null;
  return previousEditingId;
}
