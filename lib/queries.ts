import type { PropertyTrack } from "./track";
import { normalizeDateAdded } from "./aggregate";
import { withReadOnlyClient } from "./db";
import type { EditorNoteRevisionRow } from "./editor";
import type { HouseFilters } from "./filters";
import { FUNNEL_COLLECTIONS, type ActiveCollectionRow } from "./funnel";
import { PHOTO_PAYLOAD_KEYS, type PhotoSourceRow } from "./photos";
import type { RawTaxSourceRow } from "./tax";
import type { DecisionRow } from "./rejection";
import { displayStatusFromRaw, type StatusEventRow } from "./status";
import type { BedroomSizeFlag, HouseRecord, QuickJudgments, TriStateJudgment } from "./types";
import { UNKNOWN_JUDGMENTS } from "./types";

// Every query in this module is a plain SELECT against the property-store
// schema (property_current, property_bedroom_flags, property_identifiers,
// property_listing_events, property_records, property_interactions,
// property_collections, property_source_snapshots, and the dashboard's
// additive property_editor_notes table). No migrations, DDL, or writes
// belong here. Session-level read-only mode is also enforced in lib/db.ts
// as a second safety net. (The two deliberate write paths live separately
// in lib/funnel-writes.ts and lib/editor-writes.ts.)

// jsonb observation values (bedrooms, bathrooms, finished_sqft, year_built)
// are not guaranteed to be numeric-shaped, so every read casts defensively
// instead of trusting the stored type.
const safeNumeric = (column: string) =>
  `CASE WHEN jsonb_typeof(${column}) = 'number' THEN (${column} #>> '{}')::numeric ELSE NULL END`;

const HOUSE_BASE_CTE = `
  SELECT
    pc.id AS id,
    pc.canonical_address AS address,
    pc.city AS city,
    pc.state AS state,
    pc.zip_code AS zip_code,
    pc.latitude AS latitude,
    pc.longitude AS longitude,
    ${safeNumeric("pc.bedrooms")} AS bedrooms,
    ${safeNumeric("pc.bathrooms")} AS bathrooms,
    ${safeNumeric("pc.finished_sqft")} AS finished_sqft,
    ${safeNumeric("pc.year_built")} AS year_built,
    pc.latest_price AS latest_price,
    pc.latest_status AS latest_status,
    pc.latest_sale_price AS latest_sale_price,
    pc.latest_sale_date AS latest_sale_date,
    pc.first_seen_at AS first_seen_at,
    pc.last_seen_at AS last_seen_at,
    COALESCE(bf.bedroom_size_flag, 'unknown') AS bedroom_size_flag,
    bf.smallest_bedroom_sqft AS smallest_bedroom_sqft,
    zu.value AS zillow_url
  FROM property_current pc
  LEFT JOIN property_bedroom_flags bf ON bf.property_id = pc.id
  LEFT JOIN LATERAL (
    SELECT value
    FROM property_identifiers
    WHERE property_id = pc.id AND kind = 'zillow_url'
    ORDER BY first_seen_at DESC
    LIMIT 1
  ) zu ON true
  WHERE pc.track = $6
`;

interface HouseRow {
  id: string;
  address: string;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  latitude: number | null;
  longitude: number | null;
  bedrooms: string | null;
  bathrooms: string | null;
  finished_sqft: string | null;
  year_built: string | null;
  latest_price: number | null;
  latest_status: string | null;
  latest_sale_price: number | null;
  latest_sale_date: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  bedroom_size_flag: string;
  smallest_bedroom_sqft: string | null;
  zillow_url: string | null;
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBedroomFlag(value: string): BedroomSizeFlag {
  if (value === "critical" || value === "small" || value === "ok") return value;
  return "unknown";
}

function mapHouseRow(row: HouseRow): HouseRecord {
  return {
    photoUrl: null,
    photoSource: null,
    // Watchlist is the catch-all; lib/dashboard.ts overrides this from the
    // property's actual active collection memberships.
    funnelBucket: "watchlist",
    // Global manual rank and quick judgments are attached separately
    // (best-effort) in lib/dashboard.ts. Null rank = never ranked;
    // all-unknown judgments = never evaluated (never coerced to "no").
    rankKey: null,
    judgments: UNKNOWN_JUDGMENTS,
    // Fallback resolution straight from the raw latest status; lib/dashboard.ts
    // upgrades this from the full listing-event history when available.
    displayStatus: displayStatusFromRaw(row.latest_status),
    dateAdded: normalizeDateAdded(row.first_seen_at),
    // Actual recorded tax amounts are attached separately (best-effort) in
    // lib/dashboard.ts; null means "no actual tax recorded" and the UI
    // shows an explicitly incomplete PITI — taxes are never estimated.
    annualTaxAmount: null,
    annualTaxYear: null,
    annualTaxAsOf: null,
    annualTaxSource: null,
    // Assessor neighborhood + Zillow market context are attached separately
    // (best-effort) in lib/dashboard.ts; null means "not recorded/unmatched"
    // and the UI says so — never a guess.
    neighborhood: null,
    neighborhoodMarket: null,
    id: row.id,
    address: row.address,
    city: row.city,
    state: row.state,
    zipCode: row.zip_code,
    latitude: row.latitude,
    longitude: row.longitude,
    bedrooms: toNumberOrNull(row.bedrooms),
    bathrooms: toNumberOrNull(row.bathrooms),
    finishedSqft: toNumberOrNull(row.finished_sqft),
    yearBuilt: toNumberOrNull(row.year_built),
    latestPrice: toNumberOrNull(row.latest_price),
    latestStatus: row.latest_status,
    latestSalePrice: toNumberOrNull(row.latest_sale_price),
    latestSaleDate: row.latest_sale_date,
    bedroomSizeFlag: toBedroomFlag(row.bedroom_size_flag),
    smallestBedroomSqft: toNumberOrNull(row.smallest_bedroom_sqft),
    zillowUrl: row.zillow_url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Fetches every tracked house that matches the non-status filters, plus the
 * last_seen_at freshness window when a date range is supplied. Backs the
 * KPI cards, price/status distributions, map, and table, which all share
 * the same filtered set for consistency.
 *
 * The STATUS filter is deliberately NOT applied here: statuses are resolved
 * from the full listing-event history in lib/status.ts (so explicit Pending
 * evidence is not buried by generic Inactive observations), and the filter
 * is applied to those RESOLVED statuses in lib/dashboard.ts.
 */
export async function fetchHouses(filters: HouseFilters, track: PropertyTrack = "house"): Promise<HouseRecord[]> {
  const sql = `
    WITH house_base AS (${HOUSE_BASE_CTE})
    SELECT * FROM house_base
    WHERE ($1::numeric IS NULL OR (latest_price IS NOT NULL AND latest_price <= $1))
      AND ($2::numeric IS NULL OR (bedrooms IS NOT NULL AND bedrooms >= $2))
      AND ($3::numeric IS NULL OR (year_built IS NOT NULL AND year_built <= $3))
      AND ($4::date IS NULL OR (last_seen_at IS NOT NULL AND last_seen_at::date >= $4::date))
      AND ($5::date IS NULL OR (last_seen_at IS NOT NULL AND last_seen_at::date <= $5::date))
    ORDER BY address ASC
  `;
  const params = [
    filters.maxPrice,
    filters.minBedrooms,
    filters.maxYearBuilt,
    filters.dateFrom,
    filters.dateTo,
    track,
  ];

  return withReadOnlyClient(async (client) => {
    const result = await client.query<HouseRow>(sql, params);
    return result.rows.map(mapHouseRow);
  });
}

export interface RawListingEvent {
  month: string;
  price: number | null;
}

/**
 * Fetches monthly listing-event rows (event month + price) for exactly the
 * given properties, with event_date constrained by the date-range filter.
 * The caller passes the final filtered set (resolved-status filter applied,
 * rejected houses excluded), so the history chart always reflects the same
 * houses as the KPIs, map, and cards. This is intentionally the
 * tracked/researched dataset only, not full MLS inventory.
 */
export async function fetchMonthlyListingEvents(
  filters: HouseFilters,
  propertyIds: string[],
): Promise<RawListingEvent[]> {
  if (propertyIds.length === 0) return [];

  const sql = `
    SELECT
      to_char(date_trunc('month', e.event_date), 'YYYY-MM') AS month,
      e.price AS price
    FROM property_listing_events e
    WHERE e.property_id = ANY($1::uuid[])
      AND e.event_date IS NOT NULL
      AND ($2::date IS NULL OR e.event_date >= $2::date)
      AND ($3::date IS NULL OR e.event_date <= $3::date)
    ORDER BY month ASC
  `;
  const params = [propertyIds, filters.dateFrom, filters.dateTo];

  return withReadOnlyClient(async (client) => {
    const result = await client.query<{ month: string; price: number | null }>(sql, params);
    return result.rows;
  });
}

interface StatusEventSqlRow {
  event_type: string;
  price: number | null;
  mls_number: string | null;
  property_id: string;
  status: string | null;
  source: string | null;
  event_date: string | null;
  observed_at: string | null;
  id: string | number;
}

/**
 * Fetches the allowlisted listing-event history for the given properties
 * so lib/status.ts can resolve each house's canonical display status. This
 * selects status, source, timestamps, price, event type and internal MLS
 * association only. No raw payloads or source references leave PostgreSQL. All interpretation
 * (source semantics, recency precedence) lives in lib/status.ts so it stays
 * unit testable without a database.
 */
export async function fetchStatusEventRows(propertyIds: string[]): Promise<StatusEventRow[]> {
  if (propertyIds.length === 0) return [];

  const sql = `
    SELECT
      property_id::text AS property_id,
      status,
      event_type, price, mls_number,
      source,
      event_date::text AS event_date,
      observed_at::text AS observed_at,
      id
    FROM property_listing_events
    WHERE property_id = ANY($1::uuid[])

    ORDER BY property_id, observed_at ASC, id ASC
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<StatusEventSqlRow>(sql, [propertyIds]);
    return result.rows.map((row) => ({
      propertyId: row.property_id,
      eventType: row.event_type,
      price: toNumberOrNull(row.price),
      mlsNumber: row.mls_number,
      status: row.status,
      source: row.source,
      eventDate: row.event_date,
      observedAt: row.observed_at,
      id: typeof row.id === "number" ? row.id : Number(row.id),
    }));
  });
}

interface ActualTaxSqlRow {
  property_id: string;
  kind: string;
  value: unknown;
  source: string | null;
  observed_at: string | null;
  confidence: string | number | null;
}

/**
 * Fetches ACTUAL recorded annual-property-tax data for the given properties
 * from every place the store persists it (see lib/tax.ts for the source
 * inventory): explicit annual_property_tax observations, RentCast per-year
 * `propertyTaxes` bills, RMLS `tax` lines, and Zillow-shaped `taxAnnual`
 * values, across observations, listing events, and source snapshots.
 *
 * Provenance-safe plain SELECT: only the single allowlisted tax key's value
 * is plucked out of each raw payload in SQL — owner/agent/private fields
 * never leave the database. Assessed VALUES (taxAssessments,
 * taxAssessedValue) are deliberately never read: they are not tax amounts.
 * Choosing the best amount per property (tax year, then source class)
 * happens in lib/tax.ts so it stays unit testable.
 */
export async function fetchActualTaxRows(propertyIds: string[]): Promise<RawTaxSourceRow[]> {
  if (propertyIds.length === 0) return [];

  const sql = `
    SELECT property_id, kind, value, source, observed_at, confidence FROM (
      SELECT
        o.property_id::text AS property_id,
        'annual-amount' AS kind,
        o.value AS value,
        o.source AS source,
        o.observed_at::text AS observed_at,
        o.confidence AS confidence
      FROM property_observations o
      WHERE o.property_id = ANY($1::uuid[]) AND o.field = 'annual_property_tax'
      UNION ALL
      SELECT
        o.property_id::text,
        CASE WHEN key = 'propertyTaxes' THEN 'by-year' ELSE 'annual-amount' END,
        o.raw -> key,
        o.source,
        o.observed_at::text,
        o.confidence
      FROM property_observations o
      CROSS JOIN unnest(ARRAY['propertyTaxes', 'tax', 'taxAnnual']) AS key
      WHERE o.property_id = ANY($1::uuid[]) AND o.raw IS NOT NULL AND o.raw ? key
      UNION ALL
      SELECT
        e.property_id::text,
        CASE WHEN key = 'propertyTaxes' THEN 'by-year' ELSE 'annual-amount' END,
        e.raw -> key,
        e.source,
        e.observed_at::text,
        NULL::numeric
      FROM property_listing_events e
      CROSS JOIN unnest(ARRAY['propertyTaxes', 'tax', 'taxAnnual']) AS key
      WHERE e.property_id = ANY($1::uuid[]) AND e.raw IS NOT NULL AND e.raw ? key
      UNION ALL
      SELECT
        s.property_id::text,
        CASE WHEN key = 'propertyTaxes' THEN 'by-year' ELSE 'annual-amount' END,
        s.payload -> key,
        s.source,
        s.captured_at::text,
        NULL::numeric
      FROM property_source_snapshots s
      CROSS JOIN unnest(ARRAY['propertyTaxes', 'tax', 'taxAnnual']) AS key
      WHERE s.property_id = ANY($1::uuid[]) AND s.payload IS NOT NULL AND s.payload ? key
    ) tax_rows
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<ActualTaxSqlRow>(sql, [propertyIds]);
    return result.rows.map((row) => ({
      propertyId: row.property_id,
      kind: row.kind === "by-year" ? ("by-year" as const) : ("annual-amount" as const),
      value: row.value,
      source: row.source,
      observedAt: row.observed_at,
      confidence: toNumberOrNull(row.confidence),
    }));
  });
}

interface DecisionSqlRow {
  property_id: string;
  verdict: string | null;
  note: string | null;
  occurred_at: string | null;
}

/**
 * Fetches raw property_interactions rows that carry a non-empty verdict for
 * the given properties, in occurred_at order. This is intentionally a plain
 * read with no interpretation: deciding what counts as a rejection, and
 * which decision is "latest", happens in lib/rejection.ts so that logic can
 * be unit tested without a database.
 */
export async function fetchLatestDecisionRows(propertyIds: string[]): Promise<DecisionRow[]> {
  if (propertyIds.length === 0) return [];

  const sql = `
    SELECT property_id::text AS property_id, verdict, note, occurred_at::text AS occurred_at
    FROM property_interactions
    WHERE property_id = ANY($1::uuid[])
      AND verdict IS NOT NULL
      AND btrim(verdict) <> ''
    ORDER BY property_id, occurred_at ASC, id ASC
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<DecisionSqlRow>(sql, [propertyIds]);
    return result.rows.map((row) => ({
      propertyId: row.property_id,
      verdict: row.verdict,
      note: row.note,
      occurredAt: row.occurred_at,
    }));
  });
}

/**
 * Fetches active funnel-relevant collection memberships (top-contenders,
 * either tour-shortlist spelling, watchlist) for the given house properties.
 * Plain read; deriving each property's single current bucket — including
 * multi-membership precedence — happens in lib/funnel.ts so it stays unit
 * testable without a database.
 */
export async function fetchActiveFunnelCollections(propertyIds: string[], track: PropertyTrack = "house"): Promise<ActiveCollectionRow[]> {
  if (propertyIds.length === 0) return [];

  const sql = `
    SELECT property_id::text AS property_id, collection
    FROM property_collections
    WHERE property_id = ANY($1::uuid[])
      AND active
      AND collection = ANY($2::text[])
      AND track = $3
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<{ property_id: string; collection: string }>(sql, [
      propertyIds,
      [...FUNNEL_COLLECTIONS],
      track,
    ]);
    return result.rows.map((row) => ({ propertyId: row.property_id, collection: row.collection }));
  });
}

interface PhotoSourceSqlRow {
  property_id: string;
  payload: unknown;
  source: string;
  observed_at: string | null;
  confidence: string | number | null;
}

/**
 * Fetches persisted raw payload rows that may carry listing-photo URLs for
 * the given properties, from observations, listing events, and source
 * snapshots. Only the allowlisted photo keys are plucked out of each payload
 * in SQL, so owner/agent/private fields in `raw` never leave the database.
 * Read-only like everything else in this module.
 */
export async function fetchPhotoSourceRows(propertyIds: string[]): Promise<PhotoSourceRow[]> {
  if (propertyIds.length === 0) return [];

  const keys = [...PHOTO_PAYLOAD_KEYS];
  const pluck = (column: string) => `
    (SELECT jsonb_object_agg(key, ${column} -> key)
     FROM unnest($2::text[]) AS key
     WHERE ${column} ? key)
  `;

  const sql = `
    SELECT property_id, payload, source, observed_at, confidence FROM (
      SELECT
        o.property_id::text AS property_id,
        ${pluck("o.raw")} AS payload,
        o.source AS source,
        o.observed_at::text AS observed_at,
        o.confidence AS confidence
      FROM property_observations o
      WHERE o.property_id = ANY($1::uuid[]) AND o.raw IS NOT NULL AND o.raw ?| $2::text[]
      UNION ALL
      SELECT
        e.property_id::text AS property_id,
        ${pluck("e.raw")} AS payload,
        e.source AS source,
        e.observed_at::text AS observed_at,
        NULL::numeric AS confidence
      FROM property_listing_events e
      WHERE e.property_id = ANY($1::uuid[]) AND e.raw IS NOT NULL AND e.raw ?| $2::text[]
      UNION ALL
      SELECT
        s.property_id::text AS property_id,
        ${pluck("s.payload")} AS payload,
        s.source AS source,
        s.captured_at::text AS observed_at,
        NULL::numeric AS confidence
      FROM property_source_snapshots s
      WHERE s.property_id = ANY($1::uuid[]) AND s.payload IS NOT NULL AND s.payload ?| $2::text[]
    ) photo_rows
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<PhotoSourceSqlRow>(sql, [propertyIds, keys]);
    return result.rows.map((row) => ({
      propertyId: row.property_id,
      payload: row.payload,
      source: row.source,
      observedAt: row.observed_at,
      confidence: toNumberOrNull(row.confidence),
    }));
  });
}

/**
 * Fetches every editor-note revision for one property so lib/editor.ts can
 * select the current value per field. Plain SELECT over the dedicated
 * property_editor_notes table only — these are the user’s own notes, never
 * source listing remarks, and no other columns/tables are touched. Returns
 * null when the property does not exist (or is not a tracked house) so the
 * API can 404 instead of inventing an empty editor for unknown IDs.
 */
export async function fetchEditorNoteRows(propertyId: string, track: PropertyTrack = "house"): Promise<EditorNoteRevisionRow[] | null> {
  return withReadOnlyClient(async (client) => {
    const exists = await client.query(
      `SELECT 1 FROM property_records WHERE id = $1::uuid AND track = $2`,
      [propertyId, track],
    );
    if (exists.rowCount === 0) return null;

    const result = await client.query<{ field: string; value: string; saved_at: string | null; id: string | number }>(
      `SELECT field, value, saved_at::text AS saved_at, id
       FROM property_editor_notes
       WHERE property_id = $1::uuid
       ORDER BY saved_at ASC, id ASC`,
      [propertyId],
    );
    return result.rows.map((row) => ({
      field: row.field,
      value: row.value,
      savedAt: row.saved_at,
      id: typeof row.id === "number" ? row.id : Number(row.id),
    }));
  });
}

/**
 * Fetches every quick-judgment revision for one property so lib/editor.ts
 * can select the current tri-state verdict per field. Plain SELECT over the
 * dedicated property_editor_judgments table only. Returns null when the
 * property does not exist (or is not a tracked house), matching
 * fetchEditorNoteRows.
 */
export async function fetchEditorJudgmentRows(
  propertyId: string,
  track: PropertyTrack = "house",
): Promise<Array<{ field: string; verdict: string; savedAt: string | null; id: number }> | null> {
  return withReadOnlyClient(async (client) => {
    const exists = await client.query(
      `SELECT 1 FROM property_records WHERE id = $1::uuid AND track = $2`,
      [propertyId, track],
    );
    if (exists.rowCount === 0) return null;

    const result = await client.query<{ field: string; verdict: string; saved_at: string | null; id: string | number }>(
      `SELECT field, verdict, saved_at::text AS saved_at, id
       FROM property_editor_judgments
       WHERE property_id = $1::uuid
       ORDER BY saved_at ASC, id ASC`,
      [propertyId],
    );
    return result.rows.map((row) => ({
      field: row.field,
      verdict: row.verdict,
      savedAt: row.saved_at,
      id: typeof row.id === "number" ? row.id : Number(row.id),
    }));
  });
}

export interface PropertyLocationRow {
  latitude: number | null;
  longitude: number | null;
}

/**
 * Coordinates for one tracked house, used only by the Street View proxy.
 * Returns null for IDs that don't exist (or aren't houses) so the proxy can
 * reject unknown IDs. Read-only like everything else in this module, and it
 * deliberately selects nothing but latitude/longitude.
 */
export async function fetchPropertyLocation(propertyId: string, track: PropertyTrack = "house"): Promise<PropertyLocationRow | null> {
  return withReadOnlyClient(async (client) => {
    const result = await client.query<PropertyLocationRow>(
      `SELECT latitude, longitude FROM property_current WHERE id = $1::uuid AND track = $2`,
      [propertyId, track],
    );
    const row = result.rows[0];
    return row ? { latitude: row.latitude, longitude: row.longitude } : null;
  });
}

/**
 * Latest (current) global rank key per property, from the append-only
 * property_funnel_ranks revisions. Plain read; structural validation and
 * ordering semantics live in lib/rank.ts / lib/funnel.ts. Callers treat a
 * missing table (schema not applied yet) as "no ranks" via their
 * best-effort error handling.
 */
export async function fetchCurrentRankKeys(propertyIds: string[]): Promise<Map<string, string>> {
  if (propertyIds.length === 0) return new Map();

  const sql = `
    SELECT DISTINCT ON (property_id)
      property_id::text AS property_id,
      rank_key
    FROM property_funnel_ranks
    WHERE property_id = ANY($1::uuid[])
    ORDER BY property_id, created_at DESC, id DESC
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<{ property_id: string; rank_key: string }>(sql, [propertyIds]);
    const map = new Map<string, string>();
    for (const row of result.rows) map.set(row.property_id, row.rank_key);
    return map;
  });
}

const JUDGMENT_FIELD_TO_KEY: Record<string, keyof QuickJudgments> = {
  bedroom_size_ok: "bedroomSizeOk",
  rental_income: "rentalIncome",
  drum_space: "drumSpace",
};

function toTriState(value: string): TriStateJudgment {
  return value === "yes" || value === "no" ? value : "unknown";
}

/**
 * Latest (current) quick preference judgment per property and field, from
 * the append-only property_editor_judgments revisions. Properties or fields
 * never judged simply have no row and stay "unknown" — they are never
 * coerced to "no". Plain read like everything else in this module.
 */
export async function fetchCurrentJudgments(propertyIds: string[]): Promise<Map<string, QuickJudgments>> {
  if (propertyIds.length === 0) return new Map();

  const sql = `
    SELECT DISTINCT ON (property_id, field)
      property_id::text AS property_id,
      field,
      verdict
    FROM property_editor_judgments
    WHERE property_id = ANY($1::uuid[])
    ORDER BY property_id, field, saved_at DESC, id DESC
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<{ property_id: string; field: string; verdict: string }>(sql, [propertyIds]);
    const map = new Map<string, QuickJudgments>();
    for (const row of result.rows) {
      const key = JUDGMENT_FIELD_TO_KEY[row.field];
      if (!key) continue;
      const current = map.get(row.property_id) ?? { ...UNKNOWN_JUDGMENTS };
      current[key] = toTriState(row.verdict);
      map.set(row.property_id, current);
    }
    return map;
  });
}

interface NeighborhoodObservationSqlRow {
  property_id: string;
  neighborhood: string | null;
  source: string | null;
  observed_at: string | null;
  id: string | number;
}

/**
 * Fetches raw neighborhood-bearing observation rows for the given
 * properties. Provenance-safe plain SELECT: only the single 'neighborhood'
 * key is plucked out of each raw payload — owner/agent/private fields never
 * leave the database. Selecting each property's current assessor
 * neighborhood (source filter, recency) happens in lib/neighborhood.ts so
 * it stays unit testable.
 */
export async function fetchNeighborhoodObservationRows(
  propertyIds: string[],
): Promise<import("./neighborhood").NeighborhoodObservationRow[]> {
  if (propertyIds.length === 0) return [];

  const sql = `
    SELECT
      o.property_id::text AS property_id,
      o.raw ->> 'neighborhood' AS neighborhood,
      o.source AS source,
      o.observed_at::text AS observed_at,
      o.id
    FROM property_observations o
    WHERE o.property_id = ANY($1::uuid[])
      AND o.raw IS NOT NULL
      AND o.raw ? 'neighborhood'
    ORDER BY o.property_id, o.observed_at ASC, o.id ASC
  `;

  return withReadOnlyClient(async (client) => {
    const result = await client.query<NeighborhoodObservationSqlRow>(sql, [propertyIds]);
    return result.rows.map((row) => ({
      propertyId: row.property_id,
      neighborhood: row.neighborhood,
      source: row.source,
      observedAt: row.observed_at,
      id: typeof row.id === "number" ? row.id : Number(row.id),
    }));
  });
}

export interface TrackedPropertyTotals {
  houseTotal: number;
  storeTotal: number;
}

/** Tracked-property counts used only for the coverage/freshness explanation
 * copy, never for KPI math. Both legacy response fields now refer only
 * to the selected track; no combined-store count is exposed. */
export async function fetchTrackedPropertyTotals(track: PropertyTrack = "house"): Promise<TrackedPropertyTotals> {
  return withReadOnlyClient(async (client) => {
    const result = await client.query<{ house_total: string; store_total: string }>(`
      SELECT
        count(*)::text AS house_total,
        count(*)::text AS store_total
      FROM property_records WHERE track = $1
    `, [track]);
    const row = result.rows[0];
    return {
      houseTotal: Number(row?.house_total ?? "0"),
      storeTotal: Number(row?.store_total ?? "0"),
    };
  });
}
