import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlexUnits } from "../app/components/PlexUnits";
import { normalizeUnits, rentalSubtotal, selectPlexUnits, type UnitSourceRow } from "./plex-units";

const row = (value: unknown, extra: Partial<UnitSourceRow> = {}): UnitSourceRow => ({
  property_id: "test", field: "unit_mix", value, source: "test-source", observed_at: "2026-01-01", ...extra,
});
describe("plex unit normalization and rendering", () => {
  it("allowlists fields, keeps zero and unknown distinct, and retains provenance", () => {
    const units = normalizeUnits(row([{ bedrooms: 0, bathrooms: 1, actualRent: 0, expectedMonthlyRent: 900,
      occupancy: "vacant", owner: "private", raw: { secret: true } }]));
    expect(units).toEqual([{ label: "Unit 1 (source order)", beds: 0, baths: 1, sqft: null,
      actualMonthlyRent: 0, expectedMonthlyRent: 900, occupancy: "vacant", source: "test-source", asOf: "2026-01-01T00:00:00.000Z" }]);
    expect(normalizeUnits(row([{ actualRent: -10, bedrooms: "2", sqft: Infinity, occupancy: "tenant-name" }], { observed_at: "invalid" }))[0])
      .toMatchObject({ actualMonthlyRent: null, beds: null, sqft: null, occupancy: "unknown", asOf: null });
  });
  it("never splits building totals or assigns unattributed estimates", () => {
    const units = normalizeUnits(row([{ bedrooms: 2 }, { bedrooms: 1 }]));
    expect(rentalSubtotal(units, "actualMonthlyRent")).toEqual({ amount: null, count: 0 });
    expect(normalizeUnits(row({ unitCount: 2, actual_monthly_rent_total: 3000, rent_estimate_per_unit: 1500 }))).toEqual([]);
    const summary = selectPlexUnits([row(2, { field: "unit_count" })]).get("test")!;
    expect(summary.units).toEqual([]);
  });
  it("selects one latest snapshot, without double counting or carrying older rents forward", () => {
    const old = row([{ actualRent: 1000 }, { actualRent: 1200 }]);
    const latest = row([{ expectedMonthlyRent: 1500 }, { actualRent: 1300 }], { observed_at: "2026-02-01", source: "new-source" });
    const units = selectPlexUnits([old, latest, latest]).get("test")!.units;
    expect(rentalSubtotal(units, "actualMonthlyRent")).toEqual({ amount: 1300, count: 1 });
    expect(rentalSubtotal(units, "expectedMonthlyRent")).toEqual({ amount: 1500, count: 1 });
    expect(units.every(u => u.source === "new-source")).toBe(true);
    expect(selectPlexUnits([old, row(null, { observed_at: "2026-03-01" })]).get("test")!.units).toEqual([]);
  });
  it("accepts only the explicit recorded configuration grammar", () => {
    const units = normalizeUnits(row("Two side-by-side 1BR/1BA units, each with a basement", { field: "unit_configuration" }));
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ beds: 1, baths: 1, sqft: null, actualMonthlyRent: null });
    expect(normalizeUnits(row("Building: 4 beds, 2 baths, duplex", { field: "unit_configuration" }))).toEqual([]);
  });
  it("renders separate rent categories and provenance only on plex cards", () => {
    const summary = selectPlexUnits([row([{ bedrooms: 2, actualRent: 1000, expectedMonthlyRent: 1400 }, {}])]).get("test")!;
    const html = renderToStaticMarkup(createElement(PlexUnits, { track: "plex", summary }));
    expect(html).toContain("Unit 2 (source order)");
    expect(html).toContain("Actual monthly rent subtotal: $1,000/mo");
    expect(html).toContain("Expected/pro-forma monthly rent subtotal: $1,400/mo");
    expect(html).toContain("test-source");
    expect(html).toContain("Occupancy: unknown");
    expect(html).not.toMatch(/offset|PITI|2,400/);
    expect(renderToStaticMarkup(createElement(PlexUnits, { track: "house", summary }))).toBe("");
    const unknown = renderToStaticMarkup(createElement(PlexUnits, { track: "plex" }));
    expect(unknown).toContain("Unit details unknown");
    expect(unknown).toContain("Expected/pro-forma monthly rent subtotal: Unknown");
    expect(unknown).not.toContain("$0");
  });
});
