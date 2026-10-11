import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGMENT_FIELDS } from "./editor";
import { buildQuickViewJudgmentRows, JUDGMENT_STATE_LABELS, QUICK_JUDGMENT_LABELS } from "./map-quickview";
import type { QuickJudgments } from "./types";
import { UNKNOWN_JUDGMENTS } from "./types";

describe("buildQuickViewJudgmentRows", () => {
  it("always renders all three judgments in the editor's field order", () => {
    const rows = buildQuickViewJudgmentRows(UNKNOWN_JUDGMENTS);
    expect(rows.map((r) => r.field)).toEqual([...JUDGMENT_FIELDS]);
    expect(rows).toHaveLength(3);
  });

  it("labels the three quick judgments: bedroom size, rental income, drum space", () => {
    const rows = buildQuickViewJudgmentRows(UNKNOWN_JUDGMENTS);
    expect(rows.map((r) => r.label)).toEqual([
      "Bedroom size acceptable",
      "Rental income support",
      "Drum space",
    ]);
  });

  it("maps each persisted verdict to an explicit Yes/No/Unknown state", () => {
    const judgments: QuickJudgments = { bedroomSizeOk: "yes", rentalIncome: "no", drumSpace: "unknown" };
    const rows = buildQuickViewJudgmentRows(judgments);
    expect(rows.map((r) => r.stateLabel)).toEqual(["Yes", "No", "Unknown"]);
    expect(rows.map((r) => r.verdict)).toEqual(["yes", "no", "unknown"]);
  });

  it("never coerces an unevaluated judgment to No — unknown stays an explicit Unknown", () => {
    const rows = buildQuickViewJudgmentRows(UNKNOWN_JUDGMENTS);
    for (const row of rows) {
      expect(row.verdict).toBe("unknown");
      expect(row.stateLabel).toBe("Unknown");
    }
  });

  it("reuses the shared judgment-pill classes so map and list agree visually", () => {
    const judgments: QuickJudgments = { bedroomSizeOk: "yes", rentalIncome: "no", drumSpace: "unknown" };
    const rows = buildQuickViewJudgmentRows(judgments);
    expect(rows[0].pillClassName).toBe("judgment-pill judgment-pill-yes");
    expect(rows[1].pillClassName).toBe("judgment-pill judgment-pill-no");
    expect(rows[2].pillClassName).toBe("judgment-pill judgment-pill-unknown");
  });

  it("builds a full accessible name per row (label plus state)", () => {
    const rows = buildQuickViewJudgmentRows({ bedroomSizeOk: "yes", rentalIncome: "unknown", drumSpace: "no" });
    expect(rows[0].ariaLabel).toBe("Bedroom size acceptable: Yes");
    expect(rows[1].ariaLabel).toBe("Rental income support: Unknown");
    expect(rows[2].ariaLabel).toBe("Drum space: No");
  });

  it("keeps the label/state vocabularies complete for every tri-state value", () => {
    expect(Object.keys(QUICK_JUDGMENT_LABELS).sort()).toEqual([...JUDGMENT_FIELDS].sort());
    expect(JUDGMENT_STATE_LABELS).toEqual({ yes: "Yes", no: "No", unknown: "Unknown" });
  });

  it("is wired into the map quick-view card (PropertyMap builds its rows from this helper)", () => {
    const map = readFileSync(join(__dirname, "..", "app", "components", "PropertyMap.tsx"), "utf8");
    expect(map).toContain("buildQuickViewJudgmentRows(house.judgments)");
    expect(map).toContain("map-quickview-judgments");
  });
});
