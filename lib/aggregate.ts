// Pure data-normalization and aggregation helpers shared by API routes.
// Kept free of database and Next.js imports so they can be unit tested in
// isolation and reused consistently across KPIs, charts, and the table.

export type Nullish<T> = T | null | undefined;

/** Coerces a loosely-typed value (jsonb scalar, string, etc.) into a finite
 * number, or null when it cannot be trusted. Never throws. */
export function safeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Normalizes a possibly-null/blank status string to a display label,
 * explicitly surfacing "Unknown" rather than hiding missing data. */
export function normalizeStatus(status: Nullish<string>): string {
  const trimmed = status?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Unknown";
}

/** Median of the finite numbers in `values`, ignoring null/undefined/NaN.
 * Returns null when there is no usable data, never throws or divides by
 * zero. */
export function median(values: Array<Nullish<number>>): number | null {
  const nums = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 0) {
    return (nums[mid - 1] + nums[mid]) / 2;
  }
  return nums[mid];
}

/**
 * Normalizes property_records.first_seen_at into the canonical `dateAdded`
 * value: the moment the property entered the dashboard’s store (NOT the listing
 * date). Accepts either a string or the Date object node-postgres returns
 * for timestamptz columns. Returns a full ISO timestamp for deterministic
 * newest-first sorting, or null for missing/unparseable input — never a
 * guess.
 */
export function normalizeDateAdded(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface StatusCount {
  status: string;
  count: number;
}

/** Groups statuses (already normalized or raw) into counts, sorted by
 * descending count for stable chart rendering. */
export function buildStatusDistribution(statuses: Array<Nullish<string>>): StatusCount[] {
  const counts = new Map<string, number>();
  for (const raw of statuses) {
    const status = normalizeStatus(raw);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

export interface PriceBucket {
  label: string;
  rangeStart: number;
  rangeEnd: number | null;
  count: number;
}

/** Fixed histogram bin width: deterministic $25,000 buckets, never adaptive. */
export const PRICE_BUCKET_SIZE = 25_000;

/** Compact bin label: "$425k–$450k". Whole-thousand boundaries render as
 * integers; $25k boundaries always are, so no decimals appear in practice. */
function priceBucketLabel(rangeStart: number, rangeEnd: number): string {
  const k = (v: number) => {
    const thousands = v / 1000;
    return Number.isInteger(thousands) ? `$${thousands}k` : `$${thousands.toFixed(1)}k`;
  };
  return `${k(rangeStart)}\u2013${k(rangeEnd)}`;
}

/**
 * Buckets known prices into deterministic fixed $25,000 bins for a
 * histogram. Bins span ONLY the observed price range (first bin = the one
 * containing the minimum price, last bin = the one containing the maximum)
 * so sparse or high-priced datasets never render a huge empty tail from
 * $0. Every bin is half-open [start, end): a price exactly on a boundary
 * (e.g. $650,000) counts in the bin that STARTS there. Prices that are
 * null/undefined/non-finite/negative are excluded rather than guessed;
 * zero is a real (if odd) price and lands in the first bin.
 */
export function buildPriceDistribution(
  prices: Array<Nullish<number>>,
  bucketSize = PRICE_BUCKET_SIZE,
): PriceBucket[] {
  const finite = prices.filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0);
  if (finite.length === 0 || bucketSize <= 0) return [];

  const minPrice = Math.min(...finite);
  const maxPrice = Math.max(...finite);
  const firstIdx = Math.floor(minPrice / bucketSize);
  const lastIdx = Math.floor(maxPrice / bucketSize);

  const buckets: PriceBucket[] = [];
  for (let i = firstIdx; i <= lastIdx; i += 1) {
    const rangeStart = i * bucketSize;
    const rangeEnd = rangeStart + bucketSize;
    buckets.push({
      label: priceBucketLabel(rangeStart, rangeEnd),
      rangeStart,
      rangeEnd,
      count: 0,
    });
  }

  for (const price of finite) {
    buckets[Math.floor(price / bucketSize) - firstIdx].count += 1;
  }

  return buckets;
}

export interface ListingEventInput {
  month: string; // "YYYY-MM"
  price: Nullish<number>;
}

export interface MonthlyBucket {
  month: string;
  eventCount: number;
  medianPrice: number | null;
}

/** Groups listing events by their pre-computed calendar month into event
 * counts and median price, sorted chronologically ascending. This backs the
 * "tracked/researched dataset" history chart, not full MLS inventory. */
export function buildMonthlyHistory(events: ListingEventInput[]): MonthlyBucket[] {
  const byMonth = new Map<string, number[]>();
  for (const event of events) {
    if (!event.month) continue;
    const list = byMonth.get(event.month) ?? [];
    const price = safeNumber(event.price);
    if (price !== null) list.push(price);
    if (!byMonth.has(event.month)) byMonth.set(event.month, list);
  }

  // Ensure months with zero priced events but at least one raw event still
  // appear with a count. Rebuild counts separately from price lists.
  const countByMonth = new Map<string, number>();
  for (const event of events) {
    if (!event.month) continue;
    countByMonth.set(event.month, (countByMonth.get(event.month) ?? 0) + 1);
  }

  return Array.from(countByMonth.keys())
    .sort()
    .map((month) => ({
      month,
      eventCount: countByMonth.get(month) ?? 0,
      medianPrice: median(byMonth.get(month) ?? []),
    }));
}

export interface FreshnessInput {
  lastSeenAt: Nullish<string>;
}

/** Most recent `lastSeenAt` timestamp among the given rows, or null when
 * none are present/parseable. */
export function latestFreshness(rows: FreshnessInput[]): string | null {
  let latest: number | null = null;
  for (const row of rows) {
    if (!row.lastSeenAt) continue;
    const t = new Date(row.lastSeenAt).getTime();
    if (Number.isFinite(t) && (latest === null || t > latest)) {
      latest = t;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export interface StatusCountsSummary {
  active: number;
  pending: number;
  inactive: number;
  unverified: number;
  sold: number;
  unknown: number;
}

/** Case-insensitive tally of the handful of statuses the property store
 * actually produces, bucketing anything else under unknown. */
export function summarizeStatusCounts(statuses: Array<Nullish<string>>): StatusCountsSummary {
  const summary: StatusCountsSummary = { active: 0, pending: 0, inactive: 0, unverified: 0, sold: 0, unknown: 0 };
  for (const raw of statuses) {
    const status = normalizeStatus(raw).toLowerCase();
    if (status === "active") summary.active += 1;
    else if (status === "pending") summary.pending += 1;
    else if (status === "inactive") summary.inactive += 1;
    else if (status === "unverified") summary.unverified += 1;
    else if (status === "sold") summary.sold += 1;
    else summary.unknown += 1;
  }
  return summary;
}
