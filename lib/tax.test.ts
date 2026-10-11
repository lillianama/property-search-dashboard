import { describe, expect, it } from "vitest";
import {
  normalizeTaxRow,
  parseTaxAmount,
  selectActualAnnualTaxes,
  taxSourceRank,
  type RawTaxSourceRow,
} from "./tax";

const row = (overrides: Partial<RawTaxSourceRow>): RawTaxSourceRow => ({
  propertyId: "prop-1",
  kind: "annual-amount",
  value: 4195,
  source: "zillow",
  observedAt: "2026-07-17T00:00:00Z",
  confidence: 0.8,
  ...overrides,
});

describe("parseTaxAmount", () => {
  it("accepts plain numbers and formatted currency strings", () => {
    expect(parseTaxAmount(4195)).toBe(4195);
    expect(parseTaxAmount("2,281.99")).toBeCloseTo(2281.99, 2);
    expect(parseTaxAmount("$4,305.00")).toBe(4305);
    expect(parseTaxAmount("5764.85")).toBeCloseTo(5764.85, 2);
  });

  it("rejects zero, negatives, garbage, and non-scalar values", () => {
    expect(parseTaxAmount(0)).toBeNull();
    expect(parseTaxAmount("0.00")).toBeNull();
    expect(parseTaxAmount(-50)).toBeNull();
    expect(parseTaxAmount("not a number")).toBeNull();
    expect(parseTaxAmount("")).toBeNull();
    expect(parseTaxAmount(null)).toBeNull();
    expect(parseTaxAmount({ total: 4195 })).toBeNull();
    expect(parseTaxAmount(Number.NaN)).toBeNull();
  });
});

describe("normalizeTaxRow", () => {
  it("yields one candidate for a usable annual amount", () => {
    const candidates = normalizeTaxRow(row({ value: "2,281.99", source: "rmls" }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].amount).toBeCloseTo(2281.99, 2);
    expect(candidates[0].taxYear).toBeNull();
  });

  it("expands a RentCast by-year bill object into one candidate per year", () => {
    const candidates = normalizeTaxRow(
      row({
        kind: "by-year",
        source: "rentcast-property",
        value: {
          "2020": { year: 2020, total: 2487 },
          "2024": { year: 2024, total: 2931 },
          bogus: { year: "??", total: "no" },
        },
      }),
    );
    expect(candidates.map((c) => [c.taxYear, c.amount])).toEqual([
      [2020, 2487],
      [2024, 2931],
    ]);
  });

  it("falls back to the object key when the entry's year field is unusable", () => {
    const candidates = normalizeTaxRow(
      row({ kind: "by-year", value: { "2023": { total: 2818 } } }),
    );
    expect(candidates[0].taxYear).toBe(2023);
  });

  it("returns nothing for unusable values", () => {
    expect(normalizeTaxRow(row({ value: "0.00" }))).toEqual([]);
    expect(normalizeTaxRow(row({ kind: "by-year", value: null }))).toEqual([]);
    expect(normalizeTaxRow(row({ kind: "by-year", value: [1, 2] }))).toEqual([]);
    expect(normalizeTaxRow(row({ kind: "by-year", value: "4195" }))).toEqual([]);
  });
});

describe("taxSourceRank", () => {
  it("ranks assessor above RMLS above Zillow above RentCast above unknown", () => {
    expect(taxSourceRank("portlandmaps-assessor")).toBeLessThan(taxSourceRank("rmls"));
    expect(taxSourceRank("rmls")).toBeLessThan(taxSourceRank("zillow"));
    expect(taxSourceRank("zillow")).toBeLessThan(taxSourceRank("rentcast-property"));
    expect(taxSourceRank("rentcast-property")).toBeLessThan(taxSourceRank("workspace-state"));
    expect(taxSourceRank(null)).toBe(taxSourceRank("workspace-state"));
  });
});

describe("selectActualAnnualTaxes", () => {
  it("prefers the latest tax year over an older bill regardless of source", () => {
    const taxes = selectActualAnnualTaxes([
      row({
        kind: "by-year",
        source: "rentcast-property",
        value: { "2023": { year: 2023, total: 2818 }, "2024": { year: 2024, total: 2931 } },
      }),
      // Older explicit year from a "better" source must not beat a newer bill.
      row({
        kind: "by-year",
        source: "portlandmaps-assessor",
        value: { "2022": { year: 2022, total: 2757 } },
      }),
    ]);
    expect(taxes.get("prop-1")).toEqual({
      amount: 2931,
      taxYear: 2024,
      asOf: "2026-07-17T00:00:00Z",
      source: "rentcast-property",
    });
  });

  it("dates a year-less amount by its observation year and prefers the more trusted source within the same year", () => {
    const taxes = selectActualAnnualTaxes([
      // Observed in 2026 → effective year 2026, beats a 2024 county bill.
      row({ value: "5,606.61", source: "rmls", observedAt: "2026-07-17T00:00:00Z", confidence: null }),
      row({
        kind: "by-year",
        source: "rentcast-property",
        value: { "2024": { year: 2024, total: 5100 } },
      }),
      // Same effective year (2026) but a less trusted source class.
      row({ value: 5900, source: "workspace-state", observedAt: "2026-07-18T00:00:00Z", confidence: null }),
    ]);
    const selected = taxes.get("prop-1")!;
    expect(selected.amount).toBeCloseTo(5606.61, 2);
    expect(selected.source).toBe("rmls");
    expect(selected.taxYear).toBeNull();
    expect(selected.asOf).toBe("2026-07-17T00:00:00Z");
  });

  it("returns NO entry when nothing usable is recorded — never an estimate", () => {
    const taxes = selectActualAnnualTaxes([
      row({ value: "0.00" }),
      row({ value: null }),
      row({ kind: "by-year", value: {} }),
    ]);
    expect(taxes.has("prop-1")).toBe(false);
    expect(taxes.size).toBe(0);
  });

  it("keys results by property", () => {
    const taxes = selectActualAnnualTaxes([
      row({ propertyId: "a", value: 1000 }),
      row({ propertyId: "b", value: 2000 }),
    ]);
    expect(taxes.get("a")?.amount).toBe(1000);
    expect(taxes.get("b")?.amount).toBe(2000);
  });

  it("breaks exact ties deterministically (higher confidence, then newer observation)", () => {
    const taxes = selectActualAnnualTaxes([
      row({ value: 4000, source: "zillow", confidence: 0.5, observedAt: "2026-07-01T00:00:00Z" }),
      row({ value: 4200, source: "zillow", confidence: 0.8, observedAt: "2026-07-01T00:00:00Z" }),
    ]);
    expect(taxes.get("prop-1")?.amount).toBe(4200);

    const byRecency = selectActualAnnualTaxes([
      row({ value: 4000, source: "zillow", confidence: 0.8, observedAt: "2026-07-01T00:00:00Z" }),
      row({ value: 4200, source: "zillow", confidence: 0.8, observedAt: "2026-07-10T00:00:00Z" }),
    ]);
    expect(byRecency.get("prop-1")?.amount).toBe(4200);
  });
});
