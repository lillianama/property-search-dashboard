import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  estimateLabelWidth,
  planWedgeLabels,
  relativeLuminance,
  WEDGE_LABEL_DARK_TEXT,
  WEDGE_LABEL_LIGHT_TEXT,
  wedgeLabelColor,
  wedgeLabelFits,
  wedgeLabelPosition,
  type WedgeArc,
} from "./chart-wedge-labels";

/** A comfortable wedge: quarter circle on a 60px-thick ring. */
function arc(overrides: Partial<WedgeArc> = {}): WedgeArc {
  return {
    value: 12,
    startAngle: 0,
    endAngle: Math.PI / 2,
    innerRadius: 60,
    outerRadius: 120,
    centerX: 200,
    centerY: 150,
    backgroundColor: "#34d399",
    ...overrides,
  };
}

/** WCAG contrast ratio between two colors, for readability assertions. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("wedgeLabelColor", () => {
  it("picks dark text on the light palette colors and light text on the dark ones", () => {
    expect(wedgeLabelColor("#34d399")).toBe(WEDGE_LABEL_DARK_TEXT); // Active (emerald)
    expect(wedgeLabelColor("#fbbf24")).toBe(WEDGE_LABEL_DARK_TEXT); // Pending (amber)
    expect(wedgeLabelColor("#94a3b8")).toBe(WEDGE_LABEL_DARK_TEXT); // Inactive (slate)
    expect(wedgeLabelColor("#a78bfa")).toBe(WEDGE_LABEL_DARK_TEXT); // Sold (violet)
    expect(wedgeLabelColor("#f472b6")).toBe(WEDGE_LABEL_DARK_TEXT); // fallback (pink)
    expect(wedgeLabelColor("#4b5563")).toBe(WEDGE_LABEL_LIGHT_TEXT); // Unknown (dark gray)
  });

  it("gives every status palette color at least 4.5:1 contrast with its label text", () => {
    for (const background of ["#34d399", "#fbbf24", "#94a3b8", "#a78bfa", "#4b5563", "#f472b6"]) {
      expect(contrastRatio(background, wedgeLabelColor(background))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("supports shorthand hex and treats unparseable colors as dark (light text)", () => {
    expect(wedgeLabelColor("#fff")).toBe(WEDGE_LABEL_DARK_TEXT);
    expect(wedgeLabelColor("not-a-color")).toBe(WEDGE_LABEL_LIGHT_TEXT);
  });
});

describe("wedgeLabelFits", () => {
  it("accepts a comfortably sized nonzero wedge", () => {
    expect(wedgeLabelFits(arc(), "12")).toBe(true);
  });

  it("rejects zero-value wedges — no area, no label, no misleading count", () => {
    expect(wedgeLabelFits(arc({ value: 0, startAngle: 1, endAngle: 1 }), "0")).toBe(false);
    expect(planWedgeLabels([arc({ value: 0, startAngle: 1, endAngle: 1 })])).toEqual([]);
  });

  it("rejects a collapsed wedge (legend-hidden: zero sweep angle)", () => {
    expect(wedgeLabelFits(arc({ startAngle: 1.2, endAngle: 1.2 }), "12")).toBe(false);
  });

  it("rejects a sliver wedge whose chord cannot hold the text", () => {
    // ~2 degrees: real area, but far too narrow for a legible number.
    expect(wedgeLabelFits(arc({ startAngle: 0, endAngle: 0.035 }), "12")).toBe(false);
  });

  it("rejects a ring too thin for the text height", () => {
    expect(wedgeLabelFits(arc({ innerRadius: 110, outerRadius: 120 }), "12")).toBe(false);
  });

  it("demands more room for longer counts", () => {
    const narrow = arc({ startAngle: 0, endAngle: 0.28 });
    expect(wedgeLabelFits(narrow, "9")).toBe(true);
    expect(wedgeLabelFits(narrow, "1234")).toBe(false);
    expect(estimateLabelWidth("1234")).toBeGreaterThan(estimateLabelWidth("9"));
  });

  it("handles a full-circle single wedge (angle beyond pi) without NaN games", () => {
    expect(wedgeLabelFits(arc({ startAngle: 0, endAngle: Math.PI * 2 }), "51")).toBe(true);
  });
});

describe("wedgeLabelPosition", () => {
  it("centers the label at the wedge's mid-angle and mid-ring radius", () => {
    // Quarter wedge from 0 to pi/2: mid-angle pi/4, label radius 90.
    const { x, y } = wedgeLabelPosition(arc());
    expect(x).toBeCloseTo(200 + Math.cos(Math.PI / 4) * 90, 6);
    expect(y).toBeCloseTo(150 + Math.sin(Math.PI / 4) * 90, 6);
  });
});

describe("planWedgeLabels", () => {
  it("labels every fitting nonzero wedge with its exact count and a contrast-checked color", () => {
    const arcs = [
      arc({ value: 24, startAngle: 0, endAngle: Math.PI, backgroundColor: "#34d399" }),
      arc({ value: 9, startAngle: Math.PI, endAngle: Math.PI * 1.5, backgroundColor: "#4b5563" }),
    ];
    const labels = planWedgeLabels(arcs);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatchObject({ text: "24", color: WEDGE_LABEL_DARK_TEXT });
    expect(labels[1]).toMatchObject({ text: "9", color: WEDGE_LABEL_LIGHT_TEXT });
  });

  it("skips tiny and zero wedges while keeping the rest", () => {
    const arcs = [
      arc({ value: 48, startAngle: 0, endAngle: Math.PI * 1.9 }),
      arc({ value: 1, startAngle: Math.PI * 1.9, endAngle: Math.PI * 1.93 }), // sliver
      arc({ value: 0, startAngle: Math.PI * 1.93, endAngle: Math.PI * 1.93 }), // empty
    ];
    const labels = planWedgeLabels(arcs);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("48");
  });

  it("is wired into the Status Distribution chart as a chart-local plugin", () => {
    const chart = readFileSync(
      join(__dirname, "..", "app", "components", "charts", "StatusDistributionChart.tsx"),
      "utf8",
    );
    expect(chart).toContain("planWedgeLabels");
    expect(chart).toContain("afterDatasetsDraw");
    expect(chart).toContain("plugins: [wedgeCountLabels]");
  });
});
