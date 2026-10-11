import type { PropertyTrack } from "./track";
// The funnel write path: executes one validated funnel bucket move — and
// its global-rank placement — as a single atomic transaction. Statements
// here are a fixed allowlist: deactivate/activate funnel rows in
// property_collections, insert provenance rows into property_interactions,
// and insert APPEND-ONLY rank revisions into property_funnel_ranks — all
// parameterized, never touching any other table, column, or property.
// Nothing is ever deleted and no existing row's added_at/source/note is
// rewritten, so the full membership, decision, and rank history stays
// intact. What to write is decided by the pure planners in lib/funnel.ts
// and lib/rank.ts (unit-tested); this module only translates them into SQL.

import type { PoolClient } from "pg";
import { normalizeDateAdded } from "./aggregate";
import { withWriteTransaction } from "./db";
import {
  bucketPrecedence,
  computeMovePlan,
  deriveFunnelBuckets,
  FUNNEL_BUCKET_LABELS,
  FUNNEL_COLLECTIONS,
  type FunnelMoveRequest,
} from "./funnel";
import {
  isValidRankKey,
  needsCompaction,
  planCompaction,
  planRankBootstrap,
  rankKeyBetween,
  type RankableHouse,
} from "./rank";

export const FUNNEL_WRITE_SOURCE = "dashboard-funnel";

export type FunnelMoveOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "stale-order" };

/** Internal signal: the requested neighbors no longer reflect the current
 * persisted order (a concurrent move landed first). Thrown inside the
 * transaction so EVERYTHING (bucket change included) rolls back, then
 * translated to a clean conflict outcome for the API. */
class StaleOrderError extends Error {
  constructor() {
    super("stale order");
    this.name = "StaleOrderError";
  }
}

async function fetchActiveFunnelCollectionsForUpdate(
  client: PoolClient,
  propertyId: string,
  track: PropertyTrack,
): Promise<string[]> {
  const result = await client.query<{ collection: string }>(
    `SELECT collection FROM property_collections
     WHERE property_id = $1::uuid AND active AND collection = ANY($2::text[]) AND track = $3
     FOR UPDATE`,
    [propertyId, [...FUNNEL_COLLECTIONS], track],
  );
  return result.rows.map((row) => row.collection);
}

// A single app-wide advisory lock key serializes every rank write within
// its transaction, so two concurrent moves can never interleave their
// "read current ranks → insert new revision" sequences and produce an
// inconsistent order. hashtext is deterministic across sessions.
const RANK_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('property_funnel_ranks'))`;

interface RankStateRow {
  id: string;
  rank_key: string | null;
  first_seen_at: string | Date | null;
  address: string;
  collections: string[] | null;
}

/** Every tracked house's latest rank revision plus the fields the
 * deterministic bootstrap orders by. Read under the advisory lock. */
async function fetchRankState(client: PoolClient, track: PropertyTrack): Promise<RankableHouse[]> {
  const result = await client.query<RankStateRow>(
    `SELECT
       pr.id::text AS id,
       rk.rank_key AS rank_key,
       pr.first_seen_at AS first_seen_at,
       COALESCE(pcur.canonical_address, '') AS address,
       col.collections AS collections
     FROM property_records pr
     LEFT JOIN property_current pcur ON pcur.id = pr.id
     LEFT JOIN LATERAL (
       SELECT rank_key FROM property_funnel_ranks
       WHERE property_id = pr.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) rk ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(collection) AS collections
       FROM property_collections
       WHERE property_id = pr.id AND active AND collection = ANY($1::text[]) AND track = $2
     ) col ON true
     WHERE pr.track = $2`,
    [[...FUNNEL_COLLECTIONS], track],
  );

  return result.rows.map((row) => {
    const bucket =
      deriveFunnelBuckets((row.collections ?? []).map((collection) => ({ propertyId: row.id, collection }))).get(
        row.id,
      ) ?? "watchlist";
    return {
      id: row.id,
      bucketPrecedence: bucketPrecedence(bucket),
      dateAdded: normalizeDateAdded(row.first_seen_at),
      address: row.address,
      rankKey: row.rank_key !== null && isValidRankKey(row.rank_key) ? row.rank_key : null,
    };
  });
}

async function insertRankRevisions(
  client: PoolClient,
  assignments: Array<{ id: string; rankKey: string }>,
  note: string,
): Promise<void> {
  for (const assignment of assignments) {
    await client.query(
      `INSERT INTO property_funnel_ranks (property_id, rank_key, source, note)
       VALUES ($1::uuid, $2, $3, $4)`,
      [assignment.id, assignment.rankKey, FUNNEL_WRITE_SOURCE, note],
    );
  }
}

/**
 * Places one house at its requested global-rank position, entirely inside
 * the caller's transaction:
 *
 * 1. Serializes on the rank advisory lock, then reads every house's
 *    current (latest-revision) rank key.
 * 2. Bootstraps deterministic keys for any house that has none — current
 *    bucket precedence, then newest dateAdded, then address — WITHOUT
 *    touching existing keys, so pre-rank collection history survives.
 * 3. Validates the requested neighbors: both must be tracked houses with
 *    current ranks in the requested relative order. A violated expectation
 *    means the client dragged against a stale list (concurrent move) — the
 *    caller returns a conflict and the UI rolls back honestly.
 * 4. Inserts ONE new rank revision between the neighbors, or — when the
 *    key space between them is exhausted or the new key is degenerately
 *    long — performs a deterministic full compaction with the moved house
 *    at its requested position.
 */
async function applyRankPlacement(
  client: PoolClient,
  request: FunnelMoveRequest,
  track: PropertyTrack,
): Promise<{ ok: true } | { ok: false; error: "stale-order" }> {
  await client.query(RANK_LOCK_SQL);

  let houses = await fetchRankState(client, track);

  const bootstrap = planRankBootstrap(houses);
  if (bootstrap.length > 0) {
    await insertRankRevisions(client, bootstrap, "Deterministic rank bootstrap (category, date added, address)");
    const assigned = new Map(bootstrap.map((a) => [a.id, a.rankKey]));
    houses = houses.map((h) => (assigned.has(h.id) ? { ...h, rankKey: assigned.get(h.id) as string } : h));
  }

  const byId = new Map(houses.map((h) => [h.id, h]));
  const moved = byId.get(request.propertyId);
  if (!moved) return { ok: false, error: "stale-order" };

  const resolveNeighborKey = (neighborId: string | null): string | null | undefined => {
    if (neighborId === null) return null;
    const neighbor = byId.get(neighborId);
    // Unknown neighbor or neighbor without a rank: the client's list view
    // was stale. undefined = invalid (distinct from null = open bound).
    if (!neighbor || neighbor.rankKey === null) return undefined;
    return neighbor.rankKey;
  };

  const afterKey = resolveNeighborKey(request.afterId);
  const beforeKey = resolveNeighborKey(request.beforeId);
  if (afterKey === undefined || beforeKey === undefined) return { ok: false, error: "stale-order" };
  if (afterKey !== null && beforeKey !== null && afterKey >= beforeKey) {
    return { ok: false, error: "stale-order" };
  }

  // No explicit position requested (plain category move): keep the current
  // rank when one exists; the house simply renders in its new bucket.
  if (request.afterId === null && request.beforeId === null && moved.rankKey !== null) {
    return { ok: true };
  }

  const between = rankKeyBetween(afterKey, beforeKey);
  if (between !== null && !needsCompaction(between)) {
    await insertRankRevisions(
      client,
      [{ id: request.propertyId, rankKey: between }],
      "Placed via My Search funnel drag/drop",
    );
    return { ok: true };
  }

  // Key space exhausted between these neighbors (or the key grew
  // degenerate): deterministic full compaction with the moved house at its
  // requested position. History rows are preserved by append-only storage.
  const others = houses
    .filter((h) => h.id !== request.propertyId && h.rankKey !== null)
    .sort((a, b) => ((a.rankKey as string) < (b.rankKey as string) ? -1 : 1))
    .map((h) => h.id);
  let insertAt: number;
  if (request.afterId !== null) {
    insertAt = others.indexOf(request.afterId) + 1;
  } else if (request.beforeId !== null) {
    insertAt = Math.max(others.indexOf(request.beforeId), 0);
  } else {
    insertAt = 0;
  }
  const orderedIds = [...others.slice(0, insertAt), request.propertyId, ...others.slice(insertAt)];
  await insertRankRevisions(client, planCompaction(orderedIds), "Deterministic rank compaction");
  return { ok: true };
}

/**
 * Applies one funnel move atomically:
 *
 * - Bucket moves upsert the target bucket's canonical collection as active
 *   and deactivate (active=false, removed_at=now(); never DELETE) every
 *   conflicting active funnel membership, resolving multi-membership with
 *   the planner's precedence rules. A provenance note is added to
 *   property_interactions with a NULL verdict, which the rejection logic
 *   ignores by construction (it only reads non-empty verdicts).
 * - Bucket moves also place the house in the ONE global manual rank
 *   (append-only property_funnel_ranks revisions, see applyRankPlacement):
 *   within-bucket drags change only the rank; cross-bucket drags change
 *   category AND rank in this same transaction. Stale neighbor
 *   expectations (a concurrent move landed first) abort everything and
 *   surface as a "stale-order" conflict.
 * - Reject inserts an explicit property_interactions decision with the
 *   literal "reject" verdict — the exact same semantics lib/rejection.ts
 *   already recognizes — and deactivates elevated funnel memberships in the
 *   same transaction. The watchlist row is left untouched, and NO rank
 *   revision is written, so a later reconsideration restores the house
 *   exactly where it was, at its old rank.
 *
 * Everything commits or rolls back together via withWriteTransaction.
 */
export async function executeFunnelMove(request: FunnelMoveRequest, track: PropertyTrack = "house"): Promise<FunnelMoveOutcome> {
  try {
    return await executeFunnelMoveTransaction(request, track);
  } catch (err) {
    if (err instanceof StaleOrderError) {
      return { ok: false, error: "stale-order" };
    }
    throw err;
  }
}

async function executeFunnelMoveTransaction(request: FunnelMoveRequest, track: PropertyTrack): Promise<FunnelMoveOutcome> {
  return withWriteTransaction(async (client) => {
    // Lock the property row first so concurrent moves for the same house
    // serialize, and refuse anything that is not a tracked house.
    const houseResult = await client.query(
      `SELECT id FROM property_records WHERE id = $1::uuid AND track = $2 FOR UPDATE`,
      [request.propertyId, track],
    );
    if (houseResult.rowCount === 0) {
      return { ok: false as const, error: "not-found" as const };
    }

    const activeCollections = await fetchActiveFunnelCollectionsForUpdate(client, request.propertyId, track);
    const plan = computeMovePlan(activeCollections, request.action);

    // Rank placement runs for every bucket move (within-bucket reorders are
    // category no-ops but still change rank). Rejection deliberately skips
    // it: the prior rank row stays untouched so restoration recovers the
    // old position.
    const hasExplicitPosition = request.afterId !== null || request.beforeId !== null;
    let rankChanged = false;
    if (request.action !== "reject") {
      const placement = await applyRankPlacement(client, request, track);
      if (!placement.ok) {
        // Abort the whole transaction (bucket change included) so a stale
        // drag never half-applies.
        throw new StaleOrderError();
      }
      rankChanged = hasExplicitPosition;
    }

    const isNoOp =
      plan.activate === null && plan.deactivate.length === 0 && !plan.insertRejection && !rankChanged;
    if (isNoOp) {
      return { ok: true as const, changed: false };
    }

    if (plan.deactivate.length > 0) {
      await client.query(
        `UPDATE property_collections
         SET active = false, removed_at = now()
         WHERE property_id = $1::uuid AND active AND collection = ANY($2::text[]) AND track = $3`,
        [request.propertyId, plan.deactivate, track],
      );
    }

    if (plan.activate !== null) {
      // Re-activating an existing row only flips active/removed_at; the
      // original added_at/source/note provenance is preserved.
      await client.query(
        `INSERT INTO property_collections (property_id, collection, track, active, source, note)
         VALUES ($1::uuid, $2, $5, true, $3, $4)
         ON CONFLICT (property_id, collection, track)
         DO UPDATE SET active = true, removed_at = NULL`,
        [
          request.propertyId,
          plan.activate,
          FUNNEL_WRITE_SOURCE,
          "Placed via My Search funnel drag/drop",
          track,
        ],
      );
    }

    if (plan.insertRejection) {
      await client.query(
        `INSERT INTO property_interactions (property_id, interaction_type, verdict, note, source)
         VALUES ($1::uuid, 'classification', 'reject', $2, $3)`,
        [request.propertyId, request.note ?? "Rejected via My Search funnel", FUNNEL_WRITE_SOURCE],
      );
    } else {
      // Verdict-less provenance note: invisible to rejection logic, but the
      // move itself is permanently recorded.
      const categoryChanged = plan.activate !== null || plan.deactivate.length > 0;
      const label = request.action === "reject" ? "Rejected" : FUNNEL_BUCKET_LABELS[request.action];
      await client.query(
        `INSERT INTO property_interactions (property_id, interaction_type, verdict, note, source)
         VALUES ($1::uuid, 'note', NULL, $2, $3)`,
        [
          request.propertyId,
          categoryChanged
            ? `Moved to ${label} via My Search funnel`
            : `Reordered within ${label} via My Search funnel`,
          FUNNEL_WRITE_SOURCE,
        ],
      );
    }

    return { ok: true as const, changed: true };
  });
}
