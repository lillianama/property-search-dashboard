import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HouseFilters } from "./filters";
import type { HouseRecord } from "./types";

vi.mock("./plex-unit-queries", () => ({ fetchPlexUnitSummaries: vi.fn() }));
import { fetchPlexUnitSummaries } from "./plex-unit-queries";

vi.mock("./queries", () => ({
  fetchActiveFunnelCollections: vi.fn(),
  fetchActualTaxRows: vi.fn(),
  fetchHouses: vi.fn(),
  fetchLatestDecisionRows: vi.fn(),
  fetchMonthlyListingEvents: vi.fn(),
  fetchNeighborhoodObservationRows: vi.fn(),
  fetchPhotoSourceRows: vi.fn(),
  fetchStatusEventRows: vi.fn(),
  fetchTrackedPropertyTotals: vi.fn(),
}));

vi.mock("./market-queries", () => ({
  fetchNeighborhoodZhviPoints: vi.fn(),
}));

import { buildDashboardResponse } from "./dashboard";
import { fetchNeighborhoodZhviPoints } from "./market-queries";
import {
  fetchActiveFunnelCollections,
  fetchActualTaxRows,
  fetchHouses,
  fetchLatestDecisionRows,
  fetchMonthlyListingEvents,
  fetchNeighborhoodObservationRows,
  fetchPhotoSourceRows,
  fetchStatusEventRows,
  fetchTrackedPropertyTotals,
} from "./queries";

const NO_FILTERS: HouseFilters = {
  statuses: null,
  maxPrice: null,
  minBedrooms: null,
  maxYearBuilt: null,
  dateFrom: null,
  dateTo: null,
};

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
  vi.mocked(fetchPlexUnitSummaries).mockReset().mockResolvedValue(new Map());
  vi.mocked(fetchNeighborhoodObservationRows).mockResolvedValue([]);
  vi.mocked(fetchNeighborhoodZhviPoints).mockResolvedValue([]);
  vi.mocked(fetchActiveFunnelCollections).mockResolvedValue([]);
  vi.mocked(fetchActualTaxRows).mockResolvedValue([]);
  vi.mocked(fetchLatestDecisionRows).mockResolvedValue([]);
  vi.mocked(fetchMonthlyListingEvents).mockResolvedValue([]);
  vi.mocked(fetchStatusEventRows).mockResolvedValue([]);
  vi.mocked(fetchTrackedPropertyTotals).mockResolvedValue({ houseTotal: 2, storeTotal: 3 });
});

describe("buildDashboardResponse photo shaping", () => {
  it("attaches a photo only to houses with a persisted safe photo URL", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1" }),
      house({ id: "prop-2", address: "456 NE Other Ave" }),
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

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(fetchPhotoSourceRows).toHaveBeenCalledWith(["prop-1", "prop-2"]);
    const [first, second] = response.properties;
    expect(first.photoUrl).toBe("https://photos.zillowstatic.com/fp/abc-cc_ft_768.jpg");
    expect(first.photoSource).toBe("rentcast-house-weekly");
    expect(second.photoUrl).toBeNull();
    expect(second.photoSource).toBeNull();
    expect(response.meta.photoCoverageNote).toContain("1 of 2");
  });

  it("never surfaces raw payload fields on the API records", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([
      {
        propertyId: "prop-1",
        payload: { photoUrl: "https://example.com/a.jpg", owner: "Private Person" },
        source: "rentcast-property",
        observedAt: null,
        confidence: null,
      },
    ]);

    const response = await buildDashboardResponse(NO_FILTERS);
    const record = response.properties[0] as unknown as Record<string, unknown>;
    expect(record.photoUrl).toBe("https://example.com/a.jpg");
    expect(record.owner).toBeUndefined();
    expect(record.payload).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("Private Person");
  });

  it("reports zero coverage honestly when no photos are persisted", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);
    expect(response.properties[0].photoUrl).toBeNull();
    expect(response.meta.photoCoverageNote).toContain("0 of 1");
  });

  it("keeps street view fallback coverage distinct from listing-photo coverage", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      // Stored listing photo: not counted as street view eligible.
      house({ id: "prop-1" }),
      // No photo, Portland coordinates: eligible for street view fallback.
      house({ id: "prop-2", address: "456 NE Other Ave" }),
      // No photo, no coordinates: placeholder only.
      house({ id: "prop-3", address: "789 SW Third St", latitude: null, longitude: null }),
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([
      {
        propertyId: "prop-1",
        payload: { photoUrl: "https://photos.zillowstatic.com/fp/abc.jpg" },
        source: "rentcast-house-weekly",
        observedAt: "2026-07-01T00:00:00Z",
        confidence: 0.7,
      },
    ]);

    const response = await buildDashboardResponse(NO_FILTERS);
    // Real photo coverage counts only the persisted listing photo.
    expect(response.meta.photoCoverageNote).toContain("1 of 3");
    // The street view note covers the two photo-less houses separately.
    expect(response.meta.streetViewNote).toContain("1 of the 2");
    expect(response.meta.streetViewNote).toContain("never presented as a listing photo");
  });

  it("degrades to placeholders instead of failing when the photo lookup errors", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchPhotoSourceRows).mockRejectedValue(new Error("boom"));

    const response = await buildDashboardResponse(NO_FILTERS);
    expect(response.meta.dbAvailable).toBe(true);
    expect(response.properties).toHaveLength(1);
    expect(response.properties[0].photoUrl).toBeNull();
  });
});

describe("buildDashboardResponse rejection exclusion", () => {
  it("excludes a rejected house from the table, KPIs, and distributions", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1", latestPrice: 400000 }),
      house({ id: "prop-2", address: "456 NE Other Ave", latestPrice: 600000 }),
    ]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      { propertyId: "prop-2", verdict: "reject", note: "Synthetic size concern.", occurredAt: "2026-07-17T02:00:00Z" },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.properties.map((p) => p.id)).toEqual(["prop-1"]);
    expect(response.summary.knownHouses).toBe(1);
    expect(response.summary.medianLatestPrice).toBe(400000);
    expect(response.priceDistribution.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1);
  });

  it("passes only the surviving property ids to fetchMonthlyListingEvents so charts exclude rejected houses", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" }), house({ id: "prop-2" })]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      { propertyId: "prop-2", verdict: "rejected", note: null, occurredAt: "2026-07-17T02:00:00Z" },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    await buildDashboardResponse(NO_FILTERS);

    expect(fetchMonthlyListingEvents).toHaveBeenCalledWith(NO_FILTERS, ["prop-1"]);
  });

  it("restores a previously rejected house once a later decision supersedes the rejection", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      { propertyId: "prop-1", verdict: "reject", note: "Old concern.", occurredAt: "2026-07-01T00:00:00Z" },
      { propertyId: "prop-1", verdict: "green", note: "Synthetic reconsideration.", occurredAt: "2026-07-17T21:00:00Z" },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.properties.map((p) => p.id)).toEqual(["prop-1"]);
  });

  it("never treats an automated SKIP verdict as a rejection", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchLatestDecisionRows).mockResolvedValue([
      { propertyId: "prop-1", verdict: "SKIP", note: null, occurredAt: "2026-07-17T00:00:00Z" },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.properties.map((p) => p.id)).toEqual(["prop-1"]);
  });
});

describe("buildDashboardResponse status resolution", () => {
  it("resolves display statuses from the event history, rescuing Pending buried under generic Inactive", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1", latestStatus: "Inactive", displayStatus: "Inactive" }),
    ]);
    vi.mocked(fetchStatusEventRows).mockResolvedValue([
      { propertyId: "prop-1", status: "Pending", source: "user-status-update", eventDate: null, observedAt: "2026-07-17T02:50:17Z", id: 1 },
      { propertyId: "prop-1", status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18", observedAt: "2026-07-18T02:11:29Z", id: 2 },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.properties[0].displayStatus).toBe("Pending");
    // The raw latest status is preserved untouched for transparency.
    expect(response.properties[0].latestStatus).toBe("Inactive");
    expect(response.summary.pending).toBe(1);
    expect(response.summary.inactive).toBe(0);
    expect(response.statusDistribution).toEqual([{ status: "Pending", count: 1 }]);
  });

  it("applies the status filter to RESOLVED statuses", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1", latestStatus: "Inactive", displayStatus: "Inactive" }),
      house({ id: "prop-2", address: "456 NE Other Ave", latestStatus: "Active", displayStatus: "Active" }),
    ]);
    vi.mocked(fetchStatusEventRows).mockResolvedValue([
      { propertyId: "prop-1", status: "Pending", source: "user-status-update", eventDate: null, observedAt: "2026-07-17T02:50:17Z", id: 1 },
      { propertyId: "prop-1", status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18", observedAt: "2026-07-18T02:11:29Z", id: 2 },
      { propertyId: "prop-2", status: "Active", source: "rmls", eventDate: "2026-07-15", observedAt: "2026-07-15T00:00:00Z", id: 3 },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse({ ...NO_FILTERS, statuses: ["Pending"] });

    expect(response.properties.map((p) => p.id)).toEqual(["prop-1"]);
    expect(response.summary.knownHouses).toBe(1);
  });

  it("keeps the raw-status fallback when the event lookup fails", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1", latestStatus: "Inactive", displayStatus: "Inactive" }),
    ]);
    vi.mocked(fetchStatusEventRows).mockRejectedValue(new Error("boom"));
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.meta.dbAvailable).toBe(true);
    expect(response.properties[0].displayStatus).toBe("Inactive");
  });
});

describe("buildDashboardResponse actual annual taxes", () => {
  it("attaches the best actual recorded annual tax (with provenance) to each house", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1" }),
      house({ id: "prop-2", address: "456 NE Other Ave" }),
    ]);
    vi.mocked(fetchActualTaxRows).mockResolvedValue([
      {
        propertyId: "prop-1",
        kind: "by-year",
        value: { "2024": { year: 2024, total: 2931 } },
        source: "rentcast-property",
        observedAt: "2026-07-17T00:00:00Z",
        confidence: null,
      },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.properties[0].annualTaxAmount).toBe(2931);
    expect(response.properties[0].annualTaxYear).toBe(2024);
    expect(response.properties[0].annualTaxAsOf).toBe("2026-07-17T00:00:00Z");
    expect(response.properties[0].annualTaxSource).toBe("rentcast-property");
    // No actual tax recorded: everything stays null so the UI shows an
    // explicitly incomplete PITI — never an estimated tax.
    expect(response.properties[1].annualTaxAmount).toBeNull();
    expect(response.properties[1].annualTaxYear).toBeNull();
    expect(response.properties[1].annualTaxSource).toBeNull();
  });

  it("degrades to no recorded tax (incomplete PITI) when the lookup fails", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchActualTaxRows).mockRejectedValue(new Error("boom"));
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.meta.dbAvailable).toBe(true);
    expect(response.properties[0].annualTaxAmount).toBeNull();
  });
});

describe("buildDashboardResponse funnel bucket annotation", () => {
  it("annotates each house with its derived bucket, defaulting to watchlist", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1" }),
      house({ id: "prop-2", address: "456 NE Other Ave" }),
      house({ id: "prop-3", address: "789 SW Third St" }),
    ]);
    vi.mocked(fetchActiveFunnelCollections).mockResolvedValue([
      { propertyId: "prop-1", collection: "top-contenders" },
      { propertyId: "prop-1", collection: "tour-shortlist" },
      { propertyId: "prop-2", collection: "tour_shortlist" },
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    const buckets = Object.fromEntries(response.properties.map((p) => [p.id, p.funnelBucket]));
    expect(buckets).toEqual({
      "prop-1": "top-contenders",
      "prop-2": "to-tour",
      "prop-3": "watchlist",
    });
  });

  it("degrades to the watchlist catch-all when the funnel lookup fails", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchActiveFunnelCollections).mockRejectedValue(new Error("boom"));
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.meta.dbAvailable).toBe(true);
    expect(response.properties[0].funnelBucket).toBe("watchlist");
  });
});

describe("buildDashboardResponse neighborhood annotation", () => {
  it("attaches the assessor neighborhood and its matched Zillow ZHVI context", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([
      house({ id: "prop-1" }),
      house({ id: "prop-2", address: "456 NE Other Ave" }),
    ]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);
    vi.mocked(fetchNeighborhoodObservationRows).mockResolvedValue([
      {
        propertyId: "prop-1",
        neighborhood: "HILLSDALE",
        source: "portlandmaps-assessor",
        observedAt: "2026-07-01T00:00:00Z",
        id: 1,
      },
      // RMLS neighborhoods are never trusted for this join.
      {
        propertyId: "prop-2",
        neighborhood: "CONCORDIA / ALBERTA",
        source: "rmls",
        observedAt: "2026-07-01T00:00:00Z",
        id: 2,
      },
    ]);
    vi.mocked(fetchNeighborhoodZhviPoints).mockResolvedValue([
      { regionId: "r-1", name: "Hillsdale", month: "2025-05", value: 600_000 },
      { regionId: "r-1", name: "Hillsdale", month: "2026-05", value: 660_000 },
    ]);

    const response = await buildDashboardResponse(NO_FILTERS);

    const [first, second] = response.properties;
    expect(first.neighborhood).toBe("HILLSDALE");
    expect(first.neighborhoodMarket).toEqual({
      regionId: "r-1",
      regionName: "Hillsdale",
      latestMonth: "2026-05",
      latestValue: 660_000,
      yearChangePct: 10,
    });
    expect(second.neighborhood).toBeNull();
    expect(second.neighborhoodMarket).toBeNull();
  });

  it("leaves neighborhoods null when the lookup fails (best-effort)", async () => {
    vi.mocked(fetchHouses).mockResolvedValue([house({ id: "prop-1" })]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);
    vi.mocked(fetchNeighborhoodObservationRows).mockRejectedValue(new Error("boom"));

    const response = await buildDashboardResponse(NO_FILTERS);

    expect(response.meta.dbAvailable).toBe(true);
    expect(response.properties[0].neighborhood).toBeNull();
    expect(response.properties[0].neighborhoodMarket).toBeNull();
  });
});

describe("Plexes dashboard scope", () => {
  it("keeps persisted 123 NE Example St in Watchlist without a collection and scopes every enrichment", async () => {
    vi.clearAllMocks();
    const exampleProperty = house({ id: "exampleProperty", address: "123 NE Example St" });
    vi.mocked(fetchHouses).mockImplementation(async (_filters, track) => track === "plex" ? [exampleProperty] : [house({ id: "house" })]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);
    vi.mocked(fetchTrackedPropertyTotals).mockResolvedValue({ houseTotal: 1, storeTotal: 1 });
    const result = await buildDashboardResponse(NO_FILTERS, "plex");
    expect(result.properties.map(p => [p.address, p.funnelBucket])).toEqual([["123 NE Example St", "watchlist"]]);
    expect(result.summary.knownHouses).toBe(1);
    expect(result.meta.trackedPropertyTotal).toBe(1);
    expect(result.meta.coverageNote).toContain("1 plexes");
    expect(fetchHouses).toHaveBeenCalledWith(NO_FILTERS, "plex");
    expect(fetchTrackedPropertyTotals).toHaveBeenCalledWith("plex");
    expect(fetchActiveFunnelCollections).toHaveBeenCalledWith(["exampleProperty"], "plex");
    for (const fetchRows of [fetchLatestDecisionRows, fetchActualTaxRows, fetchPhotoSourceRows, fetchStatusEventRows, fetchNeighborhoodObservationRows]) {
      expect(fetchRows).toHaveBeenCalledWith(["exampleProperty"]);
    }
    expect(fetchMonthlyListingEvents).toHaveBeenCalledWith(NO_FILTERS, ["exampleProperty"]);
    expect(fetchNeighborhoodZhviPoints).not.toHaveBeenCalled();
  });
});


describe("plex-only unit API projection", () => {
  it("attaches unknown units only for plexes, preserving existing property facts", async () => {
    vi.mocked(fetchPlexUnitSummaries).mockReset().mockResolvedValue(new Map());
    vi.mocked(fetchHouses).mockResolvedValue([house({})]);
    vi.mocked(fetchPhotoSourceRows).mockResolvedValue([]);
    const houses = await buildDashboardResponse(NO_FILTERS, "house");
    expect(fetchPlexUnitSummaries).not.toHaveBeenCalled();
    expect(houses.properties[0]).not.toHaveProperty("plexUnits");
    const plexes = await buildDashboardResponse(NO_FILTERS, "plex");
    expect(fetchPlexUnitSummaries).toHaveBeenCalledWith(["prop-1"]);
    expect(plexes.properties[0].plexUnits).toEqual({ units: [], recordedUnitCount: null });
    const { plexUnits, ...existing } = plexes.properties[0];
    expect(existing).toEqual(houses.properties[0]);
    vi.mocked(fetchPlexUnitSummaries).mockRejectedValueOnce(new Error("unavailable"));
    expect((await buildDashboardResponse(NO_FILTERS, "plex")).properties[0].plexUnits)
      .toEqual({ units: [], recordedUnitCount: null });
  });
});
