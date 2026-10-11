import type { PropertyTrack } from "./track";
import { DatabaseUnavailableError } from "./db";
import {
  buildNeighborhoodRows,
  buildPreferenceMatchNote,
  classifyStaleness,
  preferenceCriteriaFromEnv,
} from "./market";
import {
  fetchCityMetricPoints,
  fetchLastIngestRun,
  fetchNeighborhoodZhviPoints,
  fetchPreferenceMatchCounts,
} from "./market-queries";
import type { MarketMetricSeries, MarketResponse, MarketStaleness } from "./types";

export const MARKET_SOURCE_NOTE =
  "Source: official free Zillow Research monthly CSVs (city-level Portland, OR single-family " +
  "metrics and neighborhood-level SFR ZHVI). ZHVI is Zillow's smoothed, seasonally adjusted " +
  "typical home value for the middle price tier \u2014 it is not an average price, a list price, " +
  "a sale price, or filtered to the user’s preferences. Data is published monthly by Zillow and " +
  "only refreshes here when the market-ingest job runs.";

/** Display registry for the city-level metrics the ingestion script loads.
 * The `metric` keys must stay in sync with scripts/ingest-zillow.mjs. */
export const CITY_METRIC_REGISTRY: Array<{
  metric: string;
  label: string;
  description: string;
  unit: "count" | "usd";
}> = [
  {
    metric: "inventory_sfr",
    label: "Active for-sale inventory",
    description:
      "Zillow Research: monthly count of unique single-family listings active at any time in the month, Portland (city), smoothed.",
    unit: "count",
  },
  {
    metric: "new_listings_sfr",
    label: "New listings",
    description:
      "Zillow Research: monthly count of new single-family listings, Portland (city), smoothed.",
    unit: "count",
  },
  {
    metric: "median_list_price_sfr",
    label: "Median list price",
    description:
      "Zillow Research: monthly median list price of active single-family listings, Portland (city), smoothed. Asking prices, not closed sales.",
    unit: "usd",
  },
  {
    metric: "median_sale_price_sfr",
    label: "Median sale price",
    description:
      "Zillow Research: monthly median sale price of closed single-family sales, Portland (city), smoothed.",
    unit: "usd",
  },
];

function emptyMarketResponse(dbAvailable: boolean): MarketResponse {
  return {
    cityMetrics: CITY_METRIC_REGISTRY.map((entry) => ({
      ...entry,
      points: [],
      latest: null,
      staleness: "missing" as MarketStaleness,
    })),
    neighborhoods: { rows: [], latestMonth: null, staleness: "missing" },
    preferenceMatch: null,
    meta: {
      generatedAt: new Date().toISOString(),
      dbAvailable,
      dataAvailable: false,
      lastIngest: null,
      sourceNote: MARKET_SOURCE_NOTE,
    },
  };
}

/**
 * Builds the Portland Market payload. Mirrors buildDashboardResponse's
 * failure contract: database unavailability yields a well-formed empty
 * response with `meta.dbAvailable = false` instead of a thrown error, and
 * empty market tables yield `meta.dataAvailable = false`.
 */
export async function buildMarketResponse(track: PropertyTrack = "house"): Promise<MarketResponse> {
  if (track === "plex") {
    const empty = emptyMarketResponse(true);
    return { ...empty, cityMetrics: [], meta: { ...empty.meta, sourceNote: "Plex market data is not available. Existing market series cover single-family houses only." } };
  }
  const now = new Date();
  const criteria = preferenceCriteriaFromEnv(process.env);

  let cityPoints;
  let neighborhoodPoints;
  let lastIngest;
  try {
    [cityPoints, neighborhoodPoints, lastIngest] = await Promise.all([
      fetchCityMetricPoints(),
      fetchNeighborhoodZhviPoints(),
      fetchLastIngestRun(),
    ]);
  } catch (err) {
    if (!(err instanceof DatabaseUnavailableError)) {
      console.error("[market] query failure:", err instanceof Error ? err.message : err);
    }
    return emptyMarketResponse(false);
  }

  // The preference-match summary reads the property store, which can fail
  // independently of the market tables; degrade to null rather than hiding
  // the market data.
  let preferenceMatch: MarketResponse["preferenceMatch"] = null;
  try {
    const counts = await fetchPreferenceMatchCounts(criteria);
    preferenceMatch = {
      matching: counts.matching,
      total: counts.total,
      note: buildPreferenceMatchNote(counts.matching, counts.total, criteria),
      criteria,
    };
  } catch (err) {
    console.error("[market] preference-match failure:", err instanceof Error ? err.message : err);
  }

  const pointsByMetric = new Map<string, Array<{ month: string; value: number }>>();
  for (const point of cityPoints) {
    const list = pointsByMetric.get(point.metric) ?? [];
    list.push({ month: point.month, value: point.value });
    pointsByMetric.set(point.metric, list);
  }

  const cityMetrics: MarketMetricSeries[] = CITY_METRIC_REGISTRY.map((entry) => {
    const points = pointsByMetric.get(entry.metric) ?? [];
    const latest = points.length > 0 ? points[points.length - 1] : null;
    return {
      ...entry,
      points,
      latest,
      staleness: classifyStaleness(latest ? `${latest.month}-28` : null, now),
    };
  });

  const neighborhoodRows = buildNeighborhoodRows(neighborhoodPoints);
  const neighborhoodLatestMonth =
    neighborhoodRows.length > 0
      ? neighborhoodRows.reduce(
          (max, row) => (row.latestMonth > max ? row.latestMonth : max),
          neighborhoodRows[0].latestMonth,
        )
      : null;

  const dataAvailable = cityPoints.length > 0 || neighborhoodPoints.length > 0;

  return {
    cityMetrics,
    neighborhoods: {
      rows: neighborhoodRows,
      latestMonth: neighborhoodLatestMonth,
      staleness: classifyStaleness(neighborhoodLatestMonth ? `${neighborhoodLatestMonth}-28` : null, now),
    },
    preferenceMatch,
    meta: {
      generatedAt: now.toISOString(),
      dbAvailable: true,
      dataAvailable,
      lastIngest,
      sourceNote: MARKET_SOURCE_NOTE,
    },
  };
}
