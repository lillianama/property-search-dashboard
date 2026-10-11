// PortlandMaps assessor neighborhoods and their join onto the Zillow
// Research neighborhood ZHVI series. Pure and dependency-free so the
// normalization, alias mapping, observation selection, and join logic are
// unit-testable without a database; the SQL lives in lib/queries.ts.
//
// Provenance rules:
// - A house's neighborhood comes ONLY from persisted raw source payloads
//   (property_observations.raw->>'neighborhood' from the
//   portlandmaps-assessor source). Nothing is ever geocoded, inferred from
//   coordinates, or fetched from an external API here.
// - The join onto Zillow's neighborhood ZHVI uses strict normalization plus
//   the explicit alias table below. A name that does not match exactly (or
//   via an explicit alias) stays UNMATCHED — we never guess which Zillow
//   region "probably" corresponds to an assessor district.

import type { NeighborhoodZhviRow } from "./types";

/** The one source whose neighborhood field this dashboard trusts: the
 * PortlandMaps county assessor records. */
export const ASSESSOR_NEIGHBORHOOD_SOURCE = "portlandmaps-assessor";

/** One raw neighborhood-bearing observation row, as read from the store. */
export interface NeighborhoodObservationRow {
  propertyId: string;
  /** raw->>'neighborhood' exactly as persisted (e.g. "HILLSDALE"). */
  neighborhood: string | null;
  source: string | null;
  observedAt: string | null;
  id: number;
}

/**
 * Normalizes a neighborhood name into the comparison key used for the
 * assessor→Zillow join: uppercase, curly apostrophes straightened, periods
 * dropped ("MT." → "MT", "St.Johns" → "ST JOHNS"), and whitespace collapsed
 * around hyphens and words. This is a matching key only — never displayed.
 */
export function normalizeNeighborhoodKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\./g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Explicit assessor→Zillow aliases for names whose normalized keys differ.
 * Keys and values are NORMALIZED keys (see normalizeNeighborhoodKey).
 *
 * Only well-documented equivalences belong here. Ambiguous combined assessor
 * districts (e.g. "SABIN/IRVINGTON", "GOOSE HOLLOW/SOUTHWEST HILLS") are
 * deliberately absent: they straddle two Zillow regions and picking one
 * would be a guess, so they stay unmatched.
 */
export const NEIGHBORHOOD_ALIASES: Record<string, string> = {
  // Assessor keeps the historic hyphenated district; Zillow publishes plain "Ardenwald".
  "ARDENWALD-JOHNSON CREEK": "ARDENWALD",
  // The county assessor still uses the neighborhood's pre-1989 name;
  // the association renamed Highland to King and Zillow publishes "King".
  HIGHLAND: "KING",
  // Assessor abbreviates Mount; Zillow spells it out (and drops "-Arleta").
  "MT SCOTT-ARLETA": "MOUNT SCOTT",
  "MT TABOR": "MOUNT TABOR",
  // Zillow calls the assessor's "Northwest District" simply "Northwest".
  "NORTHWEST DISTRICT": "NORTHWEST",
  // The neighborhood association renamed Corbett-Terwilliger-Lair Hill to
  // "South Portland" in 2018; Zillow still publishes the old name.
  "SOUTH PORTLAND": "CORBETT-TERWILLIGER-LAIR HILL",
};

/**
 * Selects each property's current assessor neighborhood from raw
 * observation rows: portlandmaps-assessor rows only, latest observed_at
 * wins (row id breaks exact ties), empty/blank values ignored. Properties
 * with no usable assessor row are simply absent from the result — the
 * caller renders them as neighborhood-unknown, never guessed.
 */
export function selectAssessorNeighborhoods(rows: NeighborhoodObservationRow[]): Map<string, string> {
  const best = new Map<string, NeighborhoodObservationRow>();
  for (const row of rows) {
    if (row.source !== ASSESSOR_NEIGHBORHOOD_SOURCE) continue;
    const value = row.neighborhood?.trim();
    if (!value) continue;
    const existing = best.get(row.propertyId);
    if (!existing) {
      best.set(row.propertyId, row);
      continue;
    }
    const rowMs = row.observedAt ? new Date(row.observedAt).getTime() : Number.NEGATIVE_INFINITY;
    const existingMs = existing.observedAt
      ? new Date(existing.observedAt).getTime()
      : Number.NEGATIVE_INFINITY;
    if (rowMs > existingMs || (rowMs === existingMs && row.id > existing.id)) {
      best.set(row.propertyId, row);
    }
  }
  const result = new Map<string, string>();
  for (const [propertyId, row] of best) {
    result.set(propertyId, row.neighborhood!.trim());
  }
  return result;
}

/**
 * Finds the Zillow ZHVI row for one assessor neighborhood name via strict
 * normalized equality or an explicit alias. Returns null when there is no
 * exact/aliased match — never a fuzzy or "closest" match.
 */
export function matchZhviRow(
  assessorName: string,
  zhviRows: NeighborhoodZhviRow[],
): NeighborhoodZhviRow | null {
  const key = normalizeNeighborhoodKey(assessorName);
  const target = NEIGHBORHOOD_ALIASES[key] ?? key;
  for (const row of zhviRows) {
    if (normalizeNeighborhoodKey(row.name) === target) return row;
  }
  return null;
}

/** The market context attached to a house's assessor neighborhood; shape
 * mirrors the Market view's neighborhood table so both always agree. */
export interface HouseNeighborhoodMarket {
  regionId: string;
  /** Zillow's region name (title case), the display name once matched. */
  regionName: string;
  latestMonth: string; // "YYYY-MM"
  /** Latest typical SFR value (ZHVI) for the neighborhood. */
  latestValue: number;
  /** Exact-12-months-ago percentage change; null when that month is absent
   * from the ingested series (never approximated). */
  yearChangePct: number | null;
}

/**
 * Joins assessor neighborhoods onto Zillow ZHVI rows for a set of houses.
 * Returns per-property market info for exactly the houses whose assessor
 * name matched a Zillow region. The ZHVI rows come from the same
 * buildNeighborhoodRows output the Market view renders, so the typical
 * value and year-over-year percentage shown on a funnel row are identical
 * to the Market tab's table.
 */
export function joinNeighborhoodMarket(
  assessorByProperty: Map<string, string>,
  zhviRows: NeighborhoodZhviRow[],
): Map<string, HouseNeighborhoodMarket> {
  // Pre-index the ZHVI rows by normalized key so the join is O(n + m).
  const byKey = new Map<string, NeighborhoodZhviRow>();
  for (const row of zhviRows) {
    const key = normalizeNeighborhoodKey(row.name);
    if (!byKey.has(key)) byKey.set(key, row);
  }

  const result = new Map<string, HouseNeighborhoodMarket>();
  for (const [propertyId, assessorName] of assessorByProperty) {
    const key = normalizeNeighborhoodKey(assessorName);
    const row = byKey.get(NEIGHBORHOOD_ALIASES[key] ?? key);
    if (!row) continue;
    result.set(propertyId, {
      regionId: row.regionId,
      regionName: row.name,
      latestMonth: row.latestMonth,
      latestValue: row.latestValue,
      yearChangePct: row.yearChangePct,
    });
  }
  return result;
}
