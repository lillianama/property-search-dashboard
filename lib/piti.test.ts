import { describe, expect, it } from "vitest";
import {
  clampAssumptionValue,
  computeMonthlyPrincipalAndInterest,
  computePiti,
  DEFAULT_PITI_ASSUMPTIONS,
  parseStoredAssumptions,
  serializeAssumptions,
  type PitiAssumptions,
} from "./piti";

const assumptions = (overrides: Partial<PitiAssumptions> = {}): PitiAssumptions => ({
  ...DEFAULT_PITI_ASSUMPTIONS,
  ...overrides,
});

describe("computeMonthlyPrincipalAndInterest", () => {
  it("matches the standard fixed-rate amortization formula", () => {
    // $400k at 7.0% over 30 years is the canonical $2,661.21/mo case.
    expect(computeMonthlyPrincipalAndInterest(400000, 7, 30)!).toBeCloseTo(2661.21, 2);
    expect(computeMonthlyPrincipalAndInterest(400000, 7, 15)!).toBeCloseTo(3595.31, 2);
  });

  it("degrades to straight principal/months at 0% interest", () => {
    expect(computeMonthlyPrincipalAndInterest(400000, 0, 30)!).toBeCloseTo(400000 / 360, 6);
  });

  it("returns 0 for a zero loan and null for unusable inputs", () => {
    expect(computeMonthlyPrincipalAndInterest(0, 7, 30)).toBe(0);
    expect(computeMonthlyPrincipalAndInterest(-1, 7, 30)).toBeNull();
    expect(computeMonthlyPrincipalAndInterest(400000, -1, 30)).toBeNull();
    expect(computeMonthlyPrincipalAndInterest(400000, 7, 0)).toBeNull();
    expect(computeMonthlyPrincipalAndInterest(Number.NaN, 7, 30)).toBeNull();
  });
});

describe("computePiti", () => {
  it("returns null instead of fabricating an estimate without a usable price", () => {
    expect(computePiti({ price: null, actualAnnualTax: null }, assumptions())).toBeNull();
    expect(computePiti({ price: undefined, actualAnnualTax: null }, assumptions())).toBeNull();
    expect(computePiti({ price: 0, actualAnnualTax: null }, assumptions())).toBeNull();
    expect(computePiti({ price: -5, actualAnnualTax: null }, assumptions())).toBeNull();
    expect(computePiti({ price: Number.NaN, actualAnnualTax: null }, assumptions())).toBeNull();
  });

  it("mirrors the finance comparison: 5% down, 30-yr, 6.5% note rate, $1,200/yr insurance, 0.36% PMI", () => {
    // Default-style example on a $500,000 price with a $4,195 actual tax:
    //   down 5%           = $25,000; base loan = $475,000
    //   P&I  PMT(6.5%/12, 360, 475000)      = $3,002.20 → $3,002
    //   tax  4195 / 12                      = $349.58   → $350
    //   ins  1200 / 12                      = $100
    //   PMI  475000 × 0.36% / 12            = $142.50   → $143 (5% < 20% down)
    const piti = computePiti({ price: 500000, actualAnnualTax: 4195 }, assumptions())!;
    expect(piti.taxIncluded).toBe(true);
    expect(piti.downPaymentAmount).toBe(25000);
    expect(piti.loanAmount).toBe(475000);
    expect(piti.monthlyPrincipalAndInterest).toBe(3002);
    expect(piti.monthlyPropertyTax).toBe(350);
    expect(piti.monthlyInsurance).toBe(100);
    expect(piti.pmiApplied).toBe(true);
    expect(piti.monthlyPmi).toBe(143);
    expect(piti.monthlyTotal).toBe(3002 + 350 + 100 + 143);
  });

  it("uses the note rate directly in the PMT formula (never an APR)", () => {
    // The comparison's PMT uses the 6.5% NOTE rate: PMT(0.065/12, 360, L).
    expect(computeMonthlyPrincipalAndInterest(475000, 6.5, 30)!).toBeCloseTo(3002.32, 2);
  });

  it("NEVER estimates property tax: no actual tax means an incomplete result, not a rate-based guess", () => {
    const piti = computePiti({ price: 500000, actualAnnualTax: null }, assumptions())!;
    expect(piti.taxIncluded).toBe(false);
    expect(piti.monthlyPropertyTax).toBeNull();
    // The total is only the included components — no invented tax line.
    expect(piti.monthlyTotal).toBe(piti.monthlyPrincipalAndInterest + piti.monthlyInsurance + piti.monthlyPmi);
  });

  it("treats zero/negative/garbage recorded amounts as no actual tax", () => {
    for (const bad of [0, -10, Number.NaN]) {
      const piti = computePiti({ price: 500000, actualAnnualTax: bad }, assumptions())!;
      expect(piti.taxIncluded).toBe(false);
      expect(piti.monthlyPropertyTax).toBeNull();
    }
  });

  it("applies a labeled PMI estimate only below 20% down (base loan × 0.36%/yr ÷ 12)", () => {
    const below = computePiti(
      { price: 500000, actualAnnualTax: 4195 },
      assumptions({ downPaymentPct: 10 }),
    )!;
    expect(below.pmiApplied).toBe(true);
    expect(below.loanAmount).toBe(450000);
    expect(below.monthlyPmi).toBe(135); // 450000 × 0.36% / 12
    expect(below.monthlyPrincipalAndInterest).toBe(2844); // PMT(6.5%/12, 360, 450000)

    const at20 = computePiti({ price: 500000, actualAnnualTax: 4195 }, assumptions({ downPaymentPct: 20 }))!;
    expect(at20.pmiApplied).toBe(false);
    expect(at20.monthlyPmi).toBe(0);
  });

  it("includes PMI in an incomplete (no-tax) total without hiding the incompleteness", () => {
    const piti = computePiti(
      { price: 500000, actualAnnualTax: null },
      assumptions({ downPaymentPct: 10 }),
    )!;
    expect(piti.taxIncluded).toBe(false);
    expect(piti.monthlyTotal).toBe(
      piti.monthlyPrincipalAndInterest + piti.monthlyInsurance + piti.monthlyPmi,
    );
  });

  it("supports a flat monthly insurance amount", () => {
    const piti = computePiti(
      { price: 500000, actualAnnualTax: 4195 },
      assumptions({ insuranceMode: "monthlyAmount", insuranceMonthlyAmount: 180 }),
    )!;
    expect(piti.monthlyInsurance).toBe(180);
  });

  it("handles 0% interest and a 100% down payment", () => {
    const zeroRate = computePiti(
      { price: 360000, actualAnnualTax: 3600 },
      assumptions({ interestRatePct: 0 }),
    )!;
    expect(zeroRate.monthlyPrincipalAndInterest).toBe(950); // 342000 / 360 (5% down)

    const allCash = computePiti(
      { price: 500000, actualAnnualTax: 4195 },
      assumptions({ downPaymentPct: 100 }),
    )!;
    expect(allCash.loanAmount).toBe(0);
    expect(allCash.monthlyPrincipalAndInterest).toBe(0);
    expect(allCash.monthlyTotal).toBe(allCash.monthlyPropertyTax! + allCash.monthlyInsurance);
  });

  it("clamps out-of-bounds assumption values instead of producing nonsense", () => {
    const piti = computePiti(
      { price: 500000, actualAnnualTax: 4195 },
      assumptions({ downPaymentPct: 250 }),
    )!;
    expect(piti.downPaymentAmount).toBe(500000);
    expect(piti.loanAmount).toBe(0);
  });

  it("keeps the displayed math honest: total equals the sum of rounded components", () => {
    for (const price of [123456, 499999, 750001]) {
      const piti = computePiti({ price, actualAnnualTax: 3557 }, assumptions({ downPaymentPct: 15 }))!;
      expect(piti.monthlyTotal).toBe(
        piti.monthlyPrincipalAndInterest + piti.monthlyPropertyTax! + piti.monthlyInsurance + piti.monthlyPmi,
      );
      expect(Number.isInteger(piti.monthlyTotal)).toBe(true);
    }
  });
});

describe("clampAssumptionValue / parseStoredAssumptions", () => {
  it("clamps to the field bounds and falls back to the default for non-finite input", () => {
    expect(clampAssumptionValue("downPaymentPct", 150)).toBe(100);
    expect(clampAssumptionValue("downPaymentPct", -5)).toBe(0);
    expect(clampAssumptionValue("termYears", 0)).toBe(1);
    expect(clampAssumptionValue("interestRatePct", Number.NaN)).toBe(6.5);
  });

  it("returns defaults for missing, corrupt, or non-object storage payloads", () => {
    expect(parseStoredAssumptions(null)).toEqual(DEFAULT_PITI_ASSUMPTIONS);
    expect(parseStoredAssumptions("not json {")).toEqual(DEFAULT_PITI_ASSUMPTIONS);
    expect(parseStoredAssumptions("[1,2]")).toEqual(DEFAULT_PITI_ASSUMPTIONS);
    expect(parseStoredAssumptions('"hi"')).toEqual(DEFAULT_PITI_ASSUMPTIONS);
  });

  it("merges valid fields, clamps out-of-bounds ones, and ignores garbage per-field", () => {
    const parsed = parseStoredAssumptions(
      JSON.stringify({
        downPaymentPct: 10,
        interestRatePct: 99, // clamped to 25
        termYears: "thirty", // ignored
        insuranceMode: "monthlyAmount",
        insuranceMonthlyAmount: 175,
        extraneous: true,
      }),
    );
    expect(parsed.downPaymentPct).toBe(10);
    expect(parsed.interestRatePct).toBe(25);
    expect(parsed.termYears).toBe(DEFAULT_PITI_ASSUMPTIONS.termYears);
    expect(parsed.insuranceMode).toBe("monthlyAmount");
    expect(parsed.insuranceMonthlyAmount).toBe(175);
    expect((parsed as unknown as Record<string, unknown>).extraneous).toBeUndefined();
  });

  it("drops the removed propertyTaxRatePct from older stored payloads", () => {
    const parsed = parseStoredAssumptions('{"propertyTaxRatePct": 1.1, "downPaymentPct": 25}');
    expect(parsed.downPaymentPct).toBe(25);
    expect((parsed as unknown as Record<string, unknown>).propertyTaxRatePct).toBeUndefined();
  });

  it("ignores an unrecognized insuranceMode", () => {
    expect(parseStoredAssumptions('{"insuranceMode":"weird"}').insuranceMode).toBe(
      DEFAULT_PITI_ASSUMPTIONS.insuranceMode,
    );
  });
});

describe("stored-assumption versioning (v1 → v2 comparison migration)", () => {
  it("upgrades untouched legacy defaults (20%/7%/0.6% PMI) to the comparison defaults", () => {
    // A v1 payload the user never edited: every value is the old default.
    const legacy = JSON.stringify({
      downPaymentPct: 20,
      interestRatePct: 7,
      termYears: 30,
      insuranceMode: "annualRatePct",
      insuranceAnnualRatePct: 0.35,
      insuranceMonthlyAmount: 150,
      pmiAnnualRatePct: 0.6,
    });
    const parsed = parseStoredAssumptions(legacy);
    expect(parsed.downPaymentPct).toBe(5);
    expect(parsed.interestRatePct).toBe(6.5);
    expect(parsed.pmiAnnualRatePct).toBe(0.36);
    expect(parsed.insuranceMode).toBe("annualAmount");
    expect(parsed.insuranceAnnualAmount).toBe(1200);
  });

  it("preserves genuinely customized legacy values while upgrading the untouched ones", () => {
    const legacy = JSON.stringify({
      downPaymentPct: 12, // customized: kept
      interestRatePct: 7, // untouched legacy default: upgraded
      termYears: 15, // customized: kept
      insuranceMode: "monthlyAmount", // customized: kept
      insuranceMonthlyAmount: 175, // customized: kept
      pmiAnnualRatePct: 0.6, // untouched legacy default: upgraded
    });
    const parsed = parseStoredAssumptions(legacy);
    expect(parsed.downPaymentPct).toBe(12);
    expect(parsed.interestRatePct).toBe(6.5);
    expect(parsed.termYears).toBe(15);
    expect(parsed.insuranceMode).toBe("monthlyAmount");
    expect(parsed.insuranceMonthlyAmount).toBe(175);
    expect(parsed.pmiAnnualRatePct).toBe(0.36);
  });

  it("never migrates values in a v2 payload, even ones equal to old defaults", () => {
    const v2 = JSON.stringify({ version: 2, downPaymentPct: 20, interestRatePct: 7 });
    const parsed = parseStoredAssumptions(v2);
    // In v2, 20%/7% are deliberate user choices and must survive.
    expect(parsed.downPaymentPct).toBe(20);
    expect(parsed.interestRatePct).toBe(7);
  });

  it("round-trips through serializeAssumptions without re-migrating", () => {
    const custom = { ...DEFAULT_PITI_ASSUMPTIONS, downPaymentPct: 20, interestRatePct: 7 };
    expect(parseStoredAssumptions(serializeAssumptions(custom))).toEqual(custom);
  });
});
