import { describe, expect, it } from "vitest";
import {
  buildMonthlyHistory,
  buildPriceDistribution,
  buildStatusDistribution,
  latestFreshness,
  median,
  normalizeDateAdded,
  normalizeStatus,
  safeNumber,
  summarizeStatusCounts,
} from "./aggregate";

describe("safeNumber", () => {
  it("passes through finite numbers", () => {
    expect(safeNumber(42)).toBe(42);
    expect(safeNumber(0)).toBe(0);
  });

  it("parses numeric strings", () => {
    expect(safeNumber("3")).toBe(3);
    expect(safeNumber("2.5")).toBe(2.5);
  });

  it("rejects non-numeric input without throwing", () => {
    expect(safeNumber("not-a-number")).toBeNull();
    expect(safeNumber(NaN)).toBeNull();
    expect(safeNumber(Infinity)).toBeNull();
    expect(safeNumber(null)).toBeNull();
    expect(safeNumber(undefined)).toBeNull();
    expect(safeNumber({})).toBeNull();
    expect(safeNumber([])).toBeNull();
  });
});

describe("normalizeStatus", () => {
  it("preserves known statuses", () => {
    expect(normalizeStatus("Active")).toBe("Active");
  });

  it("maps null/blank/whitespace to Unknown explicitly", () => {
    expect(normalizeStatus(null)).toBe("Unknown");
    expect(normalizeStatus(undefined)).toBe("Unknown");
    expect(normalizeStatus("")).toBe("Unknown");
    expect(normalizeStatus("   ")).toBe("Unknown");
  });
});

describe("median", () => {
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
  });

  it("ignores null/undefined/NaN entries", () => {
    expect(median([null, undefined, NaN, 10])).toBe(10);
  });

  it("computes median for odd-length arrays", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("computes median for even-length arrays", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is resistant to a single wild outlier skewing the whole set", () => {
    // Regression guard: a mis-recorded sale price (e.g. 12619761 instead of
    // ~450000) must not blow up the reported median.
    const prices = [449900, 460000, 419000, 12619761, 450000];
    expect(median(prices)).toBe(450000);
  });
});

describe("buildStatusDistribution", () => {
  it("counts and normalizes unknown/blank statuses", () => {
    const result = buildStatusDistribution(["Active", "Active", null, "", "Sold"]);
    expect(result).toEqual([
      { status: "Active", count: 2 },
      { status: "Unknown", count: 2 },
      { status: "Sold", count: 1 },
    ]);
  });

  it("returns an empty array for no input", () => {
    expect(buildStatusDistribution([])).toEqual([]);
  });
});

describe("buildPriceDistribution", () => {
  it("buckets prices into deterministic fixed $25k bins by default", () => {
    const result = buildPriceDistribution([410_000, 426_000, 449_999, 480_000]);
    // Observed span: 400k–500k → 4 bins of 25k.
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ rangeStart: 400_000, rangeEnd: 425_000, count: 1 });
    expect(result[1]).toMatchObject({ rangeStart: 425_000, rangeEnd: 450_000, count: 2 });
    expect(result[2]).toMatchObject({ rangeStart: 450_000, rangeEnd: 475_000, count: 0 });
    expect(result[3]).toMatchObject({ rangeStart: 475_000, rangeEnd: 500_000, count: 1 });
  });

  it("counts exact boundary values in the bin that STARTS there (half-open bins)", () => {
    const result = buildPriceDistribution([650_000, 649_999, 675_000]);
    expect(result[0]).toMatchObject({ rangeStart: 625_000, count: 1 }); // 649,999
    expect(result[1]).toMatchObject({ rangeStart: 650_000, count: 1 }); // 650,000 exactly
    expect(result[2]).toMatchObject({ rangeStart: 675_000, count: 1 }); // 675,000 exactly
  });

  it("spans only the observed price range — no giant empty tail from $0", () => {
    const result = buildPriceDistribution([800_000, 810_000]);
    expect(result[0].rangeStart).toBe(800_000);
    expect(result).toHaveLength(1);
  });

  it("keeps interior empty bins so sparse ranges render honestly", () => {
    const result = buildPriceDistribution([400_000, 500_000]);
    expect(result).toHaveLength(5); // 400–425, ..., 500–525
    expect(result.map((b) => b.count)).toEqual([1, 0, 0, 0, 1]);
  });

  it("formats compact $Nk labels", () => {
    const result = buildPriceDistribution([430_000]);
    expect(result[0].label).toBe("$425k\u2013$450k");
  });

  it("excludes null/negative/non-finite prices instead of guessing, but keeps zero", () => {
    const result = buildPriceDistribution([null, undefined, NaN, -5, 100_000]);
    const total = result.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(1);

    const withZero = buildPriceDistribution([0]);
    expect(withZero).toHaveLength(1);
    expect(withZero[0]).toMatchObject({ rangeStart: 0, rangeEnd: 25_000, count: 1 });
  });

  it("returns an empty array when there is no usable data", () => {
    expect(buildPriceDistribution([null, undefined])).toEqual([]);
    expect(buildPriceDistribution([400_000], 0)).toEqual([]);
  });

  it("is deterministic: same input, same bins", () => {
    const a = buildPriceDistribution([412_345, 555_555]);
    const b = buildPriceDistribution([412_345, 555_555]);
    expect(a).toEqual(b);
  });
});

describe("buildMonthlyHistory", () => {
  it("groups events by month with count and median price", () => {
    const result = buildMonthlyHistory([
      { month: "2026-01", price: 400_000 },
      { month: "2026-01", price: 420_000 },
      { month: "2026-02", price: 500_000 },
    ]);
    expect(result).toEqual([
      { month: "2026-01", eventCount: 2, medianPrice: 410_000 },
      { month: "2026-02", eventCount: 1, medianPrice: 500_000 },
    ]);
  });

  it("still counts events with a null price, without corrupting the median", () => {
    const result = buildMonthlyHistory([
      { month: "2026-03", price: null },
      { month: "2026-03", price: 300_000 },
    ]);
    expect(result[0]).toEqual({ month: "2026-03", eventCount: 2, medianPrice: 300_000 });
  });

  it("sorts months chronologically ascending", () => {
    const result = buildMonthlyHistory([
      { month: "2026-05", price: 1 },
      { month: "2024-01", price: 1 },
      { month: "2025-11", price: 1 },
    ]);
    expect(result.map((r) => r.month)).toEqual(["2024-01", "2025-11", "2026-05"]);
  });

  it("skips events without a month", () => {
    const result = buildMonthlyHistory([{ month: "", price: 1 }]);
    expect(result).toEqual([]);
  });
});

describe("latestFreshness", () => {
  it("returns the most recent ISO timestamp", () => {
    const result = latestFreshness([
      { lastSeenAt: "2026-01-01T00:00:00.000Z" },
      { lastSeenAt: "2026-06-15T00:00:00.000Z" },
      { lastSeenAt: null },
    ]);
    expect(result).toBe("2026-06-15T00:00:00.000Z");
  });

  it("returns null when nothing is parseable", () => {
    expect(latestFreshness([{ lastSeenAt: null }, { lastSeenAt: undefined }])).toBeNull();
    expect(latestFreshness([])).toBeNull();
  });
});

describe("normalizeDateAdded", () => {
  it("normalizes a Postgres-style first_seen_at timestamp to ISO", () => {
    expect(normalizeDateAdded("2026-07-17 01:05:09.38907+00")).toBe("2026-07-17T01:05:09.389Z");
    expect(normalizeDateAdded("2026-07-01T00:00:00.000Z")).toBe("2026-07-01T00:00:00.000Z");
  });

  it("accepts the Date objects node-postgres returns for timestamptz columns", () => {
    expect(normalizeDateAdded(new Date("2026-07-17T01:05:09.389Z"))).toBe("2026-07-17T01:05:09.389Z");
    expect(normalizeDateAdded(new Date("invalid"))).toBeNull();
  });

  it("returns null for missing, blank, or unparseable values instead of guessing", () => {
    expect(normalizeDateAdded(null)).toBeNull();
    expect(normalizeDateAdded(undefined)).toBeNull();
    expect(normalizeDateAdded("")).toBeNull();
    expect(normalizeDateAdded("   ")).toBeNull();
    expect(normalizeDateAdded("not a date")).toBeNull();
    expect(normalizeDateAdded(12345)).toBeNull();
  });
});

describe("summarizeStatusCounts", () => {
  it("tallies known statuses case-insensitively and buckets the rest as unknown", () => {
    const result = summarizeStatusCounts(["active", "Active", "PENDING", "Sold", "Weird", null]);
    expect(result).toEqual({ active: 2, pending: 1, inactive: 0, unverified: 0, sold: 1, unknown: 2 });
  });
});
