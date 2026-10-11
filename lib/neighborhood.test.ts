import { describe, expect, it } from "vitest";
import { buildNeighborhoodRows } from "./market";
import {
  joinNeighborhoodMarket,
  matchZhviRow,
  normalizeNeighborhoodKey,
  selectAssessorNeighborhoods,
  type NeighborhoodObservationRow,
} from "./neighborhood";
import type { NeighborhoodZhviRow } from "./types";

function obs(overrides: Partial<NeighborhoodObservationRow>): NeighborhoodObservationRow {
  return {
    propertyId: "prop-1",
    neighborhood: "HILLSDALE",
    source: "portlandmaps-assessor",
    observedAt: "2026-07-01T00:00:00Z",
    id: 1,
    ...overrides,
  };
}

function zhvi(overrides: Partial<NeighborhoodZhviRow>): NeighborhoodZhviRow {
  return {
    regionId: "r-1",
    name: "Hillsdale",
    latestMonth: "2026-05",
    latestValue: 650_000,
    yearAgoValue: 600_000,
    yearChangePct: 8.333,
    ...overrides,
  };
}

describe("normalizeNeighborhoodKey", () => {
  it("uppercases and collapses whitespace", () => {
    expect(normalizeNeighborhoodKey("  Hillsdale ")).toBe("HILLSDALE");
    expect(normalizeNeighborhoodKey("Rose  City   Park")).toBe("ROSE CITY PARK");
  });

  it("normalizes hyphens surrounded by spaces", () => {
    expect(normalizeNeighborhoodKey("Hosford - Abernethy")).toBe("HOSFORD-ABERNETHY");
    expect(normalizeNeighborhoodKey("HOSFORD-ABERNETHY")).toBe("HOSFORD-ABERNETHY");
  });

  it("drops periods so abbreviations compare cleanly", () => {
    expect(normalizeNeighborhoodKey("MT. TABOR")).toBe("MT TABOR");
    expect(normalizeNeighborhoodKey("St.Johns")).toBe("ST JOHNS");
  });

  it("straightens curly apostrophes", () => {
    expect(normalizeNeighborhoodKey("Sullivan\u2019s Gulch")).toBe("SULLIVAN'S GULCH");
    expect(normalizeNeighborhoodKey("SULLIVAN'S GULCH")).toBe("SULLIVAN'S GULCH");
  });
});

describe("selectAssessorNeighborhoods", () => {
  it("keeps only portlandmaps-assessor rows", () => {
    const map = selectAssessorNeighborhoods([
      obs({ source: "rmls", neighborhood: "CONCORDIA / ALBERTA" }),
      obs({ source: "portlandmaps-assessor", neighborhood: "CONCORDIA", id: 2 }),
    ]);
    expect(map.get("prop-1")).toBe("CONCORDIA");
  });

  it("ignores blank/null values and leaves such properties absent", () => {
    const map = selectAssessorNeighborhoods([
      obs({ neighborhood: "  " }),
      obs({ neighborhood: null, id: 2 }),
    ]);
    expect(map.has("prop-1")).toBe(false);
  });

  it("prefers the latest observed_at, breaking exact ties by row id", () => {
    const map = selectAssessorNeighborhoods([
      obs({ neighborhood: "BUCKMAN", observedAt: "2026-01-01T00:00:00Z", id: 1 }),
      obs({ neighborhood: "KERNS", observedAt: "2026-06-01T00:00:00Z", id: 2 }),
      obs({ neighborhood: "RICHMOND", observedAt: "2026-06-01T00:00:00Z", id: 3 }),
    ]);
    expect(map.get("prop-1")).toBe("RICHMOND");
  });

  it("tracks each property independently and trims values", () => {
    const map = selectAssessorNeighborhoods([
      obs({ propertyId: "a", neighborhood: " HILLSDALE " }),
      obs({ propertyId: "b", neighborhood: "WOODSTOCK" }),
    ]);
    expect(map.get("a")).toBe("HILLSDALE");
    expect(map.get("b")).toBe("WOODSTOCK");
  });
});

describe("matchZhviRow", () => {
  const rows = [
    zhvi({ regionId: "r-hillsdale", name: "Hillsdale" }),
    zhvi({ regionId: "r-mt-tabor", name: "Mount Tabor" }),
    zhvi({ regionId: "r-mount-scott", name: "Mount Scott" }),
    zhvi({ regionId: "r-nw", name: "Northwest" }),
    zhvi({ regionId: "r-ctlh", name: "Corbett-Terwilliger-Lair Hill" }),
    zhvi({ regionId: "r-king", name: "King" }),
    zhvi({ regionId: "r-ardenwald", name: "Ardenwald" }),
    zhvi({ regionId: "r-sullivans", name: "Sullivan's Gulch" }),
  ];

  it("matches exact names case-insensitively", () => {
    expect(matchZhviRow("HILLSDALE", rows)?.regionId).toBe("r-hillsdale");
    expect(matchZhviRow("Sullivan\u2019s Gulch".toUpperCase(), rows)?.regionId).toBe("r-sullivans");
  });

  it("maps documented assessor spellings through explicit aliases", () => {
    expect(matchZhviRow("MT. TABOR", rows)?.regionId).toBe("r-mt-tabor");
    expect(matchZhviRow("MT. SCOTT-ARLETA", rows)?.regionId).toBe("r-mount-scott");
    expect(matchZhviRow("NORTHWEST DISTRICT", rows)?.regionId).toBe("r-nw");
    expect(matchZhviRow("SOUTH PORTLAND", rows)?.regionId).toBe("r-ctlh");
    expect(matchZhviRow("ARDENWALD-JOHNSON CREEK", rows)?.regionId).toBe("r-ardenwald");
    expect(matchZhviRow("HIGHLAND", rows)?.regionId).toBe("r-king");
  });

  it("returns null for unmatched and ambiguous combined districts (never guesses)", () => {
    expect(matchZhviRow("SOUTHGATE", rows)).toBeNull();
    expect(matchZhviRow("GOOSE HOLLOW/SOUTHWEST HILLS", rows)).toBeNull();
    expect(matchZhviRow("SABIN/IRVINGTON", rows)).toBeNull();
  });
});

describe("joinNeighborhoodMarket", () => {
  it("attaches the matched region's latest value and YoY percentage", () => {
    const assessor = new Map([
      ["prop-1", "HILLSDALE"],
      ["prop-2", "MT. TABOR"],
      ["prop-3", "SOUTHGATE"],
    ]);
    const rows = [
      zhvi({ regionId: "r-hillsdale", name: "Hillsdale", latestValue: 650_000, yearChangePct: 4.2 }),
      zhvi({ regionId: "r-mt-tabor", name: "Mount Tabor", latestValue: 720_000, yearChangePct: null }),
    ];

    const joined = joinNeighborhoodMarket(assessor, rows);

    expect(joined.get("prop-1")).toEqual({
      regionId: "r-hillsdale",
      regionName: "Hillsdale",
      latestMonth: "2026-05",
      latestValue: 650_000,
      yearChangePct: 4.2,
    });
    expect(joined.get("prop-2")?.regionName).toBe("Mount Tabor");
    expect(joined.get("prop-2")?.yearChangePct).toBeNull();
    // Unmatched assessor district: absent, never guessed.
    expect(joined.has("prop-3")).toBe(false);
  });

  it("produces the same YoY math as the Market view's buildNeighborhoodRows", () => {
    // 13 months of points, exactly like fetchNeighborhoodZhviPoints returns.
    const points = [
      { regionId: "r-1", name: "Hillsdale", month: "2025-05", value: 600_000 },
      { regionId: "r-1", name: "Hillsdale", month: "2026-04", value: 645_000 },
      { regionId: "r-1", name: "Hillsdale", month: "2026-05", value: 660_000 },
    ];
    const rows = buildNeighborhoodRows(points);
    const joined = joinNeighborhoodMarket(new Map([["prop-1", "HILLSDALE"]]), rows);

    const market = joined.get("prop-1")!;
    expect(market.latestMonth).toBe("2026-05");
    expect(market.latestValue).toBe(660_000);
    // Exact-12-months-ago comparison: (660000 - 600000) / 600000 * 100.
    expect(market.yearChangePct).toBeCloseTo(10.0, 5);
    // And it is identical to what the Market tab renders for that region.
    expect(market.yearChangePct).toBe(rows[0].yearChangePct);
  });

  it("leaves YoY null when the exact year-ago month is missing", () => {
    const points = [
      { regionId: "r-1", name: "Hillsdale", month: "2025-06", value: 610_000 },
      { regionId: "r-1", name: "Hillsdale", month: "2026-05", value: 660_000 },
    ];
    const joined = joinNeighborhoodMarket(
      new Map([["prop-1", "HILLSDALE"]]),
      buildNeighborhoodRows(points),
    );
    expect(joined.get("prop-1")?.yearChangePct).toBeNull();
  });
});
