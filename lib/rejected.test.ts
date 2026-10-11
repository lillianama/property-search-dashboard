import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseRecord } from "./types";

vi.mock("./queries", () => ({
  fetchHouses: vi.fn(),
  fetchLatestDecisionRows: vi.fn(),
  fetchPhotoSourceRows: vi.fn(),
  fetchStatusEventRows: vi.fn(),
}));

import { buildRejectedHousesResponse } from "./rejected";
import { fetchHouses, fetchLatestDecisionRows, fetchPhotoSourceRows, fetchStatusEventRows } from "./queries";

function house(overrides: Partial<HouseRecord>): HouseRecord {
  return {
    id: "prop-1",
    address: "123 SE Example St",
    city: "Portland",
    state: "OR",
    zipCode: "97202",
    latitude: 45.5,
    longitude: -122.6,
    bedrooms: 3,
    bathrooms: 1,
    finishedSqft: 1400,
    yearBuilt: 1925,
    latestPrice: 450000,
    latestStatus: "Active",
    latestSalePrice: null,
    latestSaleDate: null,
    bedroomSizeFlag: "ok",
    smallestBedroomSqft: 110,
    zillowUrl: null,
    photoUrl: null,
    photoSource: null,
    funnelBucket: "watchlist",
    rankKey: null,
    judgments: { bedroomSizeOk: "unknown" as const, rentalIncome: "unknown" as const, drumSpace: "unknown" as const },
    displayStatus: "Active",
    dateAdded: null,
    annualTaxAmount: null,
    annualTaxYear: null,
    annualTaxAsOf: null,
    annualTaxSource: null,
    firstSeenAt: null,
    lastSeenAt: "2026-07-01T00:00:00Z",
    neighborhood: null,
    neighborhoodMarket: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);
  vi.mocked(fetchStatusEventRows).mockResolvedValue([]);
});

describe("buildRejectedHousesResponse", () => {
  it("includes a rejected house with its rejection reason and date", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1" }),
      house({ id: "prop-2", address: "789 N Example Ave" }),
    ]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      {
        propertyId: "prop-2",
        verdict: "reject",
        note: "Synthetic rejection reason.",
        occurredAt: "2026-07-17T02:00:00.404142Z",
      },
    ]);

    const response = await buildRejectedHousesResponse();

    expect(response.meta.dbAvailable).toBe(true);
    expect(response.properties).toHaveLength(1);
    expect(response.properties[0]).toMatchObject({
      id: "prop-2",
      rejectionReason: "Synthetic rejection reason.",
      rejectionAt: "2026-07-17T02:00:00.404142Z",
    });
  });

  it("excludes houses with no explicit rejection, automated SKIP verdicts, or boundary exclusions", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1" }),
      house({ id: "prop-2" }),
      house({ id: "prop-3" }),
    ]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      { propertyId: "prop-2", verdict: "SKIP", note: null, occurredAt: "2026-07-16T00:00:00Z" },
      { propertyId: "prop-3", verdict: "\u{1F534} outside boundary", note: null, occurredAt: "2026-07-16T00:00:00Z" },
    ]);

    const response = await buildRejectedHousesResponse();

    expect(response.properties).toHaveLength(0);
  });

  it("returns an honest empty archive, not an error, when nothing has been rejected", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([]);

    const response = await buildRejectedHousesResponse();

    expect(response.meta.dbAvailable).toBe(true);
    expect(response.properties).toEqual([]);
  });

  it("attaches stored listing photos to rejected houses just like the main dashboard", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      { propertyId: "prop-1", verdict: "reject", note: "Synthetic lot concern.", occurredAt: "2026-07-17T03:00:00Z" },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([
      {
        propertyId: "prop-1",
        payload: { photos: ["https://photos.zillowstatic.com/fp/abc-cc_ft_768.jpg"] },
        source: "rentcast-house-weekly",
        observedAt: "2026-07-01T00:00:00Z",
        confidence: 0.7,
      },
    ]);

    const response = await buildRejectedHousesResponse();

    expect(response.properties[0].photoUrl).toBe("https://photos.zillowstatic.com/fp/abc-cc_ft_768.jpg");
    expect(response.meta.photoCoverageNote).toContain("1 of 1");
  });

  it("shows the resolved display status in the archive, same as My Search", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1", latestStatus: "Inactive", displayStatus: "Inactive" }),
    ]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      { propertyId: "prop-1", verdict: "reject", note: null, occurredAt: "2026-07-17T03:00:00Z" },
    ]);
    vi.mocked(fetchStatusEventRows).mockResolvedValue([
      { propertyId: "prop-1", status: "Pending", source: "user-status-update", eventDate: null, observedAt: "2026-07-17T02:50:17Z", id: 1 },
      { propertyId: "prop-1", status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18", observedAt: "2026-07-18T02:11:29Z", id: 2 },
    ]);

    const response = await buildRejectedHousesResponse();

    expect(response.properties[0].displayStatus).toBe("Pending");
    expect(response.properties[0].latestStatus).toBe("Inactive");
  });

  it("degrades to an empty archive instead of throwing when the database is unavailable", async () => {
    vi.mocked(fetchHouses).mockRejectedValue(new Error("connection refused"));

    const response = await buildRejectedHousesResponse();

    expect(response.meta.dbAvailable).toBe(false);
    expect(response.properties).toEqual([]);
  });
});

it("scopes the rejected archive and its photos/statuses to Plexes", async () => {
  vi.clearAllMocks();
  vi.mocked(fetchHouses).mockImplementation(async (_filters, track) => track === "plex" ? [house({ id: "plex" })] : [house({ id: "house" })]);
  vi.mocked(fetchLatestDecisionRows).mockResolvedValue([{ propertyId: "plex", verdict: "reject", note: "test", occurredAt: "2026-07-01T00:00:00Z" }]);
  const result = await buildRejectedHousesResponse("plex");
  expect(result.properties.map(p => p.id)).toEqual(["plex"]);
  expect(fetchHouses).toHaveBeenCalledWith(expect.objectContaining({ maxPrice: null }), "plex");
  for (const query of [fetchLatestDecisionRows, fetchStatusEventRows, fetchPhotoSourceRows]) expect(query).toHaveBeenCalledWith(["plex"]);
});
