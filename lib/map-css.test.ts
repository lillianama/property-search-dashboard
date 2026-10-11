import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pragmatic responsive-CSS assertions: the map-view sizing rules are plain
// static CSS, so the cheapest honest guard is reading the stylesheet and
// asserting the sizing contract the user asked for (near-full-screen desktop
// map with a sane floor/ceiling, and a smaller clamp on small screens so
// phones are never trapped behind a 700px-minimum map).

const css = readFileSync(join(__dirname, "..", "app", "styles.css"), "utf8");

/** Extracts the body of the first `selector { ... }` block after `from`. */
function ruleBody(selector: string, from = 0): string {
  const start = css.indexOf(selector, from);
  expect(start, `selector ${selector} not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("map view sizing CSS", () => {
  it("keeps the base (non-large) map canvas at a fixed modest height", () => {
    const body = ruleBody(".map-canvas {");
    expect(body).toContain("height: 420px");
  });

  it("gives the large My Search map a near-full-screen desktop height: 88vh clamped to 700-1100px", () => {
    const body = ruleBody(".map-canvas-large");
    expect(body).toContain("height: clamp(700px, 88vh, 1100px)");
    expect(body).toContain("width: 100%");
  });

  it("scales the large map down on small screens so the page is never trapped", () => {
    const mediaStart = css.indexOf("@media (max-width: 720px)");
    expect(mediaStart).toBeGreaterThanOrEqual(0);
    const body = ruleBody(".map-canvas-large", mediaStart);
    expect(body).toContain("height: clamp(420px, 70vh, 700px)");
  });

  it("keeps the small-screen clamp strictly below the desktop minimum", () => {
    // If someone raises the mobile cap above the desktop floor, the media
    // query stops being a meaningful small-screen escape hatch.
    const desktopMin = 700;
    const mobileMatch = /@media \(max-width: 720px\)[^{]*\{[\s\S]*?height: clamp\((\d+)px, \d+vh, (\d+)px\)/.exec(css);
    expect(mobileMatch).not.toBeNull();
    expect(Number(mobileMatch![1])).toBeLessThan(desktopMin);
    expect(Number(mobileMatch![2])).toBeLessThanOrEqual(desktopMin);
  });
});
