// Resolve the recorded listing timeline without modifying source history.
// Generic availability checks cannot undo Pending or Sold; an authoritative
// subsequent transition is required. Historic assessor sales without a prior
// listing cycle do not override newer generic availability observations.

import type { DisplayStatus } from "./types";

export type StatusClass = "active" | "pending" | "sold" | "inactive" | "unverified";

/** One provenance-safe status observation from property_listing_events.
 * Raw payloads and source references are excluded. Listing identity stays internal. */
export interface StatusEventRow {
  propertyId: string;
  status: string | null;
  source: string | null;
  /** "YYYY-MM-DD" when the source published an event date, else null. */
  eventDate: string | null;
  /** ISO timestamp of when dashboard recorded the observation. */
  observedAt: string | null;
  /** Row id, used only as a deterministic final tie-breaker. */
  id: number;
  /** Internal allowlist for sale/listing association; never raw payloads. */
  eventType?: string | null;
  price?: number | null;
  mlsNumber?: string | null;
}

const PENDING_STATUSES = new Set([
  "pending",
  "pending sale",
  "sale pending",
  "under contract",
  "active under contract",
  "contingent",
  "in contract",
  "offer accepted",
]);

const ACTIVE_STATUSES = new Set(["active", "for sale", "coming soon", "back on market"]);

const SOLD_STATUSES = new Set(["sold", "closed"]);

const INACTIVE_STATUSES = new Set([
  "inactive",
  "off market",
  "off the market",
  "withdrawn",
  "expired",
  "cancelled",
  "canceled",
  "delisted",
  "removed",
]);

const UNVERIFIED_STATUSES = new Set(["unverified", "unknown availability"]);

/** Normalizes a raw status string into a status class, or null when the
 * value carries no classifiable evidence (blank, null, unrecognized). */
export function classifyStatus(raw: string | null | undefined): StatusClass | null {
  const normalized = raw?.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!normalized) return null;
  if (PENDING_STATUSES.has(normalized)) return "pending";
  if (ACTIVE_STATUSES.has(normalized)) return "active";
  if (SOLD_STATUSES.has(normalized)) return "sold";
  if (INACTIVE_STATUSES.has(normalized)) return "inactive";
  if (UNVERIFIED_STATUSES.has(normalized)) return "unverified";
  return null;
}

// Sources whose "Inactive" is a generic availability signal (the listing is
// merely no longer visible in an active feed) rather than an explicit
// delisting assertion. Inspected from live property_listing_events data:
// watchlist-status-check and the rentcast-* scans are RentCast-backed,
// workspace-state and tour-shortlist mirror cached JSON snapshots.
const GENERIC_AVAILABILITY_SOURCES = new Set([
  "watchlist-status-check",
  "workspace-state",
  "tour-shortlist",
]);

export function isGenericAvailabilitySource(source: string | null | undefined): boolean {
  if (!source?.trim()) return true; // no provenance → never treat as authoritative
  const normalized = source.trim().toLowerCase();
  return GENERIC_AVAILABILITY_SOURCES.has(normalized) || normalized.startsWith("rentcast");
}

/** Explicit lifecycle event types also carry evidence when status is absent. */
export function classifyListingEvent(event: StatusEventRow): StatusClass | null {
  if (event.eventType === "sold") return "sold";
  return classifyStatus(event.status) ?? (event.eventType === "listed" ? "active" : classifyStatus(event.eventType));
}

interface ClassifiedEvent {
  cls: StatusClass;
  source: string | null;
  effectiveDate: string;
  observedMs: number;
  id: number;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function toClassified(event: StatusEventRow): ClassifiedEvent | null {
  const cls = classifyListingEvent(event);
  if (!cls) return null;

  const observedMs = event.observedAt ? new Date(event.observedAt).getTime() : Number.NaN;
  const observedDate =
    event.observedAt && DATE_ONLY_PATTERN.test(event.observedAt.trim())
      ? event.observedAt.trim().slice(0, 10)
      : null;
  const eventDate =
    event.eventDate && DATE_ONLY_PATTERN.test(event.eventDate.trim())
      ? event.eventDate.trim().slice(0, 10)
      : null;

  const effectiveDate = eventDate ?? observedDate;
  if (!effectiveDate) return null; // no usable point on the timeline

  return {
    cls,
    source: event.source,
    effectiveDate,
    observedMs: Number.isFinite(observedMs) ? observedMs : 0,
    id: event.id,
  };
}

/** Descending (latest-first) comparison: effective date, then observed_at,
 * then row id. ISO date strings compare correctly lexicographically. */
function compareLatestFirst(a: ClassifiedEvent, b: ClassifiedEvent): number {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? 1 : -1;
  if (a.observedMs !== b.observedMs) return b.observedMs - a.observedMs;
  return b.id - a.id;
}

const CLASS_LABELS: Record<StatusClass, DisplayStatus> = {
  active: "Active",
  pending: "Pending",
  sold: "Sold",
  inactive: "Inactive",
  unverified: "Unverified",
};

/**
 * Resolves the canonical display status for ONE property from its raw
 * status observations. See the module comment for the exact precedence.
 */
export function resolveDisplayStatus(events: StatusEventRow[]): DisplayStatus {
  const classified = events
    .map(toClassified)
    .filter((e): e is ClassifiedEvent => e !== null)
    .sort(compareLatestFirst);

  if (classified.length === 0) return "Unknown";

  // Replay in effective order. A generic Active observation can describe
  // availability, but cannot establish a return from Pending/Sold.
  let current: ClassifiedEvent | undefined;
  let sawListing = false;
  let lifecycleLocked = false;
  for (const event of [...classified].reverse()) {
    const generic = isGenericAvailabilitySource(event.source);
    // Pending/Sold are definite assertions even from a feed checker;
    // its generic availability/absence observations cannot undo them.
    if (lifecycleLocked && generic && (
      !event.source?.trim() || (event.cls !== "pending" && event.cls !== "sold")
    )) continue;
    if (event.cls === "active" || event.cls === "pending") sawListing = true;
    // Assessor and property-detail sales can be historical ownership facts.
    // Without a preceding listing cycle they do not lock out a later listing
    // observation. With no later listing, the recorded Sold status remains.
    const historicalSaleSource = event.source?.toLowerCase().includes("assessor")
      || event.source?.trim().toLowerCase() === "rentcast-property";
    current = event;
    lifecycleLocked = event.cls === "pending" || (
      event.cls === "sold" && (sawListing || !historicalSaleSource)
    );
  }
  return current ? CLASS_LABELS[current.cls] : "Unknown";
}

/** Resolves display statuses for many properties from a flat event list. */
export function resolveDisplayStatuses(rows: StatusEventRow[]): Map<string, DisplayStatus> {
  const byProperty = new Map<string, StatusEventRow[]>();
  for (const row of rows) {
    const list = byProperty.get(row.propertyId);
    if (list) list.push(row);
    else byProperty.set(row.propertyId, [row]);
  }
  const result = new Map<string, DisplayStatus>();
  for (const [propertyId, events] of byProperty) {
    result.set(propertyId, resolveDisplayStatus(events));
  }
  return result;
}

/**
 * Fallback used when the listing-event lookup fails: maps the raw
 * property_current.latest_status straight to a display label with no
 * pending rescue. Honest but less informed.
 */
export function displayStatusFromRaw(raw: string | null | undefined): DisplayStatus {
  const cls = classifyStatus(raw);
  return cls ? CLASS_LABELS[cls] : "Unknown";
}

/**
 * Applies the user's status filter against RESOLVED display statuses (so a
 * house rescued to Pending matches the Pending chip, not Inactive).
 * `statuses` is the parsed filter list; null/empty means "no filter".
 */
export function filterByDisplayStatus<T extends { displayStatus: DisplayStatus }>(
  houses: T[],
  statuses: string[] | null,
): T[] {
  if (!statuses || statuses.length === 0) return houses;
  const wanted = new Set(statuses.map((s) => s.trim().toLowerCase()));
  return houses.filter((house) => wanted.has(house.displayStatus.toLowerCase()));
}
