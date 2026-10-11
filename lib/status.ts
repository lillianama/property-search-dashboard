// Canonical display-status resolution for tracked houses.
//
// The property store keeps every raw status observation in
// property_listing_events with full provenance, and nothing in this module
// ever rewrites those facts. The problem it solves is purely one of
// *display*: RentCast-backed availability checkers (watchlist-status-check,
// rentcast-* weekly scans, workspace-state mirrors, tour-shortlist
// enrichment) can only see whether a listing is still visible in an active
// feed. When a house goes pending/under contract it disappears from those
// feeds, so the checkers keep appending "Inactive" rows every day — burying
// an explicit Pending observation under newer generic noise. The naive
// "latest status wins" rule (what property_current.latest_status does) then
// reports Inactive for houses that are actually pending.
//
// Resolution semantics (exact precedence, unit-tested below in status.test.ts):
//
// 1. Every status-bearing event is normalized into a status class:
//    active / pending / sold / inactive. Events whose status cannot be
//    classified (or is blank) carry no evidence and are ignored.
// 2. Events are ordered by "effective date" — event_date when the source
//    published one, otherwise the date the event was observed — with
//    observed_at and then row id as deterministic tie-breakers. This is the
//    same ordering spine property_current uses, so behavior only diverges
//    where rule 4 applies.
// 3. An event is SPECIFIC evidence unless it is an inactive-class status
//    from a generic availability source. Generic "Inactive" only means "no
//    longer visible as an active listing" and cannot distinguish
//    pending / sold / withdrawn.
// 4. The latest event overall decides the display status, EXCEPT when that
//    latest event is a generic inactive. In that case the latest SPECIFIC
//    event is consulted: if it is pending-class, the house displays Pending
//    (the generic inactive corroborates a pending listing vanishing from
//    active feeds rather than contradicting it). Any other latest specific
//    evidence — or none at all — displays an honest Inactive.
// 5. Pending is therefore never permanent: any later specific transition
//    (an authoritative Active relist, a recorded Sold/Closed, an explicit
//    Off Market/Withdrawn from a listing source) becomes the latest
//    specific/overall event and wins.
//
// Known limitation, documented rather than hidden: once a generic checker
// reports Inactive, an *older* specific Active or Sold does not resurface
// as the display status (the listing demonstrably left the active feed, and
// historic assessor sale records from years past must not masquerade as a
// current "Sold"). Recorded sales remain visible through the dedicated
// sold price/date fields.

import type { DisplayStatus } from "./types";

export type StatusClass = "active" | "pending" | "sold" | "inactive" | "unverified";

/** One provenance-safe status observation from property_listing_events.
 * Deliberately excludes price, MLS numbers, and raw payloads. */
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
  if (!source) return true; // no provenance → never treat as authoritative
  const normalized = source.trim().toLowerCase();
  return GENERIC_AVAILABILITY_SOURCES.has(normalized) || normalized.startsWith("rentcast");
}

interface ClassifiedEvent {
  cls: StatusClass;
  source: string | null;
  effectiveDate: string;
  observedMs: number;
  id: number;
}

/** Specific evidence asserts a definite state. The only non-specific
 * (generic) evidence is an inactive-class status from a generic
 * availability source — see the module comment. */
function isSpecificEvidence(event: ClassifiedEvent): boolean {
  return !(
    (event.cls === "inactive" || event.cls === "unverified")
    && isGenericAvailabilitySource(event.source)
  );
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}/;

function toClassified(event: StatusEventRow): ClassifiedEvent | null {
  const cls = classifyStatus(event.status);
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

  const latest = classified[0];
  if (isSpecificEvidence(latest)) return CLASS_LABELS[latest.cls];

  // Latest evidence is a generic non-active signal: only explicit pending evidence
  // that no later specific transition has superseded may rescue it.
  const latestSpecific = classified.find(isSpecificEvidence);
  if (latestSpecific && latestSpecific.cls === "pending") return "Pending";
  return latest.cls === "unverified" ? "Unverified" : "Inactive";
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
