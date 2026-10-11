import { describe, expect, it } from "vitest";
import { ROW_HIGHLIGHT_DURATION_MS, rowHighlightOnEditorClose } from "./row-highlight";

describe("rowHighlightOnEditorClose", () => {
  it("highlights the originating row when the editor closes over the list view", () => {
    expect(rowHighlightOnEditorClose("prop-1", null, "list")).toBe("prop-1");
  });

  it("never highlights when the editor closes over the map view (no rows exist)", () => {
    expect(rowHighlightOnEditorClose("prop-1", null, "map")).toBeNull();
  });

  it("does not highlight when an editor opens", () => {
    expect(rowHighlightOnEditorClose(null, "prop-1", "list")).toBeNull();
  });

  it("does not highlight when switching directly between editors", () => {
    expect(rowHighlightOnEditorClose("prop-1", "prop-2", "list")).toBeNull();
  });

  it("does nothing when nothing was open", () => {
    expect(rowHighlightOnEditorClose(null, null, "list")).toBeNull();
  });

  it("bounds the highlight duration to match the 1.6s CSS fade", () => {
    // The CSS animation (app/styles.css .funnel-row-editor-return) runs
    // 1.6s; the class must be removed on the same clock so the animated
    // fade completes exactly once and the reduced-motion static cue is
    // equally brief.
    expect(ROW_HIGHLIGHT_DURATION_MS).toBe(1600);
  });
});
