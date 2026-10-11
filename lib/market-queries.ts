import { withReadOnlyClient } from "./db";

// Read-only queries for the Portland Market view. The market tables
// (market_metric_series, market_ingest_runs) are created and written only
// by scripts/ingest-zillow.mjs; this module never issues DDL or writes.
// Until the first ingest run the tables may not exist at all, so every
// query treats Postgres error 42P01 (undefined_table) as "no data yet"
// instead of a failure.

const MARKET_SOURCE = "zillow_research";

function isMissingTableError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01";
}

export interface CityMetricPointRow {
  metric: string;
  month: string; // "YYYY-MM"
  value: number;
}

/** All Portland, OR city-level metric points, chronologically ascending per
 * metric. Empty when the market tables do not exist yet. */
export async function fetchCityMetricPoints(): Promise<CityMetricPointRow[]> {
  try {
    return await withReadOnlyClient(async (client) => {
      const result = await client.query<{ metric: string; month: string; value: string }>(
        `
          SELECT metric, to_char(period_end, 'YYYY-MM') AS month, value::text AS value
          FROM market_metric_series
          WHERE source = $1 AND geo_type = 'city'
            AND region_name = 'Portland' AND state = 'OR'
          ORDER BY metric, period_end ASC
        `,
        [MARKET_SOURCE],
      );
      return result.rows
        .map((row) => ({ metric: row.metric, month: row.month, value: Number(row.value) }))
        .filter((row) => Number.isFinite(row.value));
    });
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

export interface NeighborhoodPointRow {
  regionId: string;
  name: string;
  month: string; // "YYYY-MM"
  value: number;
}

/** Portland, OR neighborhood ZHVI points for roughly the last 13 months
 * (enough to compute a year-over-year comparison), ascending per region. */
export async function fetchNeighborhoodZhviPoints(): Promise<NeighborhoodPointRow[]> {
  try {
    return await withReadOnlyClient(async (client) => {
      const result = await client.query<{
        region_id: string;
        region_name: string;
        month: string;
        value: string;
      }>(
        `
          SELECT region_id, region_name, to_char(period_end, 'YYYY-MM') AS month, value::text AS value
          FROM market_metric_series
          WHERE source = $1 AND metric = 'zhvi_sfr' AND geo_type = 'neighborhood'
            AND city = 'Portland' AND state = 'OR'
            AND period_end >= COALESCE(
              (
                SELECT max(period_end) - interval '400 days'
                FROM market_metric_series
                WHERE source = $1 AND metric = 'zhvi_sfr' AND geo_type = 'neighborhood'
                  AND city = 'Portland' AND state = 'OR'
              ),
              '1900-01-01'::date
            )
          ORDER BY region_name ASC, period_end ASC
        `,
        [MARKET_SOURCE],
      );
      return result.rows
        .map((row) => ({
          regionId: row.region_id,
          name: row.region_name,
          month: row.month,
          value: Number(row.value),
        }))
        .filter((row) => Number.isFinite(row.value));
    });
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

export interface LastIngestRun {
  finishedAt: string | null;
  status: string;
}

/** Most recent ingest run, or null when none has ever been recorded. */
export async function fetchLastIngestRun(): Promise<LastIngestRun | null> {
  try {
    return await withReadOnlyClient(async (client) => {
      const result = await client.query<{ finished_at: string | null; status: string }>(
        `
          SELECT finished_at, status
          FROM market_ingest_runs
          WHERE source = $1
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [MARKET_SOURCE],
      );
      const row = result.rows[0];
      return row ? { finishedAt: row.finished_at, status: row.status } : null;
    });
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

export interface PreferenceMatchCounts {
  matching: number;
  total: number;
}

// jsonb year_built values are not guaranteed to be numeric-shaped, so cast
// defensively exactly like lib/queries.ts does for the tracker view.
const SAFE_YEAR_BUILT =
  "CASE WHEN jsonb_typeof(pc.year_built) = 'number' THEN (pc.year_built #>> '{}')::numeric ELSE NULL END";

/**
 * Counts tracked houses in the property store that match the observed
 * search criteria. This intentionally reads only the tracked/researched
 * dataset — it says nothing about citywide availability.
 */
export async function fetchPreferenceMatchCounts(criteria: {
  maxPrice: number;
  minYearBuilt: number;
  maxYearBuilt: number;
}): Promise<PreferenceMatchCounts> {
  return withReadOnlyClient(async (client) => {
    const result = await client.query<{ matching: string; total: string }>(
      `
        SELECT
          count(*)::text AS total,
          count(*) FILTER (
            WHERE latest_price IS NOT NULL AND latest_price <= $1
              AND year_built IS NOT NULL AND year_built BETWEEN $2 AND $3
          )::text AS matching
        FROM (
          SELECT pc.latest_price AS latest_price, ${SAFE_YEAR_BUILT} AS year_built
          FROM property_current pc
          WHERE pc.track = 'house'
        ) houses
      `,
      [criteria.maxPrice, criteria.minYearBuilt, criteria.maxYearBuilt],
    );
    const row = result.rows[0];
    return {
      matching: Number(row?.matching ?? "0"),
      total: Number(row?.total ?? "0"),
    };
  });
}
