// Pure helpers for the Portland Market view (Zillow Research data). Kept
// free of database and Next.js imports so they can be unit tested in
// isolation, mirroring lib/aggregate.ts for the tracker view.

import type { MarketSeriesPoint, MarketStaleness, NeighborhoodZhviRow } from "./types";

/** Zillow publishes monthly data with a lag. Two missed monthly cycles
 * (~75 days past the latest month-end) means the local copy is stale and
 * needs a re-ingest, not that Zillow is wrong. */
export const MARKET_STALE_AFTER_DAYS = 75;

/** Converts a "YYYY-MM-DD" month-end period into its "YYYY-MM" key. Returns
 * the input unchanged when it does not look like a date. */
export function monthKey(periodEnd: string): string {
  const match = /^(\d{4}-\d{2})-\d{2}/.exec(periodEnd);
  return match ? match[1] : periodEnd;
}

/**
 * Classifies local market-data freshness from the latest ingested month-end.
 * "missing" when there is no data at all, "stale" when the newest month-end
 * is more than MARKET_STALE_AFTER_DAYS old, otherwise "fresh".
 */
export function classifyStaleness(
  latestPeriodEnd: string | null | undefined,
  now: Date = new Date(),
): MarketStaleness {
  if (!latestPeriodEnd) return "missing";
  const t = new Date(latestPeriodEnd).getTime();
  if (!Number.isFinite(t)) return "missing";
  const ageDays = (now.getTime() - t) / (1000 * 60 * 60 * 24);
  return ageDays > MARKET_STALE_AFTER_DAYS ? "stale" : "fresh";
}

/** Last point of an already chronologically-sorted series, or null. */
export function latestPoint(points: MarketSeriesPoint[]): MarketSeriesPoint | null {
  return points.length > 0 ? points[points.length - 1] : null;
}

/** "YYYY-MM" exactly twelve months before the given month key, or null when
 * the input is malformed. */
export function monthOneYearBefore(month: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  return `${Number(match[1]) - 1}-${match[2]}`;
}

export interface NeighborhoodSeriesInput {
  regionId: string;
  name: string;
  month: string; // "YYYY-MM"
  value: number;
}

/**
 * Collapses per-month neighborhood ZHVI rows into one row per neighborhood
 * with the latest typical value and the exact-12-months-ago comparison when
 * that month exists. Sorted by latest value descending so the table reads as
 * a ranking. Year-over-year change is null (never guessed) when the
 * year-ago month is absent.
 */
export function buildNeighborhoodRows(rows: NeighborhoodSeriesInput[]): NeighborhoodZhviRow[] {
  const byRegion = new Map<string, { name: string; byMonth: Map<string, number> }>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    let entry = byRegion.get(row.regionId);
    if (!entry) {
      entry = { name: row.name, byMonth: new Map() };
      byRegion.set(row.regionId, entry);
    }
    entry.byMonth.set(row.month, row.value);
  }

  const result: NeighborhoodZhviRow[] = [];
  for (const [regionId, { name, byMonth }] of byRegion) {
    const months = Array.from(byMonth.keys()).sort();
    if (months.length === 0) continue;
    const latestMonth = months[months.length - 1];
    const latestValue = byMonth.get(latestMonth)!;
    const yearAgoMonth = monthOneYearBefore(latestMonth);
    const yearAgoValue = yearAgoMonth !== null ? (byMonth.get(yearAgoMonth) ?? null) : null;
    const yearChangePct =
      yearAgoValue !== null && yearAgoValue !== 0
        ? ((latestValue - yearAgoValue) / yearAgoValue) * 100
        : null;
    result.push({ regionId, name, latestMonth, latestValue, yearAgoValue, yearChangePct });
  }

  return result.sort((a, b) => b.latestValue - a.latestValue || a.name.localeCompare(b.name));
}

export interface PreferenceCriteria {
  maxPrice: number;
  minYearBuilt: number;
  maxYearBuilt: number;
}

/** Formats the explicit limited-coverage disclosure for the observed
 * preference-match summary. The summary is derived from the tracked
 * property store only, never from citywide market data. */
export function buildPreferenceMatchNote(
  matching: number,
  total: number,
  criteria: PreferenceCriteria,
): string {
  const price = `$${Math.round(criteria.maxPrice / 1000)}k`;
  return (
    `${matching} of the ${total} houses you have tracked in the property store match the configured ` +
    `search criteria (list price at or under ${price}, built ${criteria.minYearBuilt}\u2013${criteria.maxYearBuilt}). ` +
    "Limited coverage: this counts only the properties you have actively researched and logged, " +
    "not Portland's full inventory, so it describes your research funnel rather than market availability."
  );
}

/** Reads the observed preference criteria from the environment with the
 * illustrative defaults that can be overridden. Malformed
 * values fall back to the defaults rather than erroring. */
export function preferenceCriteriaFromEnv(env: Record<string, string | undefined>): PreferenceCriteria {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    maxPrice: num(env.MARKET_PREF_MAX_PRICE, 480_000),
    minYearBuilt: num(env.MARKET_PREF_MIN_YEAR_BUILT, 1900),
    maxYearBuilt: num(env.MARKET_PREF_MAX_YEAR_BUILT, 1965),
  };
}
