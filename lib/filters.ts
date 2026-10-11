// Parsing and validation for dashboard filter query params. Kept dependency
// free and pure so it is easy to unit test independent of Next.js or the
// database.

export interface HouseFilters {
  statuses: string[] | null;
  maxPrice: number | null;
  minBedrooms: number | null;
  maxYearBuilt: number | null;
  dateFrom: string | null;
  dateTo: string | null;
}

const KNOWN_STATUSES = new Set(["Active", "Pending", "Inactive", "Unverified", "Sold", "Unknown"]);

function parseStatuses(raw: string | null): string[] | null {
  if (!raw) return null;
  const values = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (values.length === 0) return null;
  const deduped = Array.from(new Set(values));
  return deduped;
}

function parsePositiveNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseYear(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 1600 || value > 2200) return null;
  return Math.trunc(value);
}

function parseIsoDate(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return trimmed;
}

/**
 * Parses filters from a URLSearchParams-like source. Never throws: any
 * malformed input is dropped back to "no filter" rather than erroring the
 * request, since filters are always optional refinements.
 */
export function parseHouseFilters(params: {
  get(name: string): string | null;
}): HouseFilters {
  let dateFrom = parseIsoDate(params.get("dateFrom"));
  let dateTo = parseIsoDate(params.get("dateTo"));
  if (dateFrom && dateTo && dateFrom > dateTo) {
    // Swap rather than silently dropping a range the user clearly intended.
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }

  return {
    statuses: parseStatuses(params.get("status")),
    maxPrice: parsePositiveNumber(params.get("maxPrice")),
    minBedrooms: parsePositiveNumber(params.get("minBedrooms")),
    maxYearBuilt: parseYear(params.get("maxYearBuilt")),
    dateFrom,
    dateTo,
  };
}

export function isKnownStatus(status: string): boolean {
  return KNOWN_STATUSES.has(status);
}

export const ALL_KNOWN_STATUSES = Array.from(KNOWN_STATUSES);

/** No filters applied: every tracked house. Used by views (like the
 * Rejected archive) that intentionally ignore the My Search filter set. */
export const EMPTY_HOUSE_FILTERS: HouseFilters = {
  statuses: null,
  maxPrice: null,
  minBedrooms: null,
  maxYearBuilt: null,
  dateFrom: null,
  dateTo: null,
};
