export interface UnitSummary {
  label: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  occupancy: "occupied" | "vacant" | "unknown";
  actualMonthlyRent: number | null;
  expectedMonthlyRent: number | null;
  source: string;
  asOf: string | null;
}

export interface PlexUnitSummary {
  units: UnitSummary[];
  recordedUnitCount: { count: number; source: string; asOf: string | null } | null;
}

export interface UnitSourceRow {
  property_id: string;
  field: "unit_mix" | "unit_configuration" | "unit_count";
  value: unknown;
  source: string;
  observed_at: string | null;
}

const number = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const date = (v: string | null): string | null =>
  v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export function normalizeUnits(row: UnitSourceRow): UnitSummary[] {
  let values: unknown[] = [];
  if (row.field === "unit_mix" && Array.isArray(row.value)) values = row.value;
  // This source explicitly describes BOTH units, not building-level totals.
  if (row.field === "unit_configuration" && typeof row.value === "string") {
    const match = /^Two side-by-side (\d+)BR\/(\d+(?:\.\d+)?)BA units(?:,|$)/.exec(row.value);
    if (match) values = Array.from({ length: 2 }, () => ({ bedrooms: +match[1], bathrooms: +match[2] }));
  }
  return values.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const v = value as Record<string, unknown>;
    return [{
      label: `Unit ${index + 1} (source order)`,
      beds: number(v.bedrooms), baths: number(v.bathrooms), sqft: number(v.sqft),
      occupancy: v.occupancy === "occupied" || v.occupancy === "vacant" ? v.occupancy : "unknown",
      actualMonthlyRent: number(v.actualRent),
      expectedMonthlyRent: number(v.expectedMonthlyRent),
      source: row.source, asOf: date(row.observed_at),
    } satisfies UnitSummary];
  });
}

export function selectPlexUnits(rows: UnitSourceRow[]): Map<string, PlexUnitSummary> {
  const result = new Map<string, PlexUnitSummary>();
  // Choose a whole latest unit snapshot; never join units across sources by
  // array position or add duplicate observations to the rental subtotal.
  const sorted = [...rows].sort((a, b) =>
    (Date.parse(b.observed_at ?? "") || 0) - (Date.parse(a.observed_at ?? "") || 0)
    || a.source.localeCompare(b.source) || a.field.localeCompare(b.field));
  const selected = new Set<string>();
  for (const row of sorted) {
    const summary = result.get(row.property_id) ?? { units: [], recordedUnitCount: null };
    result.set(row.property_id, summary);
    if (row.field === "unit_count") {
      const count = number(row.value);
      if (!summary.recordedUnitCount && count !== null && Number.isInteger(count) && count > 0)
        summary.recordedUnitCount = { count, source: row.source, asOf: date(row.observed_at) };
    } else if (!selected.has(row.property_id)) {
      summary.units = normalizeUnits(row);
      selected.add(row.property_id);
    }
  }
  return result;
}

export function rentalSubtotal(units: UnitSummary[], field: "actualMonthlyRent" | "expectedMonthlyRent") {
  const recorded = units.flatMap(unit => unit[field] === null ? [] : [unit[field]]);
  return { amount: recorded.length ? recorded.reduce((sum, rent) => sum + rent, 0) : null, count: recorded.length };
}
