// The My Search list-view funnel: pure, dependency-free logic for deriving
// each house's single current funnel bucket from property_collections
// memberships, planning what a bucket move must write, validating move
// requests, and applying optimistic client-side state. Everything here is
// unit-testable without a database or browser; the actual SQL lives in
// lib/funnel-writes.ts and the HTTP surface in app/api/funnel/move.

import { compareRankKeys, isValidRankKey, planRankBootstrap, type RankableHouse } from "./rank";
import { MAX_REJECTION_NOTE_LENGTH } from "./rejection";
import type { FunnelBucket, HouseRecord } from "./types";

// ── Canonical collection names (inspected from the live property store) ─────
//
// property_collections rows use these `collection` values for houses:
//   "top-contenders"  — top contenders (canonical, hyphenated)
//   "tour-shortlist"  — to-tour shortlist (canonical; all recent writes)
//   "tour_shortlist"  — legacy underscore spelling of the same shortlist
//   "watchlist"       — the catch-all
// New writes always use the canonical hyphenated names; the legacy
// underscore spelling is still honored on read so no history is rewritten.

export const COLLECTION_TOP_CONTENDERS = "top-contenders";
export const COLLECTION_TOUR_SHORTLIST = "tour-shortlist";
export const COLLECTION_TOUR_SHORTLIST_LEGACY = "tour_shortlist";
export const COLLECTION_WATCHLIST = "watchlist";

/** Every collection name that participates in the funnel, in any spelling. */
export const FUNNEL_COLLECTIONS = [
  COLLECTION_TOP_CONTENDERS,
  COLLECTION_TOUR_SHORTLIST,
  COLLECTION_TOUR_SHORTLIST_LEGACY,
  COLLECTION_WATCHLIST,
] as const;

/** Buckets in their fixed top-to-bottom display (and precedence) order. */
export const FUNNEL_BUCKETS: FunnelBucket[] = ["top-contenders", "to-tour", "watchlist"];

export const FUNNEL_BUCKET_LABELS: Record<FunnelBucket, string> = {
  "top-contenders": "Top contenders",
  "to-tour": "To tour",
  watchlist: "Watchlist",
};

/** Maps a raw property_collections.collection value to the funnel bucket it
 * belongs to, or null for collections outside the funnel (e.g. "dismissed"). */
export function bucketForCollection(collection: string): FunnelBucket | null {
  switch (collection) {
    case COLLECTION_TOP_CONTENDERS:
      return "top-contenders";
    case COLLECTION_TOUR_SHORTLIST:
    case COLLECTION_TOUR_SHORTLIST_LEGACY:
      return "to-tour";
    case COLLECTION_WATCHLIST:
      return "watchlist";
    default:
      return null;
  }
}

/** The canonical collection name a bucket move writes. Never the legacy
 * underscore spelling. */
export function collectionForBucket(bucket: FunnelBucket): string {
  switch (bucket) {
    case "top-contenders":
      return COLLECTION_TOP_CONTENDERS;
    case "to-tour":
      return COLLECTION_TOUR_SHORTLIST;
    case "watchlist":
      return COLLECTION_WATCHLIST;
  }
}

/** One active property_collections membership row, as read from the store. */
export interface ActiveCollectionRow {
  propertyId: string;
  collection: string;
}

/**
 * Derives each property's single current funnel bucket from its active
 * collection memberships. When a property has multiple active memberships
 * (real data does), precedence is top-contenders > to-tour > watchlist.
 * Properties with no funnel membership at all get no entry here; callers
 * render them in the watchlist catch-all WITHOUT writing anything.
 */
export function deriveFunnelBuckets(rows: ActiveCollectionRow[]): Map<string, FunnelBucket> {
  const precedence: Record<FunnelBucket, number> = { "top-contenders": 0, "to-tour": 1, watchlist: 2 };
  const result = new Map<string, FunnelBucket>();
  for (const row of rows) {
    const bucket = bucketForCollection(row.collection);
    if (!bucket) continue;
    const existing = result.get(row.propertyId);
    if (!existing || precedence[bucket] < precedence[existing]) {
      result.set(row.propertyId, bucket);
    }
  }
  return result;
}

// ── Move planning ────────────────────────────────────────────────────────────

export type FunnelAction = FunnelBucket | "reject";

export const FUNNEL_ACTIONS: FunnelAction[] = ["top-contenders", "to-tour", "watchlist", "reject"];

export interface FunnelMovePlan {
  /** Canonical collection name to upsert as active, or null (reject). */
  activate: string | null;
  /** Currently-active collection names to deactivate (active=false,
   * removed_at=now()). Rows are never deleted, so history survives. */
  deactivate: string[];
  /** Whether an explicit rejection interaction must be inserted. */
  insertRejection: boolean;
}

/**
 * Plans exactly which property_collections rows a move must touch, given the
 * property's currently-active collection names. Rules:
 *
 * - Moving to a bucket activates that bucket's canonical collection (skipped
 *   when an equivalent membership — either tour spelling — is already
 *   active) and deactivates every active funnel membership belonging to a
 *   DIFFERENT bucket, resolving pre-existing multiple memberships.
 * - Non-funnel collections (e.g. "dismissed") are never touched.
 * - Reject activates nothing and deactivates active top-contenders/to-tour
 *   memberships (the elevated funnel placements). Watchlist membership is
 *   left as-is: rejection visibility is decided solely by the interaction
 *   verdict, and preserving the row means a later reconsideration restores
 *   the house exactly where it was.
 */
export function computeMovePlan(activeCollections: string[], action: FunnelAction): FunnelMovePlan {
  const activeFunnel = activeCollections.filter((c) => bucketForCollection(c) !== null);

  if (action === "reject") {
    return {
      activate: null,
      deactivate: activeFunnel.filter((c) => {
        const bucket = bucketForCollection(c);
        return bucket === "top-contenders" || bucket === "to-tour";
      }),
      insertRejection: true,
    };
  }

  const alreadyInBucket = activeFunnel.some((c) => bucketForCollection(c) === action);
  return {
    activate: alreadyInBucket ? null : collectionForBucket(action),
    deactivate: activeFunnel.filter((c) => bucketForCollection(c) !== action),
    insertRejection: false,
  };
}

// ── Request validation (used by the narrow mutation endpoint) ────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const MAX_NOTE_LENGTH = MAX_REJECTION_NOTE_LENGTH;

export interface FunnelMoveRequest {
  propertyId: string;
  action: FunnelAction;
  note: string | null;
  /** Requested ordering position: the tracked house that should sit
   * immediately ABOVE the moved house in global rank order (null = insert
   * at the very top of the requested position's neighborhood). Only
   * meaningful for bucket moves; rejects never carry neighbors because
   * rejection deliberately preserves the prior rank. */
  afterId: string | null;
  /** The tracked house that should sit immediately BELOW the moved house
   * (null = insert at the very bottom). */
  beforeId: string | null;
}

export type ParsedFunnelMoveRequest =
  | { ok: true; request: FunnelMoveRequest }
  | { ok: false; error: string };

/**
 * Strictly validates a funnel-move request body. Only a UUID propertyId, an
 * allowlisted action, optional UUID rank neighbors (bucket moves only), and
 * an optional short note (rejects only) are ever accepted — there is no
 * generic column/table/SQL surface here at all. Neighbor ids must differ
 * from the moved house and from each other; whether they actually exist
 * (and their rank keys) is verified transactionally in the write path so
 * stale/concurrent moves fail safely instead of mis-ordering.
 */
export function parseFunnelMoveRequest(body: unknown): ParsedFunnelMoveRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = body as Record<string, unknown>;

  const propertyId = record.propertyId;
  if (typeof propertyId !== "string" || !isValidUuid(propertyId)) {
    return { ok: false, error: "propertyId must be a UUID" };
  }

  const action = record.action;
  if (typeof action !== "string" || !FUNNEL_ACTIONS.includes(action as FunnelAction)) {
    return { ok: false, error: "action must be one of: " + FUNNEL_ACTIONS.join(", ") };
  }

  let note: string | null = null;
  if (record.note !== undefined && record.note !== null) {
    if (typeof record.note !== "string") {
      return { ok: false, error: "note must be a string" };
    }
    if (action !== "reject") {
      return { ok: false, error: "note is only accepted for reject" };
    }
    const trimmed = record.note.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) {
      return { ok: false, error: `note must be at most ${MAX_NOTE_LENGTH} characters` };
    }
    note = trimmed.length > 0 ? trimmed : null;
  }

  const parseNeighbor = (key: "afterId" | "beforeId"): string | null | { error: string } => {
    const value = record[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !isValidUuid(value)) {
      return { error: `${key} must be a UUID or null` };
    }
    if (action === "reject") {
      return { error: `${key} is not accepted for reject (rejection preserves the prior rank)` };
    }
    return value.toLowerCase();
  };

  const afterId = parseNeighbor("afterId");
  if (afterId !== null && typeof afterId === "object") return { ok: false, error: afterId.error };
  const beforeId = parseNeighbor("beforeId");
  if (beforeId !== null && typeof beforeId === "object") return { ok: false, error: beforeId.error };

  const id = propertyId.toLowerCase();
  if (afterId === id || beforeId === id) {
    return { ok: false, error: "afterId/beforeId must differ from propertyId" };
  }
  if (afterId !== null && afterId === beforeId) {
    return { ok: false, error: "afterId and beforeId must differ" };
  }

  return {
    ok: true,
    request: { propertyId: id, action: action as FunnelAction, note, afterId, beforeId },
  };
}

/**
 * Same-origin check for the mutation endpoint: browsers send an Origin
 * header on cross-origin (and same-origin non-GET) requests, so any Origin
 * that does not match the host this request arrived on is refused. Requests
 * without an Origin header (curl, server-side) are allowed — the dashboard
 * already sits behind Authelia, this guard exists to stop cross-site browser
 * requests from riding an authenticated session.
 */
export function isSameOriginRequest(originHeader: string | null, requestHost: string | null): boolean {
  if (originHeader === null || originHeader === "") return true;
  if (!requestHost) return false;
  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    return false;
  }
  return originHost.toLowerCase() === requestHost.toLowerCase();
}

// ── Optimistic client-side state (shared by map and list views) ──────────────

/** One optimistic in-list placement from a drag/keyboard move: the house
 * now renders in `bucket`, positioned by its display neighbors at drop
 * time. `seq` preserves the order multiple placements were made in so they
 * replay deterministically. */
export interface LocalPlacement {
  bucket: FunnelBucket;
  afterId: string | null;
  beforeId: string | null;
  seq: number;
}

export interface LocalFunnelState {
  /** Optimistic bucket overrides from in-flight or confirmed moves. */
  moves: Record<string, FunnelBucket>;
  /** Optimistic ordering placements from in-flight or confirmed moves. */
  placements: Record<string, LocalPlacement>;
  /** Optimistically rejected property ids (removed from both views). */
  rejectedIds: string[];
}

export const EMPTY_LOCAL_FUNNEL_STATE: LocalFunnelState = { moves: {}, placements: {}, rejectedIds: [] };

/**
 * Applies optimistic local moves/rejections on top of the server payload so
 * the map and list views stay coherent without a reload. Rejected houses
 * disappear from BOTH views immediately; bucket overrides only change
 * funnelBucket (ordering placements are applied later, in groupByBucket).
 * Pure, so rollback is just "apply the previous state".
 */
export function applyLocalFunnelState(properties: HouseRecord[], state: LocalFunnelState): HouseRecord[] {
  const rejected = new Set(state.rejectedIds);
  const result: HouseRecord[] = [];
  for (const property of properties) {
    if (rejected.has(property.id)) continue;
    const override = state.moves[property.id];
    result.push(override && override !== property.funnelBucket ? { ...property, funnelBucket: override } : property);
  }
  return result;
}

/**
 * Legacy/bootstrap ordering within a bucket: newest dateAdded (when the
 * house entered the dashboard’s store) first. Houses without a usable dateAdded sort
 * after every dated house, and ties (or two undated houses) fall back to
 * address ascending so the order is fully deterministic. ISO timestamps
 * compare correctly as strings, so no Date parsing is needed here.
 */
export function compareByDateAddedDesc(a: HouseRecord, b: HouseRecord): number {
  if (a.dateAdded !== b.dateAdded) {
    if (a.dateAdded === null) return 1;
    if (b.dateAdded === null) return -1;
    return a.dateAdded < b.dateAdded ? 1 : -1;
  }
  return a.address.localeCompare(b.address);
}

/** Fixed precedence index used both for display and for deterministic rank
 * bootstrap: top-contenders first, watchlist last. */
export function bucketPrecedence(bucket: FunnelBucket): number {
  return FUNNEL_BUCKETS.indexOf(bucket);
}

/**
 * Global-rank ordering within a bucket. Houses WITH a valid persisted rank
 * key sort by that key ascending (smaller = higher). Houses without one
 * sort ABOVE every ranked house, newest dateAdded first — exactly where the
 * deterministic server-side bootstrap (lib/rank.ts planRankBootstrap) will
 * place them when a first move persists their rank, so the display never
 * jumps when ranks materialize.
 */
export function compareByGlobalRank(a: HouseRecord, b: HouseRecord): number {
  const aKey = a.rankKey !== null && isValidRankKey(a.rankKey) ? a.rankKey : null;
  const bKey = b.rankKey !== null && isValidRankKey(b.rankKey) ? b.rankKey : null;
  if (aKey !== null && bKey !== null) return compareRankKeys(aKey, bKey);
  if (aKey === null && bKey === null) return compareByDateAddedDesc(a, b);
  return aKey === null ? -1 : 1;
}

/** Adapts HouseRecords to the shape lib/rank.ts bootstraps from. Exposed so
 * the write path and tests share exactly one adaptation. */
export function toRankableHouses(properties: HouseRecord[]): RankableHouse[] {
  return properties.map((p) => ({
    id: p.id,
    bucketPrecedence: bucketPrecedence(p.funnelBucket),
    dateAdded: p.dateAdded,
    address: p.address,
    rankKey: p.rankKey,
  }));
}

export { planRankBootstrap };

/**
 * Groups houses into display buckets ordered by the global manual rank
 * (see compareByGlobalRank), then replays optimistic placements — each
 * placed house is pulled out and re-inserted next to its recorded display
 * neighbors, so in-flight drags render exactly where they were dropped.
 * Bucket order/precedence itself is unchanged. Every house lands somewhere:
 * funnelBucket defaults to "watchlist".
 */
export function groupByBucket(
  properties: HouseRecord[],
  placements: Record<string, LocalPlacement> = {},
): Record<FunnelBucket, HouseRecord[]> {
  const groups: Record<FunnelBucket, HouseRecord[]> = { "top-contenders": [], "to-tour": [], watchlist: [] };
  for (const property of properties) {
    groups[property.funnelBucket].push(property);
  }
  for (const bucket of FUNNEL_BUCKETS) {
    groups[bucket].sort(compareByGlobalRank);
  }

  const ordered = Object.entries(placements)
    .map(([id, placement]) => ({ id, placement }))
    .sort((a, b) => a.placement.seq - b.placement.seq);

  for (const { id, placement } of ordered) {
    let moved: HouseRecord | undefined;
    for (const bucket of FUNNEL_BUCKETS) {
      const idx = groups[bucket].findIndex((h) => h.id === id);
      if (idx !== -1) {
        moved = groups[bucket].splice(idx, 1)[0];
        break;
      }
    }
    if (!moved) continue; // house no longer visible (filtered/rejected)
    const target = groups[placement.bucket];
    let insertAt: number;
    const afterIdx = placement.afterId ? target.findIndex((h) => h.id === placement.afterId) : -1;
    if (afterIdx !== -1) {
      insertAt = afterIdx + 1;
    } else {
      const beforeIdx = placement.beforeId ? target.findIndex((h) => h.id === placement.beforeId) : -1;
      if (beforeIdx !== -1) insertAt = beforeIdx;
      else insertAt = placement.afterId === null ? 0 : target.length;
    }
    target.splice(insertAt, 0, moved);
  }

  return groups;
}
