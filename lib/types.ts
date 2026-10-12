// Shape of the non-sensitive fields the API is allowed to return. Never add
// owner names, mailing addresses, API keys, DB credentials, raw source
// payloads, or other observation fields beyond what is listed here without
// re-reviewing what the property store exposes.

export type BedroomSizeFlag = "critical" | "small" | "ok" | "unknown";

/** Canonical resolved display status (see lib/status.ts for the exact
 * source/recency precedence). This is a display-layer resolution over the
 * raw listing-event history — raw observations are never rewritten. */
export type DisplayStatus = "Active" | "Pending" | "Sold" | "Inactive" | "Unverified" | "Unknown";

/** The single current funnel category a house renders in on the My Search
 * list view. Derived from active property_collections memberships with
 * precedence top-contenders > to-tour > watchlist; houses with no funnel
 * membership at all fall back to "watchlist" as the catch-all without any
 * row being written for them. */
export type FunnelBucket = "top-contenders" | "to-tour" | "watchlist";

/** the user’s tri-state quick preference judgment. "unknown" is the default
 * for anything never evaluated — an unevaluated property is NEVER coerced
 * to "no". */
export type TriStateJudgment = "yes" | "no" | "unknown";

/** The three editor-controlled quick preference judgments. bedroomSizeOk is
 * a manual UI judgment overlay only: it never overwrites or falsifies the
 * canonical measured bedroomSizeFlag, which is always shown alongside. */
export interface QuickJudgments {
  bedroomSizeOk: TriStateJudgment;
  rentalIncome: TriStateJudgment;
  drumSpace: TriStateJudgment;
}

export const UNKNOWN_JUDGMENTS: QuickJudgments = {
  bedroomSizeOk: "unknown",
  rentalIncome: "unknown",
  drumSpace: "unknown",
};

export interface HouseRecord {
  backOnMarket?: { date: string; source: string } | null;
  saleComparison?: import("./lifecycle").SaleComparison;
  /** Present only on plex dashboard records; unknown facts remain null. */
  plexUnits?: import("./plex-units").PlexUnitSummary;
  id: string;
  address: string;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  finishedSqft: number | null;
  yearBuilt: number | null;
  latestPrice: number | null;
  /** Raw latest status string from property_current (latest status-bearing
   * listing event). Kept for transparency; UI should render displayStatus. */
  latestStatus: string | null;
  /** Canonical resolved status: explicit Pending/Under Contract evidence is
   * not buried by newer generic RentCast "Inactive" observations, while a
   * genuinely later specific transition (Active relist, Sold) still wins.
   * Resolved in lib/status.ts; falls back to a direct normalization of
   * latestStatus when the event history cannot be read. */
  displayStatus: DisplayStatus;
  latestSalePrice: number | null;
  latestSaleDate: string | null;
  bedroomSizeFlag: BedroomSizeFlag;
  smallestBedroomSqft: number | null;
  zillowUrl: string | null;
  /** Listing photo from persisted source data only; null means "no stored
   * photo" and the UI must show a placeholder, never a fabricated image. */
  photoUrl: string | null;
  /** Provenance of photoUrl (e.g. "rentcast-house-weekly"); null when no photo. */
  photoSource: string | null;
  /** Current funnel category (see FunnelBucket). Defaults to "watchlist". */
  funnelBucket: FunnelBucket;
  /** Durable global manual rank key (base-36 fractional index, see
   * lib/rank.ts), or null when the house has never been ranked. The rank
   * NUMBER is never displayed — order is communicated purely by row
   * position. Rank is global across every bucket and survives category
   * changes and rejection/restoration. */
  rankKey: string | null;
  /** the user’s editor-controlled quick preference judgments. Defaults to
   * all-unknown; never coerced to "no" for unevaluated properties. */
  judgments: QuickJudgments;
  /** Canonical "date added": when this property first entered the dashboard’s
   * property store (property_records.first_seen_at), NOT the listing date.
   * Normalized to an ISO timestamp; null when missing/unparseable. */
  dateAdded: string | null;
  /** ACTUAL recorded annual property tax from the property store (see
   * lib/tax.ts for the exact sources and selection precedence), or null
   * when no actual amount is recorded. Property taxes are never estimated
   * from the price: when this is null the card's PITI is explicitly
   * incomplete ("property tax unavailable"). */
  annualTaxAmount: number | null;
  /** Explicit tax year the amount is for (RentCast county bills publish
   * one); null when the source only dates the amount by observation. */
  annualTaxYear: number | null;
  /** ISO timestamp the amount was observed/recorded ("as of"); null when
   * unknown. */
  annualTaxAsOf: string | null;
  /** Provenance of annualTaxAmount (e.g. "rmls", "zillow",
   * "rentcast-property"); null when no recorded amount. */
  annualTaxSource: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** County assessor neighborhood exactly as persisted in the latest
   * portlandmaps-assessor raw observation (e.g. "HILLSDALE"); null when no
   * source-backed assessor neighborhood is recorded. Never geocoded or
   * inferred. */
  neighborhood: string | null;
  /** Zillow Research SFR ZHVI context for the assessor neighborhood, when
   * (and only when) the assessor name matches a Zillow region exactly or
   * via an explicit alias (lib/neighborhood.ts). Values are computed from
   * the same series as the Market view so both always agree. Null when the
   * neighborhood is unknown or unmatched — never guessed. */
  neighborhoodMarket: {
    regionId: string;
    regionName: string;
    latestMonth: string; // "YYYY-MM"
    latestValue: number;
    yearChangePct: number | null;
  } | null;
}

/** A house whose latest explicit decision in property_interactions is a
 * human rejection. Carries the same public fields as HouseRecord plus the
 * reason/date of that rejection, for the separate Rejected archive view. */
export interface RejectedHouseRecord extends HouseRecord {
  rejectionReason: string | null;
  rejectionAt: string | null;
}

export interface RejectedHousesResponse {
  properties: RejectedHouseRecord[];
  meta: {
    generatedAt: string;
    photoCoverageNote: string;
    streetViewNote: string;
    dbAvailable: boolean;
  };
}

export interface DashboardSummary {
  knownHouses: number;
  active: number;
  pending: number;
  inactive: number;
  unverified: number;
  sold: number;
  unknownStatus: number;
  medianLatestPrice: number | null;
  medianSalePrice: number | null;
  dataFreshness: string | null;
}

export interface DashboardResponse {
  summary: DashboardSummary;
  history: Array<{ month: string; eventCount: number; medianPrice: number | null }>;
  priceDistribution: Array<{ label: string; rangeStart: number; rangeEnd: number | null; count: number }>;
  statusDistribution: Array<{ status: string; count: number }>;
  properties: HouseRecord[];
  meta: {
    generatedAt: string;
    trackedPropertyTotal: number;
    coverageNote: string;
    /** Honest photo coverage: how many filtered houses have a stored photo.
     * Counts real persisted listing photos only — Street View fallback
     * imagery is never included in this figure. */
    photoCoverageNote: string;
    /** Separate, honest note about the Google Street View exterior fallback
     * shown for houses without a stored listing photo. Kept distinct from
     * photoCoverageNote so fallback imagery never inflates real coverage. */
    streetViewNote: string;
    dbAvailable: boolean;
  };
}

// ── Portland Market (Zillow Research) ───────────────────────────────────────

export type MarketStaleness = "fresh" | "stale" | "missing";

export interface MarketSeriesPoint {
  month: string; // "YYYY-MM"
  value: number;
}

export interface MarketMetricSeries {
  metric: string;
  label: string;
  /** Methodology/source description shown verbatim in the UI. */
  description: string;
  unit: "count" | "usd";
  points: MarketSeriesPoint[];
  latest: MarketSeriesPoint | null;
  staleness: MarketStaleness;
}

export interface NeighborhoodZhviRow {
  regionId: string;
  name: string;
  latestMonth: string; // "YYYY-MM"
  latestValue: number;
  yearAgoValue: number | null;
  yearChangePct: number | null;
}

export interface PreferenceMatchSummary {
  matching: number;
  total: number;
  note: string;
  criteria: {
    maxPrice: number;
    minYearBuilt: number;
    maxYearBuilt: number;
  };
}

export interface MarketResponse {
  cityMetrics: MarketMetricSeries[];
  neighborhoods: {
    rows: NeighborhoodZhviRow[];
    latestMonth: string | null;
    staleness: MarketStaleness;
  };
  preferenceMatch: PreferenceMatchSummary | null;
  meta: {
    generatedAt: string;
    dbAvailable: boolean;
    /** False when the market tables are empty (ingestion never ran). */
    dataAvailable: boolean;
    lastIngest: { finishedAt: string | null; status: string } | null;
    sourceNote: string;
  };
}
