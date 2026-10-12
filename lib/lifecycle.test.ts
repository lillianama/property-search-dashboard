import { lifecycleDetailLines } from "./lifecycle-display";
import type { HouseRecord } from "./types";
import { describe, expect, it } from "vitest";
import { lifecycleFacts, saleComparison } from "./lifecycle";
import type { StatusEventRow } from "./status";
import { DEFAULT_APP_URL_STATE, parseAppUrlState, serializeAppUrlState, switchUrlScope } from "./url-state";
const event = (id: number, status: string | null, extra: Partial<StatusEventRow> = {}): StatusEventRow => ({
  id, propertyId: "p", status, source: "rmls", eventDate: `2026-07-${String(id).padStart(2, "0")}`,
  observedAt: `2026-08-01T00:00:00Z`, eventType: "listing_observed", price: 500000, mlsNumber: "listing-a", ...extra,
});

describe("source-backed lifecycle", () => {
  it.each(["Pending", "Sold"])("requires authoritative return from %s, even after generic Active", state => {
    const rows = [event(1, "Active"), event(2, state), event(3, "Active", { source: "workspace-state" }),
      event(4, "Inactive", { source: "rentcast-house-weekly" })];
    expect(lifecycleFacts(rows)).toMatchObject({ displayStatus: state, backOnMarket: null });
    rows.push(event(5, "Active", { source: "zillow" }));
    expect(lifecycleFacts(rows)).toMatchObject({ displayStatus: "Active", backOnMarket: { date: "2026-07-05", source: "zillow" } });
    rows.push(event(6, "Pending"));
    expect(lifecycleFacts(rows)).toMatchObject({ displayStatus: "Pending", backOnMarket: null });
  });
  it("accepts a recorded feed sale after Pending without treating generic Active as a relist", () => {
    expect(lifecycleFacts([event(1, "Pending"), event(2, "Sold", { source: "rentcast-house-weekly", eventType: "sold" }),
      event(3, "Active", { source: "watchlist-status-check" })])).toMatchObject({ displayStatus: "Sold", backOnMarket: null });
  });
  it("uses the sale date, not late ingestion, and accepts sold events without status", () => {
    expect(lifecycleFacts([event(3, "Active"), event(1, null, { eventType: "sold", observedAt: "2026-09-01T00:00:00Z" })]).displayStatus).toBe("Active");
    expect(lifecycleFacts([event(1, "Active"), event(3, null, { eventType: "sold" })]).displayStatus).toBe("Sold");
  });
});

describe("sale comparison", () => {
  const rows = [event(1, "Active", { price: 550000 }), event(2, "Active"),
    event(3, "Sold", { eventType: "sold", price: 480000 }), event(4, "Active", { price: 700000, mlsNumber: "new-listing" })];
  it("identifies the last matching pre-sale listing event, never a later listing price", () => {
    expect(saleComparison(rows.slice(0, 3))).toEqual({ soldPrice: 480000, soldDate: "2026-07-03", saleSource: "rmls",
      listPrice: 500000, listDate: "2026-07-02", listSource: "rmls", listEventId: 2, dollarDelta: -20000, percentDelta: -4 });
  });
  it.each([{ mlsNumber: null }, { mlsNumber: "other" }, { source: "assessor" }, { eventDate: null }])("keeps unverifiable association unknown: %j", change => {
    const result = saleComparison([rows[0], rows[1], { ...rows[2], ...change }]);
    expect(result.soldPrice).toBe(480000);
    expect(result.listPrice).toBeNull();
    expect(result.dollarDelta).toBeNull();
  });
  it("does not reuse a historical sale after a relist and new sold status with missing facts", () => {
    expect(saleComparison([...rows, event(5, "Sold", { price: null })])).toMatchObject({ soldPrice: null, soldDate: null, listPrice: null });
  });
  it("does not cross a previous sale or use a sold price as a list price", () => {
    expect(saleComparison([rows[0], rows[2], event(5, "Sold", { eventType: "sold", price: 600000 })]).listPrice).toBeNull();
  });
  it("keeps missing sold price explicit rather than reusing a historical sale", () => {
    expect(saleComparison([rows[2], event(5, "Sold", { eventType: "sold", price: null })])).toMatchObject({ soldPrice: null, dollarDelta: null });
  });
});

describe("lifecycle route and filter isolation", () => {
  it("restores independent filters across refresh, tabs and tracks, including map/editor URLs", () => {
    let state = { ...DEFAULT_APP_URL_STATE, tab: "search" as const,
      filters: { ...DEFAULT_APP_URL_STATE.filters, maxPrice: "600000", statuses: ["Active"] } };
    let next = switchUrlScope(state, "house", "pending");
    expect(next.filters.maxPrice).toBe("");
    next = { ...next, view: "map", editingId: "p", filters: { ...next.filters, minBedrooms: "3" } };
    next = parseAppUrlState(serializeAppUrlState(next));
    expect(next).toMatchObject({ tab: "pending", view: "map", editingId: "p", filters: { minBedrooms: "3" } });
    next = { ...next, filters: { ...next.filters, maxPrice: "525000" } };
    next = parseAppUrlState(serializeAppUrlState(next));
    expect(next.filters).toMatchObject({ minBedrooms: "3", maxPrice: "525000" });
    next = switchUrlScope(next, "plex", "pending");
    expect(next.filters.minBedrooms).toBe("");
    next = switchUrlScope(next, "house", "sold");
    expect(next.filters.statuses).toEqual([]);
    next = parseAppUrlState(serializeAppUrlState(next));
    expect(switchUrlScope(next, "house", "search").filters).toEqual(state.filters);
    expect(switchUrlScope(next, "house", "pending").filters).toMatchObject({ minBedrooms: "3", maxPrice: "525000" });
  });
});

it("renders explicit unknowns and signed comparison with event provenance in both views", () => {
  const house = { displayStatus: "Sold" } as HouseRecord;
  expect(lifecycleDetailLines(house).join(" ")).toContain("Sold date: Unknown");
  house.saleComparison = saleComparison([event(1, "Active"), event(2, "Sold", { eventType: "sold", price: 520000 })]);
  const copy = lifecycleDetailLines(house).join(" ");
  expect(copy).toContain("listing event #1");
  expect(copy).toContain("+$20,000 (+4.0%)");
});


describe("historical ownership sales versus tracked listing cycles", () => {
  it.each(["portlandmaps-assessor", "rentcast-property"])("does not archive a later listing solely due to a historical %s sale", source => {
    const sale = event(1, "Sold", { source, eventType: "sold" });
    expect(lifecycleFacts([sale, event(2, "Active", { source: "rentcast-plex-weekly" })]).displayStatus).toBe("Active");
    expect(lifecycleFacts([sale]).displayStatus).toBe("Sold");
    expect(lifecycleFacts([event(1, "Active"), event(2, "Sold", { source, eventType: "sold" }),
      event(3, "Active", { source: "workspace-state" })]).displayStatus).toBe("Sold");
  });
});
