import { describe, expect, it } from "vitest";
import {
  computeRejections,
  isRejectionVerdict,
  MAX_REJECTION_NOTE_LENGTH,
  partitionByRejection,
  sanitizeRejectionNote,
  sortByRejectionRecency,
  type DecisionRow,
  type RejectionOrderable,
} from "./rejection";
import type { HouseRecord } from "./types";

function decision(overrides: Partial<DecisionRow>): DecisionRow {
  return {
    propertyId: "prop-1",
    verdict: "reject",
    note: null,
    occurredAt: "2026-07-17T00:00:00Z",
    ...overrides,
  };
}

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
    judgments: { bedroomSizeOk: "unknown" as const, rentalIncome: "unknown" as const, drumSpace: "unknown" as const },
    displayStatus: "Active",
    dateAdded: null,
    annualTaxAmount: null,
    annualTaxYear: null,
    annualTaxAsOf: null,
    annualTaxSource: null,
    firstSeenAt: null,
    lastSeenAt: "2026-07-01T00:00:00Z",
    neighborhood: null,
    neighborhoodMarket: null,
    ...overrides,
  };
}

describe("isRejectionVerdict", () => {
  it("recognizes only literal reject/rejected text, case- and whitespace-insensitively", () => {
    expect(isRejectionVerdict("reject")).toBe(true);
    expect(isRejectionVerdict("Reject")).toBe(true);
    expect(isRejectionVerdict("  REJECTED  ")).toBe(true);
  });

  it("never treats automated SKIP verdicts, boundary exclusions, or color codes as rejection", () => {
    expect(isRejectionVerdict("SKIP")).toBe(false);
    expect(isRejectionVerdict("\u{1F534} outside boundary")).toBe(false);
    expect(isRejectionVerdict("\u{1F534}")).toBe(false);
    expect(isRejectionVerdict("red")).toBe(false);
    expect(isRejectionVerdict("parked-over-budget")).toBe(false);
    expect(isRejectionVerdict("WORTH_A_LOOK")).toBe(false);
  });

  it("treats null/undefined/empty verdicts as non-rejections", () => {
    expect(isRejectionVerdict(null)).toBe(false);
    expect(isRejectionVerdict(undefined)).toBe(false);
    expect(isRejectionVerdict("")).toBe(false);
    expect(isRejectionVerdict("   ")).toBe(false);
  });
});

describe("computeRejections", () => {
  it("marks a property rejected when its latest decision is an explicit reject", () => {
    const rows: DecisionRow[] = [
      decision({ propertyId: "prop-1", verdict: "\u{1F7E1}", occurredAt: "2026-07-09T00:00:00Z" }),
      decision({
        propertyId: "prop-1",
        verdict: "reject",
        note: "Synthetic rejection reason.",
        occurredAt: "2026-07-17T02:00:00Z",
      }),
    ];

    const result = computeRejections(rows);
    expect(result.get("prop-1")).toEqual({ reason: "Synthetic rejection reason.", at: "2026-07-17T02:00:00Z" });
  });

  it("does not reject a property whose only decisions are automated SKIP or boundary verdicts", () => {
    const rows: DecisionRow[] = [
      decision({ propertyId: "prop-2", verdict: "SKIP", occurredAt: "2026-07-16T00:00:00Z" }),
      decision({ propertyId: "prop-2", verdict: "\u{1F534} outside boundary", occurredAt: "2026-07-17T00:00:00Z" }),
    ];

    const result = computeRejections(rows);
    expect(result.get("prop-2")).toBeNull();
  });

  it("restores a property when a later decision supersedes an earlier rejection", () => {
    const rows: DecisionRow[] = [
      decision({ propertyId: "prop-3", verdict: "reject", occurredAt: "2026-07-10T00:00:00Z" }),
      decision({
        propertyId: "prop-3",
        verdict: "green",
        note: "Top contender after tour",
        occurredAt: "2026-07-17T21:00:00Z",
      }),
    ];

    const result = computeRejections(rows);
    expect(result.get("prop-3")).toBeNull();
  });

  it("keeps a property rejected when a later automated verdict follows a human reject", () => {
    // An automated SKIP/color-code entry recorded after a human rejection
    // must never look like a "reconsideration" that un-rejects the house.
    const rows: DecisionRow[] = [
      decision({ propertyId: "prop-4", verdict: "reject", occurredAt: "2026-07-10T00:00:00Z" }),
      decision({ propertyId: "prop-4", verdict: "SKIP", occurredAt: "2026-07-11T00:00:00Z" }),
    ];

    const result = computeRejections(rows);
    expect(result.get("prop-4")).toBeNull();
  });

  it("uses input order as a stable tiebreaker for identical timestamps", () => {
    const rows: DecisionRow[] = [
      decision({ propertyId: "prop-5", verdict: "reject", occurredAt: "2026-07-17T00:00:00Z" }),
      decision({ propertyId: "prop-5", verdict: "concern", occurredAt: "2026-07-17T00:00:00Z" }),
    ];

    const result = computeRejections(rows);
    expect(result.get("prop-5")).toBeNull();
  });

  it("leaves properties with no explicit decision unrejected", () => {
    const result = computeRejections([]);
    expect(result.get("prop-6")).toBeUndefined();
  });
});

describe("partitionByRejection", () => {
  it("splits houses into active and rejected, attaching the rejection reason and date", () => {
    const houses = [house({ id: "prop-1" }), house({ id: "prop-2", address: "456 NE Other Ave" })];
    const rejections = new Map([["prop-2", { reason: "Synthetic size concern.", at: "2026-07-17T02:00:00Z" }]]);

    const { active, rejected } = partitionByRejection(houses, rejections);

    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("prop-1");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ id: "prop-2", rejectionReason: "Synthetic size concern.", rejectionAt: "2026-07-17T02:00:00Z" });
  });

  it("treats a null rejection-map entry as active, not rejected", () => {
    const houses = [house({ id: "prop-1" })];
    const rejections = new Map([["prop-1", null]]);

    const { active, rejected } = partitionByRejection(houses, rejections);

    expect(active).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });
});

describe("sanitizeRejectionNote", () => {
  it("trims whitespace and preserves the text", () => {
    expect(sanitizeRejectionNote("  Too close to the highway  ")).toBe("Too close to the highway");
  });

  it("turns empty/whitespace-only input into null (no reason recorded)", () => {
    expect(sanitizeRejectionNote("")).toBeNull();
    expect(sanitizeRejectionNote("   ")).toBeNull();
  });

  it("caps the note at the shared endpoint limit so the UI can never produce a refused note", () => {
    const long = "x".repeat(MAX_REJECTION_NOTE_LENGTH + 100);
    expect(sanitizeRejectionNote(long)).toHaveLength(MAX_REJECTION_NOTE_LENGTH);
  });
});

describe("sortByRejectionRecency", () => {
  const entry = (id: string, rejectionAt: string | null, address = `${id} St`): RejectionOrderable => ({
    id,
    address,
    rejectionAt,
  });

  it("puts the most recently rejected house first", () => {
    const sorted = sortByRejectionRecency([
      entry("a", "2026-07-01T00:00:00Z"),
      entry("b", "2026-07-18T00:00:00Z"),
      entry("c", "2026-07-10T00:00:00Z"),
    ]);
    expect(sorted.map((h) => h.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts houses with missing or unparseable rejection timestamps after every dated one", () => {
    const sorted = sortByRejectionRecency([
      entry("undated", null),
      entry("garbled", "not-a-date"),
      entry("dated", "2026-01-01T00:00:00Z"),
    ]);
    expect(sorted[0].id).toBe("dated");
    expect(sorted.slice(1).map((h) => h.id).sort()).toEqual(["garbled", "undated"]);
  });

  it("breaks timestamp ties deterministically by address, then id", () => {
    const at = "2026-07-17T00:00:00Z";
    const sorted = sortByRejectionRecency([
      entry("z", at, "9 Same Ave"),
      entry("a", at, "9 Same Ave"),
      entry("m", at, "1 Alpha St"),
    ]);
    expect(sorted.map((h) => h.id)).toEqual(["m", "a", "z"]);
  });

  it("returns a new array and never mutates the input", () => {
    const input = [entry("a", "2026-07-01T00:00:00Z"), entry("b", "2026-07-18T00:00:00Z")];
    const snapshot = input.map((h) => h.id);
    const sorted = sortByRejectionRecency(input);
    expect(input.map((h) => h.id)).toEqual(snapshot);
    expect(sorted).not.toBe(input);
  });
});

describe("synthetic rejection history scenarios", () => {
  it("rejects a house whose earlier weekly-digest color verdict is superseded by a conversation reject", () => {
    const rows: DecisionRow[] = [
      decision({ propertyId: "example-property", verdict: "\u{1F7E1}", occurredAt: "2026-07-09T00:00:00Z" }),
      decision({ propertyId: "example-property", verdict: "yellow", occurredAt: "2026-07-17T01:00:00Z" }),
      decision({
        propertyId: "example-property",
        verdict: "reject",
        note: "Synthetic rejection reason.",
        occurredAt: "2026-07-17T02:00:00Z",
      }),
    ];

    expect(computeRejections(rows).get("example-property")).toEqual({
      reason: "Synthetic rejection reason.",
      at: "2026-07-17T02:00:00Z",
    });
  });

  it("does not reject a house parked over budget or flagged outside the search boundary", () => {
    const rows: DecisionRow[] = [
      decision({ propertyId: "over-budget", verdict: "parked-over-budget", occurredAt: "2026-07-17T02:51:34Z" }),
      decision({ propertyId: "boundary", verdict: "\u{1F534} outside boundary", occurredAt: "2026-07-17T02:51:34Z" }),
    ];

    const result = computeRejections(rows);
    expect(result.get("over-budget")).toBeNull();
    expect(result.get("boundary")).toBeNull();
  });
});
