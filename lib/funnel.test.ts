import { describe, expect, it } from "vitest";
import {
  applyLocalFunnelState,
  bucketForCollection,
  collectionForBucket,
  computeMovePlan,
  deriveFunnelBuckets,
  EMPTY_LOCAL_FUNNEL_STATE,
  groupByBucket,
  isSameOriginRequest,
  isValidUuid,
  parseFunnelMoveRequest,
  type ActiveCollectionRow,
} from "./funnel";
import type { HouseRecord } from "./types";

const UUID = "eeeeeeee-1111-4222-8333-444444444444";

function house(overrides: Partial<HouseRecord>): HouseRecord {
  return {
    id: "prop-1",
    address: "123 SE Example St",
    city: "Portland",
    state: "OR",
    zipCode: "97202",
    latitude: 45.5,
    longitude: -122.6,
    bedrooms: 3,
    bathrooms: 1,
    finishedSqft: 1400,
    yearBuilt: 1925,
    latestPrice: 450000,
    latestStatus: "Active",
    latestSalePrice: null,
    latestSaleDate: null,
    bedroomSizeFlag: "ok",
    smallestBedroomSqft: 110,
    zillowUrl: null,
    photoUrl: null,
    photoSource: null,
    funnelBucket: "watchlist",
    rankKey: null,
    judgments: { bedroomSizeOk: "unknown", rentalIncome: "unknown", drumSpace: "unknown" },
    displayStatus: "Active",
    dateAdded: null,
    annualTaxAmount: null,
    annualTaxYear: null,
    annualTaxAsOf: null,
    annualTaxSource: null,
    firstSeenAt: null,
    lastSeenAt: null,
    neighborhood: null,
    neighborhoodMarket: null,
    ...overrides,
  };
}

describe("bucketForCollection / collectionForBucket", () => {
  it("maps both tour-shortlist spellings to the to-tour bucket", () => {
    expect(bucketForCollection("tour-shortlist")).toBe("to-tour");
    expect(bucketForCollection("tour_shortlist")).toBe("to-tour");
  });

  it("maps the other canonical collections and ignores non-funnel ones", () => {
    expect(bucketForCollection("top-contenders")).toBe("top-contenders");
    expect(bucketForCollection("watchlist")).toBe("watchlist");
    expect(bucketForCollection("dismissed")).toBeNull();
    expect(bucketForCollection("anything-else")).toBeNull();
  });

  it("always writes canonical hyphenated names, never the legacy spelling", () => {
    expect(collectionForBucket("top-contenders")).toBe("top-contenders");
    expect(collectionForBucket("to-tour")).toBe("tour-shortlist");
    expect(collectionForBucket("watchlist")).toBe("watchlist");
  });
});

describe("deriveFunnelBuckets", () => {
  it("resolves multiple active memberships with top-contenders > to-tour > watchlist precedence", () => {
    const rows: ActiveCollectionRow[] = [
      { propertyId: "a", collection: "watchlist" },
      { propertyId: "a", collection: "tour-shortlist" },
      { propertyId: "a", collection: "top-contenders" },
      { propertyId: "b", collection: "watchlist" },
      { propertyId: "b", collection: "tour_shortlist" },
      { propertyId: "c", collection: "watchlist" },
    ];

    const buckets = deriveFunnelBuckets(rows);
    expect(buckets.get("a")).toBe("top-contenders");
    expect(buckets.get("b")).toBe("to-tour");
    expect(buckets.get("c")).toBe("watchlist");
  });

  it("is order-independent for the same memberships", () => {
    const forward: ActiveCollectionRow[] = [
      { propertyId: "a", collection: "top-contenders" },
      { propertyId: "a", collection: "watchlist" },
    ];
    const backward = [...forward].reverse();
    expect(deriveFunnelBuckets(forward).get("a")).toBe("top-contenders");
    expect(deriveFunnelBuckets(backward).get("a")).toBe("top-contenders");
  });

  it("gives no entry for properties with only non-funnel collections", () => {
    const buckets = deriveFunnelBuckets([{ propertyId: "a", collection: "dismissed" }]);
    expect(buckets.has("a")).toBe(false);
  });
});

describe("computeMovePlan", () => {
  it("activates the target and deactivates every conflicting funnel membership", () => {
    const plan = computeMovePlan(["watchlist", "tour_shortlist", "tour-shortlist"], "top-contenders");
    expect(plan.activate).toBe("top-contenders");
    expect(plan.deactivate.sort()).toEqual(["tour-shortlist", "tour_shortlist", "watchlist"]);
    expect(plan.insertRejection).toBe(false);
  });

  it("skips re-activation when an equivalent membership (legacy spelling) is already active", () => {
    const plan = computeMovePlan(["tour_shortlist", "watchlist"], "to-tour");
    expect(plan.activate).toBeNull();
    expect(plan.deactivate).toEqual(["watchlist"]);
  });

  it("is a no-op when the property is already exactly in the target bucket", () => {
    const plan = computeMovePlan(["watchlist"], "watchlist");
    expect(plan).toEqual({ activate: null, deactivate: [], insertRejection: false });
  });

  it("plans a catch-all watchlist card move without touching anything already consistent", () => {
    // A house rendered in Watchlist purely as the catch-all (no memberships
    // at all) moving to To tour: only the target is activated.
    const plan = computeMovePlan([], "to-tour");
    expect(plan.activate).toBe("tour-shortlist");
    expect(plan.deactivate).toEqual([]);
  });

  it("never touches non-funnel collections", () => {
    const plan = computeMovePlan(["dismissed", "watchlist"], "top-contenders");
    expect(plan.deactivate).toEqual(["watchlist"]);
  });

  it("reject deactivates elevated placements, keeps watchlist, and inserts a rejection", () => {
    const plan = computeMovePlan(["top-contenders", "tour-shortlist", "watchlist"], "reject");
    expect(plan.activate).toBeNull();
    expect(plan.deactivate.sort()).toEqual(["top-contenders", "tour-shortlist"]);
    expect(plan.insertRejection).toBe(true);
  });

  it("reject still records the decision when there are no memberships at all", () => {
    const plan = computeMovePlan([], "reject");
    expect(plan).toEqual({ activate: null, deactivate: [], insertRejection: true });
  });
});

describe("parseFunnelMoveRequest", () => {
  it("accepts a valid UUID + allowlisted action", () => {
    const parsed = parseFunnelMoveRequest({ propertyId: UUID, action: "to-tour" });
    expect(parsed).toEqual({
      ok: true,
      request: { propertyId: UUID, action: "to-tour", note: null, afterId: null, beforeId: null },
    });
  });

  it("accepts an optional trimmed note for reject only", () => {
    const parsed = parseFunnelMoveRequest({ propertyId: UUID, action: "reject", note: "  too dark  " });
    expect(parsed).toEqual({
      ok: true,
      request: { propertyId: UUID, action: "reject", note: "too dark", afterId: null, beforeId: null },
    });

    const nonReject = parseFunnelMoveRequest({ propertyId: UUID, action: "watchlist", note: "nope" });
    expect(nonReject.ok).toBe(false);
  });

  it("accepts UUID rank neighbors for bucket moves and normalizes them to lowercase", () => {
    const after = "aaaaaaaa-1111-4222-8333-444444444444";
    const before = "bbbbbbbb-1111-4222-8333-444444444444";
    const parsed = parseFunnelMoveRequest({
      propertyId: UUID,
      action: "to-tour",
      afterId: after.toUpperCase(),
      beforeId: before,
    });
    expect(parsed.ok && parsed.request.afterId).toBe(after);
    expect(parsed.ok && parsed.request.beforeId).toBe(before);
  });

  it("rejects malformed, self-referencing, or duplicate neighbor ids", () => {
    const other = "aaaaaaaa-1111-4222-8333-444444444444";
    expect(parseFunnelMoveRequest({ propertyId: UUID, action: "to-tour", afterId: "nope" }).ok).toBe(false);
    expect(parseFunnelMoveRequest({ propertyId: UUID, action: "to-tour", afterId: UUID }).ok).toBe(false);
    expect(parseFunnelMoveRequest({ propertyId: UUID, action: "to-tour", beforeId: UUID }).ok).toBe(false);
    expect(
      parseFunnelMoveRequest({ propertyId: UUID, action: "to-tour", afterId: other, beforeId: other }).ok,
    ).toBe(false);
  });

  it("refuses neighbors on reject (rejection preserves the prior rank)", () => {
    const other = "aaaaaaaa-1111-4222-8333-444444444444";
    expect(parseFunnelMoveRequest({ propertyId: UUID, action: "reject", afterId: other }).ok).toBe(false);
    expect(parseFunnelMoveRequest({ propertyId: UUID, action: "reject", beforeId: other }).ok).toBe(false);
  });

  it("rejects malformed propertyIds, including SQL-shaped input", () => {
    for (const bad of ["", "not-a-uuid", "123", `${UUID}'; DROP TABLE property_records;--`, 42, null]) {
      const parsed = parseFunnelMoveRequest({ propertyId: bad, action: "watchlist" });
      expect(parsed.ok).toBe(false);
    }
  });

  it("rejects any action outside the allowlist", () => {
    for (const bad of ["delete", "dismissed", "UPDATE", "", null, 1]) {
      const parsed = parseFunnelMoveRequest({ propertyId: UUID, action: bad });
      expect(parsed.ok).toBe(false);
    }
  });

  it("rejects non-object bodies and over-long notes", () => {
    expect(parseFunnelMoveRequest(null).ok).toBe(false);
    expect(parseFunnelMoveRequest([1, 2]).ok).toBe(false);
    expect(parseFunnelMoveRequest("propertyId=x").ok).toBe(false);
    expect(
      parseFunnelMoveRequest({ propertyId: UUID, action: "reject", note: "x".repeat(501) }).ok,
    ).toBe(false);
  });

  it("normalizes uppercase UUIDs to lowercase", () => {
    const parsed = parseFunnelMoveRequest({ propertyId: UUID.toUpperCase(), action: "watchlist" });
    expect(parsed.ok && parsed.request.propertyId).toBe(UUID);
  });
});

describe("isValidUuid", () => {
  it("accepts canonical UUIDs and rejects everything else", () => {
    expect(isValidUuid(UUID)).toBe(true);
    expect(isValidUuid(UUID.toUpperCase())).toBe(true);
    expect(isValidUuid("12e6f274843f4a9cb0368a047235a9a8")).toBe(false);
    expect(isValidUuid("hello")).toBe(false);
  });
});

describe("isSameOriginRequest", () => {
  it("allows matching origins and requests without an Origin header", () => {
    expect(isSameOriginRequest("https://realestate.example.com", "realestate.example.com")).toBe(true);
    expect(isSameOriginRequest(null, "realestate.example.com")).toBe(true);
  });

  it("refuses mismatched or malformed origins", () => {
    expect(isSameOriginRequest("https://evil.example.com", "realestate.example.com")).toBe(false);
    expect(isSameOriginRequest("not a url", "realestate.example.com")).toBe(false);
    expect(isSameOriginRequest("https://realestate.example.com", null)).toBe(false);
  });
});

describe("applyLocalFunnelState / groupByBucket (optimistic view logic)", () => {
  it("applies bucket overrides and removes optimistically rejected houses from the payload", () => {
    const properties = [
      house({ id: "a", funnelBucket: "watchlist" }),
      house({ id: "b", funnelBucket: "to-tour" }),
      house({ id: "c", funnelBucket: "top-contenders" }),
    ];

    const result = applyLocalFunnelState(properties, {
      moves: { a: "top-contenders" },
      placements: {},
      rejectedIds: ["b"],
    });

    expect(result.map((p) => p.id)).toEqual(["a", "c"]);
    expect(result[0].funnelBucket).toBe("top-contenders");
    expect(result[1].funnelBucket).toBe("top-contenders");
  });

  it("returns the payload unchanged for the empty local state (clean rollback target)", () => {
    const properties = [house({ id: "a" })];
    const result = applyLocalFunnelState(properties, EMPTY_LOCAL_FUNNEL_STATE);
    expect(result).toEqual(properties);
    expect(result[0]).toBe(properties[0]);
  });

  it("groups every house into exactly one bucket", () => {
    const properties = [
      house({ id: "a", funnelBucket: "watchlist" }),
      house({ id: "b", funnelBucket: "top-contenders" }),
      house({ id: "c", funnelBucket: "watchlist" }),
      house({ id: "d", funnelBucket: "to-tour" }),
    ];

    const groups = groupByBucket(properties);
    expect(groups["top-contenders"].map((p) => p.id)).toEqual(["b"]);
    expect(groups["to-tour"].map((p) => p.id)).toEqual(["d"]);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["a", "c"]);
  });
});

describe("compareByGlobalRank / rank-ordered grouping", () => {
  it("orders each bucket by the global rank key ascending", () => {
    const properties = [
      house({ id: "third", funnelBucket: "watchlist", rankKey: "q" }),
      house({ id: "first", funnelBucket: "watchlist", rankKey: "8" }),
      house({ id: "second", funnelBucket: "watchlist", rankKey: "i" }),
    ];
    const groups = groupByBucket(properties);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["first", "second", "third"]);
  });

  it("keeps the same global order across buckets (rank is category-independent)", () => {
    const properties = [
      house({ id: "top-low", funnelBucket: "top-contenders", rankKey: "q" }),
      house({ id: "watch-high", funnelBucket: "watchlist", rankKey: "8" }),
    ];
    const groups = groupByBucket(properties);
    // Each bucket orders internally by the SAME global key space.
    expect(groups["top-contenders"].map((p) => p.id)).toEqual(["top-low"]);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["watch-high"]);
  });

  it("sorts unranked houses above ranked ones, newest dateAdded first (bootstrap parity)", () => {
    const properties = [
      house({ id: "ranked", funnelBucket: "watchlist", rankKey: "i", dateAdded: "2026-01-01T00:00:00.000Z" }),
      house({ id: "unranked-old", funnelBucket: "watchlist", rankKey: null, dateAdded: "2026-03-01T00:00:00.000Z" }),
      house({ id: "unranked-new", funnelBucket: "watchlist", rankKey: null, dateAdded: "2026-06-01T00:00:00.000Z" }),
    ];
    const groups = groupByBucket(properties);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["unranked-new", "unranked-old", "ranked"]);
  });

  it("treats structurally invalid rank keys as unranked", () => {
    const properties = [
      house({ id: "bad", funnelBucket: "watchlist", rankKey: "NOT VALID", dateAdded: "2026-06-01T00:00:00.000Z" }),
      house({ id: "good", funnelBucket: "watchlist", rankKey: "i" }),
    ];
    const groups = groupByBucket(properties);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["bad", "good"]);
  });

  it("replays optimistic placements at the recorded neighbor position", () => {
    const properties = [
      house({ id: "a", funnelBucket: "watchlist", rankKey: "5" }),
      house({ id: "b", funnelBucket: "watchlist", rankKey: "i" }),
      house({ id: "c", funnelBucket: "watchlist", rankKey: "q" }),
    ];
    // Drag "a" between "b" and "c" (within-bucket reorder).
    const groups = groupByBucket(properties, {
      a: { bucket: "watchlist", afterId: "b", beforeId: "c", seq: 0 },
    });
    expect(groups.watchlist.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("replays a cross-bucket placement into the target bucket at the requested position", () => {
    const properties = [
      house({ id: "t1", funnelBucket: "top-contenders", rankKey: "5" }),
      house({ id: "t2", funnelBucket: "top-contenders", rankKey: "i" }),
      house({ id: "w1", funnelBucket: "watchlist", rankKey: "q" }),
    ];
    const groups = groupByBucket(
      properties.map((p) => (p.id === "w1" ? { ...p, funnelBucket: "top-contenders" as const } : p)),
      { w1: { bucket: "top-contenders", afterId: "t1", beforeId: "t2", seq: 0 } },
    );
    expect(groups["top-contenders"].map((p) => p.id)).toEqual(["t1", "w1", "t2"]);
    expect(groups.watchlist).toEqual([]);
  });

  it("places first/last insertions correctly (null neighbors)", () => {
    const properties = [
      house({ id: "a", funnelBucket: "watchlist", rankKey: "5" }),
      house({ id: "b", funnelBucket: "watchlist", rankKey: "i" }),
      house({ id: "c", funnelBucket: "watchlist", rankKey: "q" }),
    ];
    const toTop = groupByBucket(properties, {
      c: { bucket: "watchlist", afterId: null, beforeId: "a", seq: 0 },
    });
    expect(toTop.watchlist.map((p) => p.id)).toEqual(["c", "a", "b"]);

    const toBottom = groupByBucket(properties, {
      a: { bucket: "watchlist", afterId: "c", beforeId: null, seq: 0 },
    });
    expect(toBottom.watchlist.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("replays multiple placements in seq order and ignores placements for missing houses", () => {
    const properties = [
      house({ id: "a", funnelBucket: "watchlist", rankKey: "5" }),
      house({ id: "b", funnelBucket: "watchlist", rankKey: "i" }),
    ];
    const groups = groupByBucket(properties, {
      b: { bucket: "watchlist", afterId: null, beforeId: "a", seq: 0 },
      gone: { bucket: "watchlist", afterId: null, beforeId: null, seq: 1 },
      a: { bucket: "watchlist", afterId: null, beforeId: "b", seq: 2 },
    });
    expect(groups.watchlist.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("compareByDateAddedDesc / bucket sorting", () => {
  it("sorts each bucket newest dateAdded first without touching bucket precedence", () => {
    const properties = [
      house({ id: "old", address: "1 Old St", funnelBucket: "watchlist", dateAdded: "2026-06-01T00:00:00.000Z" }),
      house({ id: "new", address: "9 New St", funnelBucket: "watchlist", dateAdded: "2026-07-15T00:00:00.000Z" }),
      house({ id: "mid", address: "5 Mid St", funnelBucket: "watchlist", dateAdded: "2026-07-01T00:00:00.000Z" }),
      house({ id: "top", address: "2 Top St", funnelBucket: "top-contenders", dateAdded: "2026-05-01T00:00:00.000Z" }),
    ];

    const groups = groupByBucket(properties);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["new", "mid", "old"]);
    expect(groups["top-contenders"].map((p) => p.id)).toEqual(["top"]);
  });

  it("sorts houses without a dateAdded after every dated house", () => {
    const properties = [
      house({ id: "undated", address: "1 Aaa St", dateAdded: null }),
      house({ id: "dated", address: "9 Zzz St", dateAdded: "2026-01-01T00:00:00.000Z" }),
    ];
    const groups = groupByBucket(properties);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["dated", "undated"]);
  });

  it("breaks ties (and undated pairs) deterministically by address ascending", () => {
    const sameDate = "2026-07-01T00:00:00.000Z";
    const properties = [
      house({ id: "b", address: "200 B St", dateAdded: sameDate }),
      house({ id: "a", address: "100 A St", dateAdded: sameDate }),
      house({ id: "d", address: "400 D St", dateAdded: null }),
      house({ id: "c", address: "300 C St", dateAdded: null }),
    ];
    const groups = groupByBucket(properties);
    expect(groups.watchlist.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });
});
