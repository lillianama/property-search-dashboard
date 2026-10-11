import { describe, expect, it } from "vitest";
import { parseHouseFilters } from "./filters";

function params(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return { get: (name: string) => map.get(name) ?? null };
}

describe("parseHouseFilters", () => {
  it("returns all-null filters for empty input", () => {
    expect(parseHouseFilters(params({}))).toEqual({
      statuses: null,
      maxPrice: null,
      minBedrooms: null,
      maxYearBuilt: null,
      dateFrom: null,
      dateTo: null,
    });
  });

  it("parses a comma-separated status list, trimming and deduping", () => {
    const result = parseHouseFilters(params({ status: "Active, Pending,Active" }));
    expect(result.statuses).toEqual(["Active", "Pending"]);
  });

  it("parses positive numeric filters", () => {
    const result = parseHouseFilters(params({ maxPrice: "500000", minBedrooms: "3" }));
    expect(result.maxPrice).toBe(500_000);
    expect(result.minBedrooms).toBe(3);
  });

  it("drops negative or non-numeric numeric filters instead of throwing", () => {
    const result = parseHouseFilters(params({ maxPrice: "-1", minBedrooms: "not-a-number" }));
    expect(result.maxPrice).toBeNull();
    expect(result.minBedrooms).toBeNull();
  });

  it("rejects implausible years", () => {
    expect(parseHouseFilters(params({ maxYearBuilt: "1200" })).maxYearBuilt).toBeNull();
    expect(parseHouseFilters(params({ maxYearBuilt: "3000" })).maxYearBuilt).toBeNull();
    expect(parseHouseFilters(params({ maxYearBuilt: "1998" })).maxYearBuilt).toBe(1998);
  });

  it("rejects malformed dates instead of throwing", () => {
    expect(parseHouseFilters(params({ dateFrom: "not-a-date" })).dateFrom).toBeNull();
    expect(parseHouseFilters(params({ dateFrom: "2026-13-40" })).dateFrom).toBeNull();
  });

  it("accepts a valid ISO date range", () => {
    const result = parseHouseFilters(params({ dateFrom: "2025-01-01", dateTo: "2026-01-01" }));
    expect(result.dateFrom).toBe("2025-01-01");
    expect(result.dateTo).toBe("2026-01-01");
  });

  it("swaps an inverted date range rather than silently dropping it", () => {
    const result = parseHouseFilters(params({ dateFrom: "2026-01-01", dateTo: "2025-01-01" }));
    expect(result.dateFrom).toBe("2025-01-01");
    expect(result.dateTo).toBe("2026-01-01");
  });
});
