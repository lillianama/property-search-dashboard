import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

// withWriteTransaction is replaced with a fake that hands executeFunnelMove a
// scripted client, so these tests verify the exact statement sequence the
// write path issues — without a database.
vi.mock("./db", () => ({
  withWriteTransaction: vi.fn(),
  DatabaseUnavailableError: class DatabaseUnavailableError extends Error {},
}));

import { withWriteTransaction } from "./db";
import { executeFunnelMove } from "./funnel-writes";

const UUID = "eeeeeeee-1111-4222-8333-444444444444";
const OTHER_UUID = "aaaaaaaa-1111-4222-8333-444444444444";
const THIRD_UUID = "bbbbbbbb-1111-4222-8333-444444444444";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** One house row in the fake rank-state read (fetchRankState). */
interface FakeRankRow {
  id: string;
  rank_key: string | null;
  first_seen_at: string | null;
  address: string;
  collections: string[] | null;
}

function fakeClient(options: {
  houseExists?: boolean;
  activeCollections?: string[];
  rankRows?: FakeRankRow[];
}): { client: PoolClient; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const defaultRankRows: FakeRankRow[] = [
    {
      id: UUID,
      rank_key: "i",
      first_seen_at: "2026-01-01T00:00:00Z",
      address: "123 SE Example St",
      collections: options.activeCollections ?? [],
    },
  ];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("FROM property_records pr")) {
        const rows = options.rankRows ?? defaultRankRows;
        return { rowCount: rows.length, rows };
      }
      if (sql.includes("FROM property_records")) {
        return { rowCount: options.houseExists === false ? 0 : 1, rows: [] };
      }
      if (sql.includes("FROM property_collections") && sql.includes("FOR UPDATE")) {
        return {
          rowCount: (options.activeCollections ?? []).length,
          rows: (options.activeCollections ?? []).map((collection) => ({ collection })),
        };
      }
      return { rowCount: 1, rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, queries };
}

function useClient(client: PoolClient) {
  vi.mocked(withWriteTransaction).mockImplementation(async (fn) => fn(client));
}

beforeEach(() => {
  vi.mocked(withWriteTransaction).mockReset();
});

describe("executeFunnelMove bucket moves", () => {
  it("persists a move to top-contenders and deactivates conflicting memberships", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist", "tour_shortlist"] });
    useClient(client);

    const outcome = await executeFunnelMove({ propertyId: UUID, action: "top-contenders", note: null, afterId: null, beforeId: null });

    expect(outcome).toEqual({ ok: true, changed: true });

    const deactivate = queries.find((q) => q.sql.includes("SET active = false"));
    expect(deactivate).toBeDefined();
    expect(deactivate?.params[0]).toBe(UUID);
    expect((deactivate?.params[1] as string[]).sort()).toEqual(["tour_shortlist", "watchlist"]);

    const activate = queries.find((q) => q.sql.includes("INSERT INTO property_collections"));
    expect(activate).toBeDefined();
    expect(activate?.sql).toContain("ON CONFLICT (property_id, collection, track)");
    expect(activate?.params[0]).toBe(UUID);
    expect(activate?.params[1]).toBe("top-contenders");

    // Provenance note is recorded with a NULL verdict so it can never read
    // as a decision to the rejection logic.
    const interaction = queries.find((q) => q.sql.includes("INSERT INTO property_interactions"));
    expect(interaction?.sql).toContain("'note', NULL");
    expect(interaction?.params[2]).toBe("dashboard-funnel");
  });

  it("never issues DELETE statements (history is preserved)", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"] });
    useClient(client);

    await executeFunnelMove({ propertyId: UUID, action: "to-tour", note: null, afterId: null, beforeId: null });

    expect(queries.some((q) => /\bDELETE\b/i.test(q.sql))).toBe(false);
  });

  it("returns changed=false and writes nothing for a same-bucket no-op", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"] });
    useClient(client);

    const outcome = await executeFunnelMove({ propertyId: UUID, action: "watchlist", note: null, afterId: null, beforeId: null });

    expect(outcome).toEqual({ ok: true, changed: false });
    // Only the SELECT ... FOR UPDATE lock reads happen; nothing is written.
    expect(queries.some((q) => q.sql.includes("INSERT") || q.sql.includes("SET active"))).toBe(false);
  });

  it("activates watchlist explicitly when a catch-all house is dragged there from a higher bucket", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["top-contenders"] });
    useClient(client);

    await executeFunnelMove({ propertyId: UUID, action: "watchlist", note: null, afterId: null, beforeId: null });

    const activate = queries.find((q) => q.sql.includes("INSERT INTO property_collections"));
    expect(activate?.params[1]).toBe("watchlist");
    const deactivate = queries.find((q) => q.sql.includes("SET active = false"));
    expect(deactivate?.params[1]).toEqual(["top-contenders"]);
  });

  it("refuses unknown or non-house properties without writing", async () => {
    const { client, queries } = fakeClient({ houseExists: false });
    useClient(client);

    const outcome = await executeFunnelMove({ propertyId: UUID, action: "to-tour", note: null, afterId: null, beforeId: null });

    expect(outcome).toEqual({ ok: false, error: "not-found" });
    expect(queries.some((q) => q.sql.includes("INSERT") || q.sql.includes("SET active"))).toBe(false);
  });

  it("propagates write failures so the caller can roll back optimistically", async () => {
    const { client } = fakeClient({ activeCollections: [] });
    vi.mocked(client.query).mockRejectedValueOnce(new Error("connection reset"));
    useClient(client);

    await expect(executeFunnelMove({ propertyId: UUID, action: "to-tour", note: null, afterId: null, beforeId: null })).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("executeFunnelMove global rank placement", () => {
  const threeRanked: FakeRankRow[] = [
    { id: UUID, rank_key: "8", first_seen_at: "2026-01-01T00:00:00Z", address: "1 A St", collections: ["watchlist"] },
    { id: OTHER_UUID, rank_key: "i", first_seen_at: "2026-01-02T00:00:00Z", address: "2 B St", collections: ["watchlist"] },
    { id: THIRD_UUID, rank_key: "q", first_seen_at: "2026-01-03T00:00:00Z", address: "3 C St", collections: ["watchlist"] },
  ];

  const rankInserts = (queries: RecordedQuery[]) =>
    queries.filter((q) => q.sql.includes("INSERT INTO property_funnel_ranks"));

  it("within-bucket reorder writes ONE rank revision between the neighbors and no category change", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(client);

    const outcome = await executeFunnelMove({
      propertyId: UUID,
      action: "watchlist",
      note: null,
      afterId: OTHER_UUID,
      beforeId: THIRD_UUID,
    });

    expect(outcome).toEqual({ ok: true, changed: true });
    const inserts = rankInserts(queries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[0]).toBe(UUID);
    const key = inserts[0].params[1] as string;
    expect(key > "i" && key < "q").toBe(true);
    // No category writes for a same-bucket reorder.
    expect(queries.some((q) => q.sql.includes("INSERT INTO property_collections"))).toBe(false);
    expect(queries.some((q) => q.sql.includes("SET active = false"))).toBe(false);
    // Provenance says reorder, not move.
    const interaction = queries.find((q) => q.sql.includes("INSERT INTO property_interactions"));
    expect(interaction?.params[1]).toContain("Reordered within");
  });

  it("cross-bucket move changes category AND rank in the same transaction", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(client);

    const outcome = await executeFunnelMove({
      propertyId: UUID,
      action: "top-contenders",
      note: null,
      afterId: OTHER_UUID,
      beforeId: THIRD_UUID,
    });

    expect(outcome).toEqual({ ok: true, changed: true });
    expect(rankInserts(queries)).toHaveLength(1);
    const activate = queries.find((q) => q.sql.includes("INSERT INTO property_collections"));
    expect(activate?.params[1]).toBe("top-contenders");
    expect(withWriteTransaction).toHaveBeenCalledTimes(1);
  });

  it("supports first (afterId null) and last (beforeId null) insertion", async () => {
    const first = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(first.client);
    await executeFunnelMove({ propertyId: THIRD_UUID, action: "watchlist", note: null, afterId: null, beforeId: UUID });
    const firstKey = rankInserts(first.queries)[0].params[1] as string;
    expect(firstKey < "8").toBe(true);

    const last = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(last.client);
    await executeFunnelMove({ propertyId: UUID, action: "watchlist", note: null, afterId: THIRD_UUID, beforeId: null });
    const lastKey = rankInserts(last.queries)[0].params[1] as string;
    expect(lastKey > "q").toBe(true);
  });

  it("bootstraps missing ranks deterministically before placing, without rewriting existing keys", async () => {
    const rows: FakeRankRow[] = [
      { id: UUID, rank_key: null, first_seen_at: "2026-01-01T00:00:00Z", address: "1 A St", collections: ["watchlist"] },
      { id: OTHER_UUID, rank_key: null, first_seen_at: "2026-02-01T00:00:00Z", address: "2 B St", collections: ["top-contenders"] },
      { id: THIRD_UUID, rank_key: null, first_seen_at: "2026-03-01T00:00:00Z", address: "3 C St", collections: [] },
    ];
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"], rankRows: rows });
    useClient(client);

    await executeFunnelMove({ propertyId: UUID, action: "watchlist", note: null, afterId: OTHER_UUID, beforeId: null });

    const inserts = rankInserts(queries);
    // 3 bootstrap revisions + 1 placement revision.
    expect(inserts).toHaveLength(4);
    const bootstrap = inserts.slice(0, 3);
    // Bootstrap order: top-contenders first, then watchlist newest-first.
    expect(bootstrap.map((q) => q.params[0])).toEqual([OTHER_UUID, THIRD_UUID, UUID]);
    const keys = bootstrap.map((q) => q.params[1] as string);
    expect(keys[0] < keys[1] && keys[1] < keys[2]).toBe(true);
    expect(bootstrap[0].params[3]).toContain("bootstrap");
  });

  it("keeps the existing rank on a plain category move with no requested position", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(client);

    await executeFunnelMove({ propertyId: UUID, action: "to-tour", note: null, afterId: null, beforeId: null });

    expect(rankInserts(queries)).toHaveLength(0);
    const activate = queries.find((q) => q.sql.includes("INSERT INTO property_collections"));
    expect(activate?.params[1]).toBe("tour-shortlist");
  });

  it("returns stale-order (writing nothing) when neighbors are unknown or inverted", async () => {
    const unknownNeighbor = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(unknownNeighbor.client);
    const outcome1 = await executeFunnelMove({
      propertyId: UUID,
      action: "watchlist",
      note: null,
      afterId: "cccccccc-1111-4222-8333-444444444444",
      beforeId: null,
    });
    expect(outcome1).toEqual({ ok: false, error: "stale-order" });
    expect(rankInserts(unknownNeighbor.queries)).toHaveLength(0);

    const inverted = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(inverted.client);
    const outcome2 = await executeFunnelMove({
      propertyId: UUID,
      action: "watchlist",
      note: null,
      afterId: THIRD_UUID, // "q"
      beforeId: OTHER_UUID, // "i" — inverted vs current persisted order
    });
    expect(outcome2).toEqual({ ok: false, error: "stale-order" });
    expect(rankInserts(inverted.queries)).toHaveLength(0);
  });

  it("compacts deterministically when the key space between neighbors is exhausted", async () => {
    // Degenerately deep adjacent keys force needsCompaction on the midpoint.
    const deepA = "5" + "0".repeat(30) + "1";
    const deepB = "5" + "0".repeat(30) + "2";
    const rows: FakeRankRow[] = [
      { id: OTHER_UUID, rank_key: deepA, first_seen_at: null, address: "1 A St", collections: ["watchlist"] },
      { id: THIRD_UUID, rank_key: deepB, first_seen_at: null, address: "2 B St", collections: ["watchlist"] },
      { id: UUID, rank_key: "q", first_seen_at: null, address: "3 C St", collections: ["watchlist"] },
    ];
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"], rankRows: rows });
    useClient(client);

    const outcome = await executeFunnelMove({
      propertyId: UUID,
      action: "watchlist",
      note: null,
      afterId: OTHER_UUID,
      beforeId: THIRD_UUID,
    });

    expect(outcome).toEqual({ ok: true, changed: true });
    const inserts = rankInserts(queries);
    // Full compaction: one fresh revision per house, ordered with the moved
    // house between its requested neighbors.
    expect(inserts).toHaveLength(3);
    expect(inserts.map((q) => q.params[0])).toEqual([OTHER_UUID, UUID, THIRD_UUID]);
    const keys = inserts.map((q) => q.params[1] as string);
    expect(keys[0] < keys[1] && keys[1] < keys[2]).toBe(true);
    for (const key of keys) expect(key.length).toBeLessThan(10);
    expect(inserts[0].params[3]).toContain("compaction");
  });

  it("takes the rank advisory lock before reading rank state", async () => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"], rankRows: threeRanked });
    useClient(client);

    await executeFunnelMove({ propertyId: UUID, action: "watchlist", note: null, afterId: OTHER_UUID, beforeId: THIRD_UUID });

    const lockIdx = queries.findIndex((q) => q.sql.includes("pg_advisory_xact_lock"));
    const readIdx = queries.findIndex((q) => q.sql.includes("FROM property_records pr"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThan(lockIdx);
  });
});

describe("executeFunnelMove rejection", () => {
  it("writes an explicit reject decision and deactivates elevated memberships in one transaction", async () => {
    const { client, queries } = fakeClient({
      activeCollections: ["top-contenders", "tour-shortlist", "watchlist"],
    });
    useClient(client);

    const outcome = await executeFunnelMove({ propertyId: UUID, action: "reject", note: "Too dark inside", afterId: null, beforeId: null });

    expect(outcome).toEqual({ ok: true, changed: true });
    expect(withWriteTransaction).toHaveBeenCalledTimes(1);

    const rejection = queries.find((q) => q.sql.includes("INSERT INTO property_interactions"));
    expect(rejection?.sql).toContain("'classification', 'reject'");
    expect(rejection?.params).toEqual([UUID, "Too dark inside", "dashboard-funnel"]);

    const deactivate = queries.find((q) => q.sql.includes("SET active = false"));
    expect((deactivate?.params[1] as string[]).sort()).toEqual(["top-contenders", "tour-shortlist"]);

    // Watchlist membership survives so a reconsideration restores the house.
    expect(queries.some((q) => q.sql.includes("INSERT INTO property_collections"))).toBe(false);
    // No rank revision on rejection: the prior rank stays untouched so a
    // later restoration recovers the old position.
    expect(queries.some((q) => q.sql.includes("INSERT INTO property_funnel_ranks"))).toBe(false);
  });

  it("uses a default note when none is provided", async () => {
    const { client, queries } = fakeClient({ activeCollections: [] });
    useClient(client);

    await executeFunnelMove({ propertyId: UUID, action: "reject", note: null, afterId: null, beforeId: null });

    const rejection = queries.find((q) => q.sql.includes("INSERT INTO property_interactions"));
    expect(rejection?.params[1]).toBe("Rejected via My Search funnel");
  });
});

describe("track isolation for funnel writes", () => {
  it.each(["house", "plex"] as const)("scopes property guard, collections and rank bootstrap to %s", async (track) => {
    const { client, queries } = fakeClient({ activeCollections: ["watchlist"], rankRows: [{ id: UUID, rank_key: null, first_seen_at: null, address: "123 NE Example St", collections: [] }] });
    useClient(client);
    expect(await executeFunnelMove({ propertyId: UUID, action: "top-contenders", note: null, afterId: null, beforeId: null }, track)).toEqual({ ok: true, changed: true });
    const guard = queries[0];
    expect(guard.sql).toContain("track = $2");
    expect(guard.params).toEqual([UUID, track]);
    const rankRead = queries.find(q => q.sql.includes("FROM property_records pr"))!;
    expect(rankRead.sql).toContain("pr.track = $2");
    expect(rankRead.params[1]).toBe(track);
    const membershipRead = queries.find(q => q.sql.includes("SELECT collection"))!;
    expect(membershipRead.sql).toContain("track = $3");
    expect(membershipRead.params[2]).toBe(track);
    const deactivate = queries.find(q => q.sql.includes("SET active = false"))!;
    expect(deactivate.sql).toContain("track = $3");
    expect(deactivate.params[2]).toBe(track);
    expect(queries.find(q => q.sql.includes("INSERT INTO property_collections"))?.params[4]).toBe(track);
    expect(queries.filter(q => q.sql.includes("INSERT INTO property_funnel_ranks")).map(q => q.params[0])).toEqual([UUID]);
  });

  it("refuses a property outside the active track before any writes", async () => {
    const { client, queries } = fakeClient({ houseExists: false });
    useClient(client);
    expect(await executeFunnelMove({ propertyId: UUID, action: "reject", note: null, afterId: null, beforeId: null }, "plex")).toEqual({ ok: false, error: "not-found" });
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toEqual([UUID, "plex"]);
  });

  it("rejects a rank neighbor absent from the active track", async () => {
    const { client, queries } = fakeClient({});
    useClient(client);
    expect(await executeFunnelMove({ propertyId: UUID, action: "watchlist", note: null, afterId: OTHER_UUID, beforeId: null }, "plex")).toEqual({ ok: false, error: "stale-order" });
    expect(queries.some(q => /INSERT|UPDATE property_collections/.test(q.sql))).toBe(false);
  });
});
