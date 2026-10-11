// Actual recorded annual-property-tax selection. Pure and dependency-free
// so the year/source precedence below is unit-testable without a database.
//
// The dashboard NEVER estimates property taxes from the list price or any
// tax-rate assumption. A house either has an actual recorded annual tax
// amount in the property store, or its PITI is honestly incomplete.
//
// Supported tax payload shapes:
//
// - property_observations rows with field = 'annual_property_tax' — an
//   explicit recorded annual amount (currently sourced from Zillow listing
//   pages), no tax year attached.
// - RentCast property payloads carry a `propertyTaxes` object keyed by tax
//   year: {"2024": {"year": 2024, "total": 2931}, ...} — actual county tax
//   bills with explicit years, mirrored into property_observations.raw and
//   property_listing_events.raw.
// - RMLS listing sheets (rmls) carry a `tax` string like "2,281.99" —
//   the annual tax printed on the listing, no year attached, so it is dated
//   by when it was observed.
// - `taxAnnual` (Zillow-shaped payloads mirrored by workspace-state) is the
//   same kind of actual annual amount, no year attached.
//
// Deliberately EXCLUDED: `taxAssessments` and `taxAssessedValue` are county
// assessed VALUES, not tax amounts, and must never be shown as taxes.
// Assessor provenance ranks highest when actual tax amounts are available.

/** One provenance-safe tax-bearing row plucked from the store. `value` is
 * only ever the allowlisted tax key's JSON value (or the observation value
 * for field='annual_property_tax') — never a whole raw payload. */
export interface RawTaxSourceRow {
  propertyId: string;
  /** "annual-amount": value is a single annual tax amount (number or a
   * formatted string like "2,281.99"). "by-year": value is a RentCast-style
   * object of {year, total} entries keyed by tax year. */
  kind: "annual-amount" | "by-year";
  value: unknown;
  source: string | null;
  observedAt: string | null;
  confidence: number | null;
}

/** The selected actual annual tax for one property, with provenance. */
export interface ActualAnnualTax {
  amount: number;
  /** Explicit tax year when the source published one (RentCast bills);
   * null when the amount is only dated by observation. */
  taxYear: number | null;
  /** ISO timestamp the amount was observed/recorded — the "as of" date. */
  asOf: string | null;
  source: string | null;
}

/** Parses an annual tax amount from a number or a formatted string
 * ("2,281.99", "$4,305.00"). Zero and negative amounts are treated as
 * unusable — a literal "0.00" in listing feeds means "not filled in",
 * never an actual zero-tax parcel. */
export function parseTaxAmount(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
    n = Number(cleaned);
  } else {
    return null;
  }
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface TaxCandidate {
  amount: number;
  taxYear: number | null;
  source: string | null;
  observedAt: string | null;
  observedMs: number;
  confidence: number;
}

const PLAUSIBLE_TAX_YEAR = /^(19|20)\d{2}$/;

function toObservedMs(observedAt: string | null): number {
  if (!observedAt) return Number.NEGATIVE_INFINITY;
  const t = new Date(observedAt).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Expands one raw row into zero or more usable candidates. A by-year
 * object yields one candidate per year entry with a usable total. */
export function normalizeTaxRow(row: RawTaxSourceRow): TaxCandidate[] {
  const base = {
    source: row.source,
    observedAt: row.observedAt,
    observedMs: toObservedMs(row.observedAt),
    confidence: row.confidence ?? 0,
  };

  if (row.kind === "annual-amount") {
    const amount = parseTaxAmount(row.value);
    return amount === null ? [] : [{ ...base, amount, taxYear: null }];
  }

  // by-year: {"2024": {"year": 2024, "total": 2931}, ...}
  if (row.value === null || typeof row.value !== "object" || Array.isArray(row.value)) return [];
  const candidates: TaxCandidate[] = [];
  for (const [key, entry] of Object.entries(row.value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const amount = parseTaxAmount(record.total);
    if (amount === null) continue;
    let year: number | null = null;
    if (typeof record.year === "number" && PLAUSIBLE_TAX_YEAR.test(String(record.year))) {
      year = record.year;
    } else if (PLAUSIBLE_TAX_YEAR.test(key)) {
      year = Number(key);
    }
    candidates.push({ ...base, amount, taxYear: year });
  }
  return candidates;
}

/**
 * Source-class rank for tie-breaking (lower is more trusted): official
 * assessor data first, then MLS listing sheets, then Zillow, then RentCast,
 * then anything else. This only breaks ties within the same effective year
 * — recency of the tax amount always dominates.
 */
export function taxSourceRank(source: string | null | undefined): number {
  const normalized = source?.trim().toLowerCase() ?? "";
  if (normalized.includes("portlandmaps") || normalized.includes("assessor")) return 0;
  if (normalized.includes("rmls")) return 1;
  if (normalized.includes("zillow")) return 2;
  if (normalized.includes("rentcast")) return 3;
  return 4;
}

/** The year a candidate's amount is "for": the explicit tax year when the
 * source published one, else the year it was observed (a listing sheet's
 * tax line reflects the bill current at observation time). */
function effectiveYear(candidate: TaxCandidate): number {
  if (candidate.taxYear !== null) return candidate.taxYear;
  if (candidate.observedMs === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
  return new Date(candidate.observedMs).getUTCFullYear();
}

/** True when `a` should be selected over `b`. Precedence: latest effective
 * year, then most trusted source class, then explicit tax year over an
 * observation-inferred one, then higher confidence, then most recently
 * observed, then higher amount as the final deterministic tie-break. */
function isBetterCandidate(a: TaxCandidate, b: TaxCandidate): boolean {
  const yearA = effectiveYear(a);
  const yearB = effectiveYear(b);
  if (yearA !== yearB) return yearA > yearB;
  const rankA = taxSourceRank(a.source);
  const rankB = taxSourceRank(b.source);
  if (rankA !== rankB) return rankA < rankB;
  if ((a.taxYear !== null) !== (b.taxYear !== null)) return a.taxYear !== null;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  if (a.observedMs !== b.observedMs) return a.observedMs > b.observedMs;
  return a.amount > b.amount;
}

/**
 * Selects the best actual recorded annual tax per property from the raw
 * tax-bearing rows. Properties with no usable amount get no entry — the
 * caller must render an honest "property tax unavailable" state, never an
 * estimate.
 */
export function selectActualAnnualTaxes(rows: RawTaxSourceRow[]): Map<string, ActualAnnualTax> {
  const best = new Map<string, TaxCandidate>();
  for (const row of rows) {
    for (const candidate of normalizeTaxRow(row)) {
      const existing = best.get(row.propertyId);
      if (!existing || isBetterCandidate(candidate, existing)) {
        best.set(row.propertyId, candidate);
      }
    }
  }
  const result = new Map<string, ActualAnnualTax>();
  for (const [propertyId, candidate] of best) {
    result.set(propertyId, {
      amount: candidate.amount,
      taxYear: candidate.taxYear,
      asOf: candidate.observedAt,
      source: candidate.source,
    });
  }
  return result;
}
