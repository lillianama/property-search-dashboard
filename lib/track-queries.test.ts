import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.mock("./db", () => ({ withReadOnlyClient: vi.fn() }));
import { withReadOnlyClient } from "./db";
import { EMPTY_HOUSE_FILTERS } from "./filters";
import { fetchMonthlyListingEvents, fetchStatusEventRows, fetchActiveFunnelCollections, fetchEditorJudgmentRows, fetchEditorNoteRows, fetchHouses, fetchPropertyLocation, fetchTrackedPropertyTotals } from "./queries";
import { trackUrl } from "./track";

const query = vi.fn();
beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  vi.mocked(withReadOnlyClient).mockImplementation(fn => fn({ query } as unknown as PoolClient));
});

describe("track-scoped database reads", () => {
  it.each(["house", "plex"] as const)("parameterizes the %s root and totals", async track => {
    await fetchHouses(EMPTY_HOUSE_FILTERS, track);
    expect(query.mock.calls[0][0]).toContain("pc.track = $6");
    expect(query.mock.calls[0][1]).toEqual([null, null, null, null, null, track]);
    await fetchTrackedPropertyTotals(track);
    expect(query.mock.calls[1][0]).toContain("WHERE track = $1");
    expect(query.mock.calls[1][1]).toEqual([track]);
    expect(query.mock.calls[1][0]).not.toContain("track IN");
  });

  it.each([fetchEditorNoteRows, fetchEditorJudgmentRows, fetchPropertyLocation])("rejects foreign property IDs at the read boundary", async fetchRows => {
    expect(await fetchRows("foreign-id", "plex")).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("track = $2");
    expect(query.mock.calls[0][1]).toEqual(["foreign-id", "plex"]);
  });

  it("ignores collection memberships belonging to another track", async () => {
    await fetchActiveFunnelCollections(["exampleProperty"], "plex");
    expect(query.mock.calls[0][0]).toContain("AND track = $3");
    expect(query.mock.calls[0][1][2]).toBe("plex");
  });

  it("preserves filters and overrides any existing track in client requests", () => {
    expect(trackUrl("/api/dashboard?maxPrice=600000&track=house", "plex")).toBe("/api/dashboard?maxPrice=600000&track=plex");
    expect(trackUrl("/api/street-view/id/metadata", "plex")).toBe("/api/street-view/id/metadata?track=plex");
  });
});

it("reads only allowlisted lifecycle facts for the supplied track-scoped ids, including statusless sales", async () => {
  query.mockResolvedValue({ rows: [{ property_id: "p", status: null, event_type: "sold", price: 500000,
    mls_number: "m", source: "rmls", event_date: "2026-07-01", observed_at: "2026-07-02", id: "42",
    raw: { private: "must not escape" }, source_ref: "private" }] });
  expect(await fetchStatusEventRows(["p"])).toEqual([{ propertyId: "p", status: null, eventType: "sold", price: 500000,
    mlsNumber: "m", source: "rmls", eventDate: "2026-07-01", observedAt: "2026-07-02", id: 42 }]);
  const [sql, params] = query.mock.calls[0];
  expect(params).toEqual([["p"]]);
  expect(sql).toContain("property_id = ANY($1::uuid[])");
  expect(sql).not.toMatch(/status IS NOT NULL|source_ref|\braw\b|SELECT \*/i);
});

it("uses ingestion dates, distinct canonical IDs and current price fallback independently of observations", async () => {
  await fetchMonthlyListingEvents({ ...EMPTY_HOUSE_FILTERS, dateFrom: "2026-01-01" }, ["p", "p"]);
  const [sql, params] = query.mock.calls[0];
  expect(sql).toContain("p.created_at AT TIME ZONE 'America/Los_Angeles'");
  expect(sql).toContain("p.created_at <= CURRENT_TIMESTAMP");
  expect(sql).not.toMatch(/observed_at|first_seen_at|last_seen_at/);
  expect(params).toEqual([["p"], "2026-01-01", null, []]);
  expect(sql).toContain("SELECT DISTINCT p.id");
  expect(sql).toContain("WHEN pc.latest_price > 0 THEN pc.latest_price");
  expect(sql).toContain("WHEN pc.latest_sale_price > 0 THEN pc.latest_sale_price ELSE NULL");
  expect(sql).not.toMatch(/property_listing_events|property_observations|event_date/);
});

it("prefers known sale prices only for resolved sold properties, with listing then sale fallback", async () => {
  await fetchMonthlyListingEvents(EMPTY_HOUSE_FILTERS, ["active", "sold"], ["sold", "sold"]);
  const [sql, params] = query.mock.calls[0];
  expect(params[3]).toEqual(["sold"]);
  expect(sql).toContain("CASE WHEN p.id = ANY($4::uuid[]) AND pc.latest_sale_price > 0 THEN pc.latest_sale_price");
  expect(sql.indexOf("p.id = ANY($4")).toBeLessThan(sql.indexOf("WHEN pc.latest_price"));
});
