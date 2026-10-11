// Decides which tracked houses are "rejected" from a raw feed of
// property_interactions decision rows. Pure and dependency-free (mirrors
// lib/photos.ts) so the semantics below are unit-testable without a
// database: only an explicit human rejection decision counts, and a later
// non-rejecting decision always restores the property.
//
// Deliberately NOT rejection: automated SKIP verdicts, boundary exclusions
// ("outside boundary"), budget-parking notes, color-coded classifications
// from scheduled digests, or any collection/watchlist membership change.
// None of those verdict strings ever equal "reject"/"rejected", so none of
// them can mark a property rejected under isRejectionVerdict below.

import type { HouseRecord, RejectedHouseRecord } from "./types";

/** One raw property_interactions row with a non-empty verdict. */
export interface DecisionRow {
  propertyId: string;
  verdict: string | null;
  note: string | null;
  occurredAt: string | null;
}

export interface RejectionInfo {
  reason: string | null;
  at: string | null;
}

const REJECTION_VERDICTS = new Set(["reject", "rejected"]);

/** Hard cap on user-typed rejection reasons — the single limit shared by
 * the list confirm, the map reject dialog, and the /api/funnel/move
 * validation (lib/funnel.ts imports this), so the UI can never produce a
 * note the endpoint refuses. */
export const MAX_REJECTION_NOTE_LENGTH = 500;

/**
 * Normalizes a user-typed rejection reason for the shared funnel-move
 * rejection workflow: trimmed, capped at MAX_REJECTION_NOTE_LENGTH, and
 * empty becomes null ("no reason recorded"). Mirrors exactly what
 * parseFunnelMoveRequest accepts.
 */
export function sanitizeRejectionNote(raw: string): string | null {
  const trimmed = raw.trim().slice(0, MAX_REJECTION_NOTE_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

/** True only for the literal decision text that means "reject this
 * property" (case-insensitive, whitespace-trimmed). Every other verdict —
 * including SKIP, color codes, "outside boundary", "parked-over-budget" —
 * is left alone; it never causes rejection. */
export function isRejectionVerdict(verdict: string | null | undefined): boolean {
  if (!verdict) return false;
  return REJECTION_VERDICTS.has(verdict.trim().toLowerCase());
}

function occurredAtMillis(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * For each property, finds the single most recent decision (by occurred_at,
 * with input order as a stable tiebreaker for same-instant rows) among the
 * supplied non-empty-verdict interaction rows, and returns rejection status
 * derived from that one latest decision only. Earlier rejections are
 * preserved in history but stop counting the moment any later decision with
 * a different verdict is recorded — that is the only "un-reject" mechanism,
 * so a later positive reconsideration always restores the property.
 */
export function computeRejections(rows: DecisionRow[]): Map<string, RejectionInfo | null> {
  const latestByProperty = new Map<string, { row: DecisionRow; time: number }>();

  // Later array position wins ties on identical occurred_at, so callers can
  // pass rows pre-sorted by insertion order as a deterministic tiebreaker.
  for (const row of rows) {
    const time = occurredAtMillis(row.occurredAt);
    const existing = latestByProperty.get(row.propertyId);
    if (!existing || time >= existing.time) {
      latestByProperty.set(row.propertyId, { row, time });
    }
  }

  const result = new Map<string, RejectionInfo | null>();
  for (const [propertyId, latest] of latestByProperty) {
    result.set(
      propertyId,
      isRejectionVerdict(latest.row.verdict) ? { reason: latest.row.note ?? null, at: latest.row.occurredAt } : null,
    );
  }
  return result;
}

// ── Archive ordering ─────────────────────────────────────────────────────────

/** The subset of RejectedHouseRecord the archive ordering depends on, so
 * the comparator is testable without building full house records. */
export interface RejectionOrderable {
  id: string;
  address: string;
  rejectionAt: string | null;
}

/**
 * Newest rejection first. Houses without a parseable rejection timestamp
 * sort after every dated rejection (they are still rejected — only the
 * date is unrecorded), and ties fall back to address ascending then id so
 * the archive order is fully deterministic.
 */
export function compareByRejectionRecency(a: RejectionOrderable, b: RejectionOrderable): number {
  const aMs = occurredAtMillis(a.rejectionAt);
  const bMs = occurredAtMillis(b.rejectionAt);
  if (aMs !== bMs) return aMs < bMs ? 1 : -1;
  const byAddress = a.address.localeCompare(b.address);
  if (byAddress !== 0) return byAddress;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Returns a new array sorted by compareByRejectionRecency; the input is
 * never mutated. */
export function sortByRejectionRecency<T extends RejectionOrderable>(houses: T[]): T[] {
  return [...houses].sort(compareByRejectionRecency);
}

export interface RejectionPartition {
  active: HouseRecord[];
  rejected: RejectedHouseRecord[];
}

/**
 * Splits houses into the normally-visible set and the rejected archive set
 * using the per-property rejection map from computeRejections. A house with
 * no entry in the map (no explicit decision at all) is always active.
 */
export function partitionByRejection(houses: HouseRecord[], rejections: Map<string, RejectionInfo | null>): RejectionPartition {
  const active: HouseRecord[] = [];
  const rejected: RejectedHouseRecord[] = [];
  for (const house of houses) {
    const info = rejections.get(house.id) ?? null;
    if (info) {
      rejected.push({ ...house, rejectionReason: info.reason, rejectionAt: info.at });
    } else {
      active.push(house);
    }
  }
  return { active, rejected };
}
