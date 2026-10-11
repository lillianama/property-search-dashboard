import { describe, expect, it } from "vitest";
import {
  buildNeighborhoodRows,
  buildPreferenceMatchNote,
  classifyStaleness,
  latestPoint,
  monthKey,
  monthOneYearBefore,
  preferenceCriteriaFromEnv,
} from "./market";

describe("monthKey", () => {
  it("converts month-end dates to YYYY-MM", () => {
    expect(monthKey("2026-05-31")).toBe("2026-05");
  });

  it("passes through malformed input unchanged", () => {
    expect(monthKey("not-a-date")).toBe("not-a-date");
  });
});

describe("classifyStaleness", () => {
  const now = new Date("2026-07-18T00:00:00Z");

  it("is missing when there is no period", () => {
    expect(classifyStaleness(null, now)).toBe("missing");
    expect(classifyStaleness(undefined, now)).toBe("missing");
    expect(classifyStaleness("garbage", now)).toBe("missing");
  });

  it("is fresh within the publication-lag window", () => {
    expect(classifyStaleness("2026-05-31", now)).toBe("fresh");
    expect(classifyStaleness("2026-06-30", now)).toBe("fresh");
  });

  it("is stale after more than two missed monthly cycles", () => {
    expect(classifyStaleness("2026-03-31", now)).toBe("stale");
    expect(classifyStaleness("2025-01-31", now)).toBe("stale");
  });
});

describe("latestPoint", () => {
  it("returns the last point of a sorted series", () => {
    expect(
      latestPoint([
        { month: "2026-01", value: 1 },
        { month: "2026-02", value: 2 },
      ]),
    ).toEqual({ month: "2026-02", value: 2 });
  });

  it("returns null for an empty series", () => {
    expect(latestPoint([])).toBeNull();
  });
});

describe("monthOneYearBefore", () => {
  it("subtracts exactly one year", () => {
    expect(monthOneYearBefore("2026-05")).toBe("2025-05");
  });

  it("returns null for malformed input", () => {
    expect(monthOneYearBefore("2026-5")).toBeNull();
    expect(monthOneYearBefore("")).toBeNull();
  });
});

describe("buildNeighborhoodRows", () => {
  it("keeps the latest value and computes year-over-year change", () => {
    const rows = buildNeighborhoodRows([
      { regionId: "1", name: "Concordia", month: "2025-05", value: 500_000 },
      { regionId: "1", name: "Concordia", month: "2026-05", value: 550_000 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].latestMonth).toBe("2026-05");
    expect(rows[0].latestValue).toBe(550_000);
    expect(rows[0].yearAgoValue).toBe(500_000);
    expect(rows[0].yearChangePct).toBeCloseTo(10);
  });

  it("leaves year change null when the year-ago month is absent", () => {
    const rows = buildNeighborhoodRows([
      { regionId: "1", name: "Woodlawn", month: "2026-05", value: 480_000 },
      { regionId: "1", name: "Woodlawn", month: "2026-04", value: 478_000 },
    ]);
    expect(rows[0].yearAgoValue).toBeNull();
    expect(rows[0].yearChangePct).toBeNull();
  });

  it("sorts by latest value descending", () => {
    const rows = buildNeighborhoodRows([
      { regionId: "1", name: "Cheap", month: "2026-05", value: 300_000 },
      { regionId: "2", name: "Pricey", month: "2026-05", value: 900_000 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Pricey", "Cheap"]);
  });

  it("ignores non-finite values and empty input", () => {
    expect(buildNeighborhoodRows([])).toEqual([]);
    expect(
      buildNeighborhoodRows([{ regionId: "1", name: "X", month: "2026-05", value: NaN }]),
    ).toEqual([]);
  });
});

describe("buildPreferenceMatchNote", () => {
  it("includes counts, criteria, and the limited-coverage disclosure", () => {
    const note = buildPreferenceMatchNote(12, 87, {
      maxPrice: 480_000,
      minYearBuilt: 1900,
      maxYearBuilt: 1965,
    });
    expect(note).toContain("12 of the 87 houses");
    expect(note).toContain("$480k");
    expect(note).toContain("1900\u20131965");
    expect(note).toContain("Limited coverage");
    expect(note).toContain("not Portland's full inventory");
  });
});

describe("preferenceCriteriaFromEnv", () => {
  it("uses documented defaults when unset", () => {
    expect(preferenceCriteriaFromEnv({})).toEqual({
      maxPrice: 480_000,
      minYearBuilt: 1900,
      maxYearBuilt: 1965,
    });
  });

  it("reads overrides from the environment", () => {
    expect(
      preferenceCriteriaFromEnv({
        MARKET_PREF_MAX_PRICE: "550000",
        MARKET_PREF_MIN_YEAR_BUILT: "1910",
        MARKET_PREF_MAX_YEAR_BUILT: "1970",
      }),
    ).toEqual({ maxPrice: 550_000, minYearBuilt: 1910, maxYearBuilt: 1970 });
  });

  it("falls back to defaults on malformed values", () => {
    expect(preferenceCriteriaFromEnv({ MARKET_PREF_MAX_PRICE: "lots" }).maxPrice).toBe(480_000);
    expect(preferenceCriteriaFromEnv({ MARKET_PREF_MAX_PRICE: "-5" }).maxPrice).toBe(480_000);
  });
});
