import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FunnelBoard } from "../app/components/FunnelBoard";
import { PlexNetIncome } from "../app/components/PlexNetIncome";
import { TrackContext } from "../app/components/TrackContext";
import { formatCurrency } from "./format";
import { computePiti, DEFAULT_PITI_ASSUMPTIONS } from "./piti";
import { plexNetIncome } from "./plex-net-income";
import { selectPlexUnits, type UnitSourceRow } from "./plex-units";
import type { HouseRecord } from "./types";

vi.mock("../app/components/PropertyPhoto", () => ({ PropertyPhoto: () => null }));
const row = (field: UnitSourceRow["field"], value: unknown, observed_at = "2026-11-01"): UnitSourceRow =>
  ({ property_id: "test", field, value, observed_at, source: "enriched-source" });
const summary = (rents: (number | null)[] = [2000, 2500], count: number | null = 2) =>
  selectPlexUnits([row("unit_mix", rents.map(expectedMonthlyRent => ({ expectedMonthlyRent, actualRent: null, occupancy: "occupied", raw: "private" }))),
    ...(count === null ? [] : [row("unit_count", count)])]).get("test")!;
const piti = computePiti({ price: 500000, actualAnnualTax: 6000 }, DEFAULT_PITI_ASSUMPTIONS)!;

describe("whole-building estimated net income", () => {
  it("subtracts current complete PITI from all projected rents and follows changed assumptions", () => {
    expect(plexNetIncome(summary(), piti).amount).toBe(4500 - piti.monthlyTotal);
    const changed = computePiti({ price: 500000, actualAnnualTax: 6000 }, { ...DEFAULT_PITI_ASSUMPTIONS, downPaymentPct: 20 })!;
    expect(plexNetIncome(summary(), changed).amount).toBe(4500 - changed.monthlyTotal);
  });
  it.each([summary([2000, null]), summary([2000], 2), summary([2000, 2500], 3), summary([], 2), summary([2000, 2500], null), undefined])(
    "keeps missing or partial whole-building rent unknown", value => {
      expect(plexNetIncome(value, piti).amount).toBeNull();
    });
  it("keeps missing price and incomplete tax unknown, while recorded zero rent remains zero", () => {
    expect(plexNetIncome(summary(), null).amount).toBeNull();
    expect(plexNetIncome(summary(), { ...piti, taxIncluded: false }).amount).toBeNull();
    expect(plexNetIncome(summary([0, 0]), piti).amount).toBe(-piti.monthlyTotal);
  });
  it("uses latest snapshot without carrying forward old rents or exposing raw fields", () => {
    const selected = selectPlexUnits([row("unit_count", 2), row("unit_mix", [{ expectedMonthlyRent: 10000 }, { expectedMonthlyRent: 10000 }], "2026-10-01"),
      row("unit_mix", [{ expectedMonthlyRent: 2000, secret: "private" }, {}])]).get("test")!;
    expect(plexNetIncome(selected, piti).amount).toBeNull();
    const html = renderToStaticMarkup(createElement(PlexNetIncome, { summary: selected, piti }));
    expect(html).toContain("enriched-source");
    expect(html).toContain("2026");
    expect(html).not.toMatch(/private|secret|20,000/);
  });
  it.each([[1000, "positive", "+$1,000/mo"], [-1000, "negative", "−$1,000/mo"], [0, "neutral", "$0/mo"]] as const)(
    "renders bold signed currency for %s", (amount, tone, label) => {
      const html = renderToStaticMarkup(createElement(PlexNetIncome, { summary: summary(), piti: { ...piti, monthlyTotal: 4500 - amount } }));
      expect(html).toContain(`plex-net-income-${tone}`);
      expect(html).toContain(`<strong>${label}</strong>`);
      expect(html).toContain("not actual profit");
      expect(html).toContain("excludes other operating expenses");
    });
  it("renders neutral unknown with an explanation", () => {
    const html = renderToStaticMarkup(createElement(PlexNetIncome, { piti: null }));
    expect(html).toContain("plex-net-income-neutral");
    expect(html).toContain("Unknown / incomplete");
    expect(html).not.toContain("$0");
  });
  it("renders next to PITI at the tile bottom only for plexes; house markup is unchanged by unit data", () => {
    const house = { id: "test", address: "Example St", funnelBucket: "watchlist", rankKey: "h", displayStatus: "Active",
      latestPrice: 500000, annualTaxAmount: 6000, bedroomSizeFlag: "unknown", judgments: {}, plexUnits: summary() } as HouseRecord;
    const render = (track: "house" | "plex", property = house) => renderToStaticMarkup(createElement(TrackContext.Provider, { value: track },
      createElement(FunnelBoard, { properties: [property], placements: {}, onMove: vi.fn(), onEditNotes: vi.fn(), onWatchlistTop: vi.fn(), onWatchlistBottom: vi.fn(), pitiAssumptions: DEFAULT_PITI_ASSUMPTIONS })));
    const overridePiti = computePiti({ price: 490000, actualAnnualTax: 6000 }, DEFAULT_PITI_ASSUMPTIONS)!;
    const overrideHtml = render("plex", { ...house, purchasePriceOverride: 490000 });
    expect(overrideHtml).toContain("Purchase-price override active");
    expect(overrideHtml).toContain("Est. net income (purchase-price override)");
    expect(overrideHtml).toContain(`${formatCurrency(4500 - overridePiti.monthlyTotal)}/mo`);
    expect(overrideHtml).toContain("Purchase price: $490,000");
    expect(overrideHtml).toContain("Loan: $465,500");
    expect(overrideHtml).toContain("$500,000"); // market price label remains independent
    const html = render("plex");
    const meta = html.slice(html.indexOf('class="funnel-row-line funnel-row-meta"'));
    expect(meta).toMatch(/^class="funnel-row-line funnel-row-meta"><details class="piti-details"[\s\S]*?<\/details><details class="plex-net-income /);
    expect(meta.indexOf("Est. net income")).toBeLessThan(meta.indexOf('class="funnel-row-actions"'));
    expect(render("house")).not.toContain("Est. net income");
    expect(render("house")).toBe(render("house", { ...house, plexUnits: undefined }));
  });
});

describe("conservative comparable rent basis", () => {
  const make = (actuals: (number | null)[], estimates: (number | null)[], extra = {}) =>
    selectPlexUnits([row("unit_count", 2), row("unit_mix", actuals.map((actualRent, i) => ({
      actualRent, expectedMonthlyRent: estimates[i], occupancy: "occupied",
      actualRentBasis: "RMLS unit table; listing-reported, not lease-verified",
      expectedRentSource: "RentCast long-term AVM",
      expectedRentBasis: "Projected per documented unit", ...extra,
    })))]).get("test")!;
  it.each([
    [[1000, 1200], [2000, 2500], 2200, 4500, "actual", 2200],
    [[2500, 2600], [2000, 2500], 5100, 4500, "estimated", 4500],
    [[1000, 1200], [null, null], 2200, null, "actual", 2200],
    [[null, null], [2000, 2500], null, 4500, "estimated", 4500],
    [[1000, null], [2000, 2500], null, 4500, "mixed", 3500],
    [[0, 0], [2000, 2500], 0, 4500, "actual", 0],
    [[null, null], [null, null], null, null, null, null],
  ] as const)("selects supported rent per unit %#", (actuals, estimates, actualRent, estimatedRent, basis, rent) => {
    const result = plexNetIncome(make([...actuals], [...estimates]), piti);
    expect(result).toMatchObject({ actualRent, estimatedRent, basis, rent });
    expect(result.amount).toBe(rent === null ? null : rent - piti.monthlyTotal);
  });
  it("sums per-unit minima when actual and projected values cross", () => {
    const result = plexNetIncome(make([1000, 3000], [2000, 2500]), piti);
    expect(result).toMatchObject({ actualRent: 4000, estimatedRent: 4500, basis: "mixed", rent: 3500,
      amount: 3500 - piti.monthlyTotal, unitSelections: [{ basis: "actual", rent: 1000 }, { basis: "estimated", rent: 2500 }] });
  });
  it("combines sole supported values even when neither whole-building source is complete", () => {
    expect(plexNetIncome(make([1000, null], [null, 2500]), piti)).toMatchObject({
      actualRent: null, estimatedRent: null, basis: "mixed", rent: 3500, amount: 3500 - piti.monthlyTotal,
    });
    expect(plexNetIncome(make([1000, null], [2000, null]), piti).rent).toBeNull();
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "1850", undefined])(
    "keeps invalid or missing rents unsupported: %s", invalid => {
      const value = selectPlexUnits([row("unit_count", 2), row("unit_mix", [
        { occupancy: "occupied", actualRent: 1000, expectedMonthlyRent: 2000 },
        { occupancy: "occupied", actualRent: invalid, expectedMonthlyRent: invalid },
      ])]).get("test")!;
      expect(plexNetIncome(value, piti)).toMatchObject({ rent: null, basis: null, amount: null });
      const html = renderToStaticMarkup(createElement(PlexNetIncome, { summary: value, piti }));
      expect(html).toContain("Selected rent: Unknown / incomplete");
    });
  it("selects Emerson's vacant projection and occupied actual without fabricating zero", () => {
    const id = "78fe41a5-cdc3-412b-9958-1f62d7e292f8";
    const value = selectPlexUnits([
      { ...row("unit_count", 2), property_id: id },
      { ...row("unit_mix", [
        { bedrooms: 2, bathrooms: 1, occupancy: "vacant", actualRent: null, expectedMonthlyRent: 1850 },
        { bedrooms: 2, bathrooms: 1, occupancy: "occupied", actualRent: 1675, expectedMonthlyRent: 1850,
          actualRentBasis: "RMLS unit table; listing-reported, not lease-verified" },
      ]), property_id: id },
    ]).get(id)!;
    const before = structuredClone(value);
    expect(plexNetIncome(value, piti)).toMatchObject({ actualRent: null, estimatedRent: 3700,
      basis: "mixed", rent: 3525, amount: 3525 - piti.monthlyTotal });
    const html = renderToStaticMarkup(createElement(PlexNetIncome, { summary: value, piti }));
    expect(html).toContain("$3,525/mo mixed per-unit selected rent");
    expect(html).toContain("Selected rent: $1,850/mo (estimated)");
    expect(html).toContain("Selected rent: $1,675/mo (actual)");
    expect(value).toEqual(before);
    expect(value.units[0].actualMonthlyRent).toBeNull();
  });
  it.each(["vacant", "unknown"] as const)("uses projections for %s units with unsupported numeric actuals", occupancy => {
    const value = make([0, 1200], [1850, 1850]);
    value.units[0].occupancy = occupancy;
    expect(plexNetIncome(value, piti)).toMatchObject({ actualRent: null, rent: 3050, basis: "mixed" });
    value.units[0].expectedMonthlyRent = null;
    expect(plexNetIncome(value, piti).rent).toBeNull();
  });
  it("rejects unsupported actuals per unit while retaining another unit's actual and provenance", () => {
    const value = make([0, 1200], [1850, null]);
    value.units[0].actualRentBasis = "Historical whole-building rent; no supported allocation";
    const before = structuredClone(value);
    expect(plexNetIncome(value, piti)).toMatchObject({ actualRent: null, estimatedRent: null, rent: 3050, basis: "mixed" });
    const html = renderToStaticMarkup(createElement(PlexNetIncome, { summary: value, piti }));
    expect(html).toContain(value.units[0].actualRentBasis);
    expect(html).toContain("Projected per documented unit");
    expect(html).toContain("enriched-source");
    expect(value).toEqual(before);
  });
  it.each(["Projected rent", "proforma", "pro-forma", "historical annual rent", "unknown scope", "No supported allocation"])(
    "rejects explicit incompatible actual basis %s", actualRentBasis => {
      expect(plexNetIncome(make([1000, 1200], [null, null], { actualRentBasis }), piti).rent).toBeNull();
    });
  it.each(["vacant", "unknown"])("rejects actuals without compatible occupancy %s", occupancy => {
    expect(plexNetIncome(make([0, 1200], [null, null], { occupancy }), piti).actualRent).toBeNull();
  });
  it("keeps the numeric listing contract and requires recorded whole-property count", () => {
    const value = make([1000, 1200], [null, null], { actualRentBasis: undefined });
    expect(plexNetIncome(value, piti).basis).toBe("actual");
    expect(plexNetIncome({ ...value, recordedUnitCount: null }, piti).rent).toBeNull();
    expect(plexNetIncome({ ...value, recordedUnitCount: { count: 3, source: "RMLS", asOf: null } }, piti).rent).toBeNull();
  });
  it("explains source provenance, comparison, scope and exclusions", () => {
    const value = make([1000, null], [2000, 2500]);
    const html = renderToStaticMarkup(createElement(PlexNetIncome, { summary: value, piti }));
    expect(html).toContain("lower of supported actual and projected monthly rent");
    expect(html).toContain("not lease-verified collection");
    expect(html).toContain("Unknown / incomplete or noncomparable scope");
    expect(html).toContain("$4,500/mo");
    expect(html).toContain("$3,500/mo mixed per-unit selected rent");
    expect(html).toContain("mixed (actual and estimated per unit)");
    expect(html).toContain("Selected rent: $1,000/mo (actual)");
    expect(html).toContain("Selected rent: $2,500/mo (estimated)");
    expect(html).toContain("all units before owner occupancy");
    expect(html).toContain("RentCast long-term AVM");
    expect(html).toContain("RMLS unit table");
    expect(html).toContain("HOA dues");
    expect(value.units[0]).toMatchObject({ actualRentBasis: "RMLS unit table; listing-reported, not lease-verified",
      expectedRentSource: "RentCast long-term AVM", expectedRentBasis: "Projected per documented unit" });
  });
});
