// Pure, dependency-free monthly-PITI estimation (principal, interest,
// property taxes, homeowners insurance, and an optional PMI estimate).
//
// Everything here is an ESTIMATE for comparison between houses — never a
// quote, rate lock, or guaranteed payment, and the UI must say so. HOA dues
// are always excluded (the store has no HOA facts) and that exclusion is
// stated on every card.
//
// Property taxes are NEVER estimated: no flat percentage of price, no
// editable tax-rate fallback. Either the property store holds an actual
// recorded annual tax amount for the house (see lib/tax.ts for exactly
// where those come from and how the best one is chosen), or the result is
// explicitly INCOMPLETE — the card shows P&I + insurance and says
// "property tax unavailable" instead of displaying a misleading total.
// Insurance is always an editable assumption and always labeled estimated.
// PMI is zero at 20%+ down; below 20% an editable PMI estimate is applied
// and labeled — the total is never silently understated.

// ── Assumptions ──────────────────────────────────────────────────────────────
//
// Default comparison assumptions:
//   5% down (95% LTV) · 30-year fixed · 6.5% MORTGAGE NOTE RATE for P&I
//   (this is the note rate, NOT APR — the comparison's APR is a separate
//   disclosure figure and is never used for the monthly payment) ·
//   $1,200/year homeowners insurance · PMI = base loan × 0.36% / yr ÷ 12.
// Every assumption stays editable; taxes remain the actual recorded amount.

export type InsuranceMode = "annualAmount" | "annualRatePct" | "monthlyAmount";

export interface PitiAssumptions {
  /** Down payment as a percent of price (0–100). */
  downPaymentPct: number;
  /** Annual mortgage NOTE RATE in percent, fixed for the whole term. Used
   * directly in the PMT formula. Never an APR. */
  interestRatePct: number;
  /** Loan term in years. */
  termYears: number;
  /** Whether insurance is a flat annual $, an annual percent of price, or
   * a flat monthly $. */
  insuranceMode: InsuranceMode;
  insuranceAnnualAmount: number;
  insuranceAnnualRatePct: number;
  insuranceMonthlyAmount: number;
  /** Estimated PMI as an annual percent of the BASE loan amount; applied
   * only when downPaymentPct < 20. Default: 0.36%. */
  pmiAnnualRatePct: number;
}

export const DEFAULT_PITI_ASSUMPTIONS: PitiAssumptions = {
  downPaymentPct: 5,
  interestRatePct: 6.5,
  termYears: 30,
  insuranceMode: "annualAmount",
  insuranceAnnualAmount: 1200,
  insuranceAnnualRatePct: 0.35,
  insuranceMonthlyAmount: 100,
  pmiAnnualRatePct: 0.36,
};

type NumericAssumptionField = Exclude<keyof PitiAssumptions, "insuranceMode">;

/** Sane hard bounds for every editable numeric assumption. Inputs outside a
 * bound are clamped to it, never rejected into a broken state. */
export const PITI_FIELD_BOUNDS: Record<NumericAssumptionField, { min: number; max: number }> = {
  downPaymentPct: { min: 0, max: 100 },
  interestRatePct: { min: 0, max: 25 },
  termYears: { min: 1, max: 50 },
  insuranceAnnualAmount: { min: 0, max: 120000 },
  insuranceAnnualRatePct: { min: 0, max: 5 },
  insuranceMonthlyAmount: { min: 0, max: 10000 },
  pmiAnnualRatePct: { min: 0, max: 5 },
};

export function clampAssumptionValue(field: NumericAssumptionField, value: number): number {
  const { min, max } = PITI_FIELD_BOUNDS[field];
  if (!Number.isFinite(value)) return DEFAULT_PITI_ASSUMPTIONS[field];
  return Math.min(max, Math.max(min, value));
}

function isInsuranceMode(value: unknown): value is InsuranceMode {
  return value === "annualAmount" || value === "annualRatePct" || value === "monthlyAmount";
}

// ── Stored-assumption versioning ─────────────────────────────────────────────
//
// v1 payloads (the pre-comparison era) had defaults 20% down / 7.0% and no
// version marker. When migrating a v1 payload, any field still sitting at
// its OLD default is updated to the new comparison default — the user never
// touched it, so it should track the current methodology — while any value
// that differs from the old default was genuinely customized and is kept
// verbatim. v2 payloads carry version: 2 and are read field-by-field.

export const PITI_SETTINGS_VERSION = 2;

/** The v1 defaults, kept only so migration can tell "untouched" from
 * "customized". Never used for new estimates. */
const LEGACY_V1_DEFAULTS = {
  downPaymentPct: 20,
  interestRatePct: 7.0,
  termYears: 30,
  insuranceMode: "annualRatePct" as InsuranceMode,
  insuranceAnnualRatePct: 0.35,
  insuranceMonthlyAmount: 150,
  pmiAnnualRatePct: 0.6,
};

/** Serializes assumptions for localStorage with the version marker. */
export function serializeAssumptions(assumptions: PitiAssumptions): string {
  return JSON.stringify({ version: PITI_SETTINGS_VERSION, ...assumptions });
}

/**
 * Parses persisted assumptions (localStorage JSON) into a fully valid
 * PitiAssumptions, falling back to defaults field-by-field for anything
 * missing, non-numeric, or out of bounds. Unknown fields (including the
 * removed propertyTaxRatePct from older stored payloads) are dropped.
 *
 * Versionless (v1) payloads are migrated: fields still at their old v1
 * default move to the new comparison default; fields the user customized
 * keep their customized value exactly. Never throws.
 */
export function parseStoredAssumptions(raw: string | null | undefined): PitiAssumptions {
  const result: PitiAssumptions = { ...DEFAULT_PITI_ASSUMPTIONS };
  if (!raw) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
  const record = parsed as Record<string, unknown>;

  const isLegacy = record.version !== PITI_SETTINGS_VERSION;

  for (const field of Object.keys(PITI_FIELD_BOUNDS) as NumericAssumptionField[]) {
    const value = record[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (isLegacy && field in LEGACY_V1_DEFAULTS && value === LEGACY_V1_DEFAULTS[field as keyof typeof LEGACY_V1_DEFAULTS]) {
      // Untouched legacy default: adopt the new comparison default instead.
      continue;
    }
    result[field] = clampAssumptionValue(field, value);
  }

  if (isInsuranceMode(record.insuranceMode)) {
    if (!(isLegacy && record.insuranceMode === LEGACY_V1_DEFAULTS.insuranceMode)) {
      result.insuranceMode = record.insuranceMode;
    }
  }
  return result;
}

// ── Calculation ──────────────────────────────────────────────────────────────

/**
 * Standard fixed-rate amortized monthly principal-and-interest payment.
 * A zero interest rate degrades to straight principal/months. Returns null
 * for unusable inputs (non-finite, negative loan, term < 1 month).
 */
export function computeMonthlyPrincipalAndInterest(
  loanAmount: number,
  interestRatePct: number,
  termYears: number,
): number | null {
  if (!Number.isFinite(loanAmount) || !Number.isFinite(interestRatePct) || !Number.isFinite(termYears)) {
    return null;
  }
  if (loanAmount < 0 || interestRatePct < 0) return null;
  const months = Math.round(termYears * 12);
  if (months < 1) return null;
  if (loanAmount === 0) return 0;

  const monthlyRate = interestRatePct / 100 / 12;
  if (monthlyRate === 0) return loanAmount / months;
  return (loanAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
}

export interface PitiBreakdown {
  /** True only when an actual recorded annual property tax was included.
   * False means the total below is P&I + insurance (+ PMI) ONLY and the UI
   * must label the PITI as incomplete / property tax unavailable. */
  taxIncluded: boolean;
  /** Sum of the rounded INCLUDED components, so the displayed math adds up.
   * When taxIncluded is false this is not a full PITI and must never be
   * presented as one. */
  monthlyTotal: number;
  monthlyPrincipalAndInterest: number;
  /** Monthly share of the actual recorded annual tax, or null when the
   * store holds no actual tax amount for this house. Never estimated. */
  monthlyPropertyTax: number | null;
  monthlyInsurance: number;
  /** 0 whenever downPaymentPct >= 20. */
  monthlyPmi: number;
  loanAmount: number;
  downPaymentAmount: number;
  pmiApplied: boolean;
}

export interface PitiInput {
  price: number | null | undefined;
  /** ACTUAL recorded annual property tax from the store, or null when none
   * is recorded. There is deliberately no way to pass an estimate here. */
  actualAnnualTax: number | null | undefined;
}

const round = (n: number) => Math.round(n);

/**
 * Monthly PITI estimate for one house. Returns null when the price is
 * missing/zero/negative — an estimate from no price would be fabrication.
 * Every component is rounded to whole dollars and the total is the sum of
 * the rounded included components. Houses without an actual recorded annual
 * tax get taxIncluded=false and monthlyPropertyTax=null; the tax is never
 * approximated from the price.
 */
export function computePiti(input: PitiInput, assumptions: PitiAssumptions): PitiBreakdown | null {
  const price = input.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;

  const downPaymentPct = clampAssumptionValue("downPaymentPct", assumptions.downPaymentPct);
  const downPaymentAmount = (price * downPaymentPct) / 100;
  const loanAmount = price - downPaymentAmount;

  const principalAndInterest = computeMonthlyPrincipalAndInterest(
    loanAmount,
    clampAssumptionValue("interestRatePct", assumptions.interestRatePct),
    clampAssumptionValue("termYears", assumptions.termYears),
  );
  if (principalAndInterest === null) return null;

  const actualTax =
    typeof input.actualAnnualTax === "number" &&
    Number.isFinite(input.actualAnnualTax) &&
    input.actualAnnualTax > 0
      ? input.actualAnnualTax
      : null;

  const monthlyInsurance =
    assumptions.insuranceMode === "monthlyAmount"
      ? clampAssumptionValue("insuranceMonthlyAmount", assumptions.insuranceMonthlyAmount)
      : assumptions.insuranceMode === "annualAmount"
        ? clampAssumptionValue("insuranceAnnualAmount", assumptions.insuranceAnnualAmount) / 12
        : (price * clampAssumptionValue("insuranceAnnualRatePct", assumptions.insuranceAnnualRatePct)) / 100 / 12;

  const pmiApplied = downPaymentPct < 20;
  const monthlyPmi = pmiApplied
    ? (loanAmount * clampAssumptionValue("pmiAnnualRatePct", assumptions.pmiAnnualRatePct)) / 100 / 12
    : 0;

  const roundedPi = round(principalAndInterest);
  const roundedTax = actualTax !== null ? round(actualTax / 12) : null;
  const roundedInsurance = round(monthlyInsurance);
  const roundedPmi = round(monthlyPmi);

  return {
    taxIncluded: roundedTax !== null,
    monthlyTotal: roundedPi + (roundedTax ?? 0) + roundedInsurance + roundedPmi,
    monthlyPrincipalAndInterest: roundedPi,
    monthlyPropertyTax: roundedTax,
    monthlyInsurance: roundedInsurance,
    monthlyPmi: roundedPmi,
    loanAmount: round(loanAmount),
    downPaymentAmount: round(downPaymentAmount),
    pmiApplied,
  };
}
