import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_EDIT_CLASS, ACTION_REJECT_CLASS } from "./action-styles";
import { ROW_HIGHLIGHT_DURATION_MS } from "./row-highlight";

// Pragmatic static-CSS assertions (same approach as map-css.test.ts): the
// semantic action-button styling and the editor-close row highlight are
// plain stylesheet rules, so the cheapest honest guard is reading the
// stylesheet and asserting the contracts — red Reject / blue Edit with
// hover, focus-visible, and disabled states, and a fade animation whose
// duration matches the JS timer, with a non-animated reduced-motion cue.

const css = readFileSync(join(__dirname, "..", "app", "styles.css"), "utf8");

const componentSource = (name: string) =>
  readFileSync(join(__dirname, "..", "app", "components", name), "utf8");

describe("semantic action button CSS", () => {
  it("defines the blue Edit and red Reject base classes", () => {
    expect(css).toContain(`.${ACTION_EDIT_CLASS} {`);
    expect(css).toContain(`.${ACTION_REJECT_CLASS} {`);
  });

  it("keeps Edit in the blue family and Reject in the red family", () => {
    const editBlock = css.slice(css.indexOf(`.${ACTION_EDIT_CLASS} {`), css.indexOf(`.${ACTION_REJECT_CLASS} {`));
    expect(editBlock).toMatch(/rgba\(59, 130, 246|#60a5fa|#93c5fd/);
    const rejectBlock = css.slice(css.indexOf(`.${ACTION_REJECT_CLASS} {`));
    expect(rejectBlock).toMatch(/rgba\(248, 113, 113|#f87171|#fca5a5/);
  });

  it("styles hover, focus-visible, and disabled states for both", () => {
    for (const cls of [ACTION_EDIT_CLASS, ACTION_REJECT_CLASS]) {
      expect(css).toContain(`.${cls}:hover:not(:disabled)`);
      expect(css).toContain(`.${cls}:focus-visible`);
      expect(css).toContain(`.${cls}:disabled`);
    }
  });

  it("is applied to both the list rows and the map quick-view actions", () => {
    // The components reference the shared constants rather than retyping
    // class strings, so checking for the identifiers guards the wiring.
    const funnel = componentSource("FunnelBoard.tsx");
    expect(funnel).toContain("ACTION_EDIT_CLASS");
    expect(funnel).toContain("ACTION_REJECT_CLASS");
    const map = componentSource("PropertyMap.tsx");
    expect(map).toContain("ACTION_EDIT_CLASS");
    expect(map).toContain("ACTION_REJECT_CLASS");
    const dialog = componentSource("RejectPropertyDialog.tsx");
    expect(dialog).toContain("ACTION_REJECT_CLASS");
  });
});

describe("editor-close row highlight CSS", () => {
  it("fades the highlight out over 1.6s, matching the JS removal timer", () => {
    expect(css).toContain(".funnel-row-editor-return {");
    expect(css).toMatch(/\.funnel-row-editor-return \{\s*animation: funnel-row-return-fade 1\.6s/);
    expect(ROW_HIGHLIGHT_DURATION_MS).toBe(1600);
    expect(css).toContain("@keyframes funnel-row-return-fade");
  });

  it("keeps a brief NON-animated cue under prefers-reduced-motion", () => {
    const reducedStart = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(reducedStart).toBeGreaterThanOrEqual(0);
    const reduced = css.slice(reducedStart);
    const block = reduced.slice(
      reduced.indexOf(".funnel-row-editor-return"),
      reduced.indexOf("}", reduced.indexOf(".funnel-row-editor-return")),
    );
    expect(block).toContain("animation: none");
    // Static visual cue: a visible background/border that the JS timer
    // later removes with the class.
    expect(block).toMatch(/background: rgba\(139, 92, 246/);
  });

  it("never scrolls: the highlight is pure styling with no scroll behavior", () => {
    const dashboard = componentSource("Dashboard.tsx");
    expect(dashboard).toContain("rowHighlightOnEditorClose");
    expect(dashboard).not.toContain("scrollIntoView");
  });
});
