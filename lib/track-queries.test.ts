import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

vi.mock("./db", () => ({ withReadOnlyClient: vi.fn() }));
import { withReadOnlyClient } from "./db";
import { EMPTY_HOUSE_FILTERS } from "./filters";
import { fetchActiveFunnelCollections, fetchEditorJudgmentRows, fetchEditorNoteRows, fetchHouses, fetchPropertyLocation, fetchTrackedPropertyTotals } from "./queries";
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
