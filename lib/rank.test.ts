import { describe, expect, it } from "vitest";
import {
  COMPACTION_KEY_LENGTH,
  compareBootstrapOrder,
  compareRankKeys,
  generateSpacedKeys,
  isValidRankKey,
  needsCompaction,
  planCompaction,
  planRankBootstrap,
  rankKeyBetween,
  type RankableHouse,
} from "./rank";

function rankable(overrides: Partial<RankableHouse>): RankableHouse {
  return {
    id: "p-1",
    bucketPrecedence: 2,
    dateAdded: null,
    address: "100 SE Example St",
    rankKey: null,
    ...overrides,
  };
}

describe("isValidRankKey", () => {
  it("accepts base-36 keys without trailing zeros", () => {
    expect(isValidRankKey("i")).toBe(true);
    expect(isValidRankKey("0i")).toBe(true);
    expect(isValidRankKey("a2z")).toBe(true);
  });

  it("rejects empty, trailing-zero, and out-of-alphabet keys", () => {
    expect(isValidRankKey("")).toBe(false);
    expect(isValidRankKey("a0")).toBe(false);
    expect(isValidRankKey("A")).toBe(false);
    expect(isValidRankKey("a b")).toBe(false);
    expect(isValidRankKey("a-1")).toBe(false);
  });
});

describe("rankKeyBetween", () => {
  it("produces a key strictly between two neighbors", () => {
    const key = rankKeyBetween("a", "b");
    expect(key).not.toBeNull();
    expect(compareRankKeys("a", key as string)).toBeLessThan(0);
    expect(compareRankKeys(key as string, "b")).toBeLessThan(0);
  });

  it("supports first insertion (no after) and last insertion (no before)", () => {
    const first = rankKeyBetween(null, "5");
    expect(first).not.toBeNull();
    expect((first as string) < "5").toBe(true);

    const last = rankKeyBetween("x", null);
    expect(last).not.toBeNull();
    expect((last as string) > "x").toBe(true);
  });

  it("returns a key even into an empty list", () => {
    const key = rankKeyBetween(null, null);
    expect(key).not.toBeNull();
    expect(isValidRankKey(key as string)).toBe(true);
  });

  it("handles adjacent digit keys by extending", () => {
    const key = rankKeyBetween("4", "5");
    expect(key).not.toBeNull();
    expect((key as string) > "4" && (key as string) < "5").toBe(true);
  });

  it("handles prefix-related neighbors", () => {
    const key = rankKeyBetween("1", "12");
    expect(key).not.toBeNull();
    expect((key as string) > "1" && (key as string) < "12").toBe(true);
  });

  it("returns null (never a bad key) for inverted, equal, or invalid bounds", () => {
    expect(rankKeyBetween("b", "a")).toBeNull();
    expect(rankKeyBetween("a", "a")).toBeNull();
    expect(rankKeyBetween("a0", "b")).toBeNull();
    expect(rankKeyBetween("a", "B!")).toBeNull();
  });

  it("stays ordered through hundreds of repeated same-spot insertions", () => {
    // Adversarial: always insert between the first two keys.
    let low: string | null = null;
    let high: string | null = "i";
    const produced: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const key = rankKeyBetween(low, high);
      expect(key).not.toBeNull();
      expect(isValidRankKey(key as string)).toBe(true);
      produced.push(key as string);
      high = key;
    }
    const sorted = [...produced].sort(compareRankKeys).reverse();
    expect(produced).toEqual(sorted);
  });
});

describe("needsCompaction / generateSpacedKeys / planCompaction", () => {
  it("flags only keys past the compaction length", () => {
    expect(needsCompaction("a".repeat(COMPACTION_KEY_LENGTH))).toBe(false);
    expect(needsCompaction("a".repeat(COMPACTION_KEY_LENGTH + 1))).toBe(true);
  });

  it("generates strictly increasing, valid, deterministic keys", () => {
    const keys = generateSpacedKeys(50);
    expect(keys).toHaveLength(50);
    for (const key of keys) expect(isValidRankKey(key)).toBe(true);
    for (let i = 1; i < keys.length; i += 1) {
      expect(compareRankKeys(keys[i - 1], keys[i])).toBeLessThan(0);
    }
    expect(generateSpacedKeys(50)).toEqual(keys);
  });

  it("leaves room for insertions between every generated pair", () => {
    const keys = generateSpacedKeys(10);
    for (let i = 1; i < keys.length; i += 1) {
      const between = rankKeyBetween(keys[i - 1], keys[i]);
      expect(between).not.toBeNull();
    }
  });

  it("returns nothing for non-positive or non-integer counts", () => {
    expect(generateSpacedKeys(0)).toEqual([]);
    expect(generateSpacedKeys(-3)).toEqual([]);
    expect(generateSpacedKeys(2.5)).toEqual([]);
  });

  it("plans compaction keys in exactly the supplied order", () => {
    const plan = planCompaction(["c", "a", "b"]);
    expect(plan.map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(compareRankKeys(plan[0].rankKey, plan[1].rankKey)).toBeLessThan(0);
    expect(compareRankKeys(plan[1].rankKey, plan[2].rankKey)).toBeLessThan(0);
  });
});

describe("compareBootstrapOrder", () => {
  it("orders by bucket precedence, then dateAdded newest first, then address, then id", () => {
    const top = rankable({ id: "t", bucketPrecedence: 0, dateAdded: "2026-01-01T00:00:00Z" });
    const newer = rankable({ id: "n", bucketPrecedence: 2, dateAdded: "2026-06-01T00:00:00Z" });
    const older = rankable({ id: "o", bucketPrecedence: 2, dateAdded: "2026-02-01T00:00:00Z" });
    const undated = rankable({ id: "u", bucketPrecedence: 2, dateAdded: null, address: "50 A St" });
    const sorted = [undated, older, newer, top].sort(compareBootstrapOrder);
    expect(sorted.map((h) => h.id)).toEqual(["t", "n", "o", "u"]);
  });

  it("is fully deterministic for identical dates via address then id", () => {
    const a = rankable({ id: "b", address: "200 B St", dateAdded: "2026-01-01T00:00:00Z" });
    const b = rankable({ id: "a", address: "200 B St", dateAdded: "2026-01-01T00:00:00Z" });
    expect(compareBootstrapOrder(a, b)).toBeGreaterThan(0);
    expect(compareBootstrapOrder(b, a)).toBeLessThan(0);
  });
});

describe("planRankBootstrap", () => {
  it("assigns evenly spaced keys in bootstrap order when nothing is ranked yet", () => {
    const houses = [
      rankable({ id: "w-old", bucketPrecedence: 2, dateAdded: "2026-01-01T00:00:00Z" }),
      rankable({ id: "top", bucketPrecedence: 0, dateAdded: "2025-01-01T00:00:00Z" }),
      rankable({ id: "w-new", bucketPrecedence: 2, dateAdded: "2026-05-01T00:00:00Z" }),
      rankable({ id: "tour", bucketPrecedence: 1, dateAdded: null }),
    ];
    const plan = planRankBootstrap(houses);
    expect(plan.map((p) => p.id)).toEqual(["top", "tour", "w-new", "w-old"]);
    for (let i = 1; i < plan.length; i += 1) {
      expect(compareRankKeys(plan[i - 1].rankKey, plan[i].rankKey)).toBeLessThan(0);
    }
  });

  it("never rewrites an existing rank and slots new houses above their bucket's ranked rows", () => {
    const houses = [
      rankable({ id: "ranked-top", bucketPrecedence: 0, rankKey: "8" }),
      rankable({ id: "ranked-watch", bucketPrecedence: 2, rankKey: "q" }),
      rankable({ id: "new-watch", bucketPrecedence: 2, dateAdded: "2026-06-01T00:00:00Z" }),
    ];
    const plan = planRankBootstrap(houses);
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe("new-watch");
    // Before the lowest existing key of its own bucket ("q").
    expect(compareRankKeys(plan[0].rankKey, "q")).toBeLessThan(0);
  });

  it("keeps several new arrivals in one bucket in newest-first order among themselves", () => {
    const houses = [
      rankable({ id: "anchor", bucketPrecedence: 2, rankKey: "q" }),
      rankable({ id: "new-a", bucketPrecedence: 2, dateAdded: "2026-06-01T00:00:00Z" }),
      rankable({ id: "new-b", bucketPrecedence: 2, dateAdded: "2026-07-01T00:00:00Z" }),
    ];
    const plan = planRankBootstrap(houses);
    expect(plan.map((p) => p.id)).toEqual(["new-b", "new-a"]);
    expect(compareRankKeys(plan[0].rankKey, plan[1].rankKey)).toBeLessThan(0);
    expect(compareRankKeys(plan[1].rankKey, "q")).toBeLessThan(0);
  });

  it("anchors to the global minimum when the bucket has no ranked rows", () => {
    const houses = [
      rankable({ id: "ranked-top", bucketPrecedence: 0, rankKey: "8" }),
      rankable({ id: "new-tour", bucketPrecedence: 1, dateAdded: null }),
    ];
    const plan = planRankBootstrap(houses);
    expect(plan).toHaveLength(1);
    expect(compareRankKeys(plan[0].rankKey, "8")).toBeLessThan(0);
  });

  it("treats structurally invalid persisted keys as unranked", () => {
    const houses = [rankable({ id: "bad", rankKey: "not valid!" })];
    const plan = planRankBootstrap(houses);
    expect(plan).toHaveLength(1);
    expect(isValidRankKey(plan[0].rankKey)).toBe(true);
  });

  it("returns an empty plan when every house is already ranked", () => {
    const houses = [rankable({ id: "a", rankKey: "5" }), rankable({ id: "b", rankKey: "7" })];
    expect(planRankBootstrap(houses)).toEqual([]);
  });
});
