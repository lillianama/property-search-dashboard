import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.mock("./db", () => ({ withReadOnlyClient: vi.fn() }));
import { withReadOnlyClient } from "./db";
import { EMPTY_HOUSE_FILTERS } from "./filters";
import { fetchStatusEventRows, fetchActiveFunnelCollections, fetchEditorJudgmentRows, fetchEditorNoteRows, fetchHouses, fetchPropertyLocation, fetchTrackedPropertyTotals } from "./queries";
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
