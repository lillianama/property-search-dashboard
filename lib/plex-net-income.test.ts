import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FunnelBoard } from "../app/components/FunnelBoard";
import { PlexNetIncome } from "../app/components/PlexNetIncome";
import { TrackContext } from "../app/components/TrackContext";
import { computePiti, DEFAULT_PITI_ASSUMPTIONS } from "./piti";
import { plexNetIncome } from "./plex-net-income";
import { selectPlexUnits, type UnitSourceRow } from "./plex-units";
import type { HouseRecord } from "./types";

vi.mock("../app/components/PropertyPhoto", () => ({ PropertyPhoto: () => null }));
const row = (field: UnitSourceRow["field"], value: unknown, observed_at = "2026-11-01"): UnitSourceRow =>
  ({ property_id: "test", field, value, observed_at, source: "enriched-source" });
const summary = (rents: (number | null)[] = [2000, 2500], count: number | null = 2) =>
  selectPlexUnits([row("unit_mix", rents.map(expectedMonthlyRent => ({ expectedMonthlyRent, actualRent: 100, occupancy: "occupied", raw: "private" }))),
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
      createElement(FunnelBoard, { properties: [property], placements: {}, onMove: vi.fn(), onEditNotes: vi.fn(), onWatchlistBottom: vi.fn(), pitiAssumptions: DEFAULT_PITI_ASSUMPTIONS })));
    const html = render("plex");
    const meta = html.slice(html.indexOf('class="funnel-row-line funnel-row-meta"'));
    expect(meta).toMatch(/^class="funnel-row-line funnel-row-meta"><details class="piti-details"[\s\S]*?<\/details><details class="plex-net-income /);
    expect(meta.indexOf("Est. net income")).toBeLessThan(meta.indexOf('class="funnel-row-actions"'));
    expect(render("house")).not.toContain("Est. net income");
    expect(render("house")).toBe(render("house", { ...house, plexUnits: undefined }));
  });
});
