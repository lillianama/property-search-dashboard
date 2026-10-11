import { describe, expect, it } from "vitest";
import { formatNumber, formatYear } from "./format";

describe("formatYear", () => {
  it("never applies grouping separators (the 1,925 bug)", () => {
    expect(formatYear(1925)).toBe("1925");
    expect(formatYear(2026)).toBe("2026");
    // The grouped formatter is exactly what the bug looked like:
    expect(formatNumber(1925)).toBe("1,925");
  });

  it("truncates fractional years defensively", () => {
    expect(formatYear(1925.7)).toBe("1925");
  });

  it("returns Unknown for missing or non-finite values", () => {
    expect(formatYear(null)).toBe("Unknown");
    expect(formatYear(undefined)).toBe("Unknown");
    expect(formatYear(Number.NaN)).toBe("Unknown");
    expect(formatYear(Number.POSITIVE_INFINITY)).toBe("Unknown");
  });
});
