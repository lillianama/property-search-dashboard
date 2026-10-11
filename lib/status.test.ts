import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  displayStatusFromRaw,
  filterByDisplayStatus,
  isGenericAvailabilitySource,
  resolveDisplayStatus,
  resolveDisplayStatuses,
  type StatusEventRow,
} from "./status";
import type { DisplayStatus } from "./types";

let nextId = 1;

function event(overrides: Partial<StatusEventRow>): StatusEventRow {
  return {
    propertyId: "prop-1",
    status: "Active",
    source: "zillow",
    eventDate: null,
    observedAt: "2026-07-01T00:00:00Z",
    id: nextId++,
    ...overrides,
  };
}

describe("classifyStatus", () => {
  it("classifies the store's real status vocabulary", () => {
    expect(classifyStatus("Active")).toBe("active");
    expect(classifyStatus("Pending")).toBe("pending");
    expect(classifyStatus("Sold")).toBe("sold");
    expect(classifyStatus("Inactive")).toBe("inactive");
    expect(classifyStatus("Unverified")).toBe("unverified");
    expect(classifyStatus("Off Market")).toBe("inactive");
  });

  it("treats under-contract and contingent variants as pending", () => {
    expect(classifyStatus("Under Contract")).toBe("pending");
    expect(classifyStatus("under_contract")).toBe("pending");
    expect(classifyStatus("Active Under Contract")).toBe("pending");
    expect(classifyStatus("CONTINGENT")).toBe("pending");
    expect(classifyStatus("Sale Pending")).toBe("pending");
  });

  it("returns null for blank, null, or unrecognized values", () => {
    expect(classifyStatus(null)).toBeNull();
    expect(classifyStatus("")).toBeNull();
    expect(classifyStatus("   ")).toBeNull();
    expect(classifyStatus("Something Weird")).toBeNull();
  });
});

describe("isGenericAvailabilitySource", () => {
  it("flags RentCast-backed checkers and cache mirrors as generic", () => {
    expect(isGenericAvailabilitySource("watchlist-status-check")).toBe(true);
    expect(isGenericAvailabilitySource("rentcast-house-weekly")).toBe(true);
    expect(isGenericAvailabilitySource("rentcast-property")).toBe(true);
    expect(isGenericAvailabilitySource("workspace-state")).toBe(true);
    expect(isGenericAvailabilitySource("tour-shortlist")).toBe(true);
  });

  it("treats listing/user/assessor sources as authoritative", () => {
    expect(isGenericAvailabilitySource("zillow")).toBe(false);
    expect(isGenericAvailabilitySource("user-status-update")).toBe(false);
    expect(isGenericAvailabilitySource("rmls")).toBe(false);
    expect(isGenericAvailabilitySource("portlandmaps-assessor")).toBe(false);
  });

  it("never treats a missing source as authoritative", () => {
    expect(isGenericAvailabilitySource(null)).toBe(true);
    expect(isGenericAvailabilitySource("")).toBe(true);
  });
});

describe("resolveDisplayStatus", () => {
  it("returns Unknown with no usable evidence", () => {
    expect(resolveDisplayStatus([])).toBe("Unknown");
    expect(resolveDisplayStatus([event({ status: null }), event({ status: "gibberish" })])).toBe("Unknown");
  });

  it("shows Pending when explicit pending evidence is buried under newer generic Inactive rows", () => {
    // Synthetic listing history: active observations, an explicit
    // user-reported Pending, then daily generic Inactive checks after it.
    const events = [
      event({ status: "Sold", source: "portlandmaps-assessor", eventDate: "2011-12-01", observedAt: "2026-07-17T01:05:09Z" }),
      event({ status: "Active", source: "rentcast-house-weekly", eventDate: "2026-07-09", observedAt: "2026-07-17T01:08:12Z" }),
      event({ status: "Active", source: "watchlist-status-check", eventDate: "2026-07-17", observedAt: "2026-07-17T01:07:57Z" }),
      event({ status: "Pending", source: "user-status-update", observedAt: "2026-07-17T02:50:17Z" }),
      event({ status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-17", observedAt: "2026-07-17T14:11:26Z" }),
      event({ status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18", observedAt: "2026-07-18T02:11:29Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Pending");
  });

  it("does not make Pending permanent: a later authoritative Active relist wins", () => {
    const events = [
      event({ status: "Pending", source: "zillow", eventDate: "2026-06-01", observedAt: "2026-06-01T00:00:00Z" }),
      event({ status: "Active", source: "rmls", eventDate: "2026-06-20", observedAt: "2026-06-20T00:00:00Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Active");
  });

  it("does not make Pending permanent: a later recorded Sold wins", () => {
    const events = [
      event({ status: "Pending", source: "user-status-update", observedAt: "2026-06-01T00:00:00Z" }),
      event({ status: "Sold", source: "portlandmaps-assessor", eventDate: "2026-07-10", observedAt: "2026-07-12T00:00:00Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Sold");
  });

  it("a later explicit Off Market from a listing source beats older pending evidence", () => {
    const events = [
      event({ status: "Pending", source: "zillow", eventDate: "2026-06-01", observedAt: "2026-06-01T00:00:00Z" }),
      event({ status: "Off Market", source: "zillow-user-link", eventDate: "2026-07-01", observedAt: "2026-07-01T00:00:00Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Inactive");
  });

  it("shows an honest Inactive when generic inactives follow non-pending evidence", () => {
    // 456 NE Example St shape: a years-old assessor sale plus recent generic
    // Inactive checks. Pending cannot be substantiated → Inactive, and the
    // historic sale must not masquerade as a current Sold.
    const events = [
      event({ status: "Sold", source: "portlandmaps-assessor", eventDate: "2018-08-23", observedAt: "2026-07-17T01:05:00Z" }),
      event({ status: "Inactive", source: "workspace-state", eventDate: "2026-07-13", observedAt: "2026-07-13T00:00:00Z" }),
      event({ status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18", observedAt: "2026-07-18T02:11:00Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Inactive");
  });

  it("shows Inactive when a generic inactive follows plain active evidence with no pending", () => {
    const events = [
      event({ status: "Active", source: "rentcast-house-weekly", eventDate: "2026-07-09", observedAt: "2026-07-10T00:00:00Z" }),
      event({ status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18", observedAt: "2026-07-18T00:00:00Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Inactive");
  });

  it("uses event_date over observed_at as the timeline position when present", () => {
    // A pending transition published for June, observed late, still loses to
    // an authoritative Active dated after it.
    const events = [
      event({ status: "Pending", source: "zillow", eventDate: "2026-06-01", observedAt: "2026-07-17T00:00:00Z" }),
      event({ status: "Active", source: "rmls", eventDate: "2026-07-01", observedAt: "2026-07-02T00:00:00Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Active");
  });

  it("breaks same-day ties by observed_at, then id, deterministically", () => {
    const pendingLater = [
      event({ id: 1, status: "Active", source: "watchlist-status-check", eventDate: "2026-07-17", observedAt: "2026-07-17T01:00:00Z" }),
      event({ id: 2, status: "Pending", source: "user-status-update", observedAt: "2026-07-17T02:00:00Z" }),
    ];
    expect(resolveDisplayStatus(pendingLater)).toBe("Pending");

    const sameInstant = [
      event({ id: 1, status: "Active", source: "zillow", eventDate: "2026-07-17", observedAt: "2026-07-17T02:00:00Z" }),
      event({ id: 2, status: "Pending", source: "zillow", eventDate: "2026-07-17", observedAt: "2026-07-17T02:00:00Z" }),
    ];
    expect(resolveDisplayStatus(sameInstant)).toBe("Pending");
  });

  it("shows Inactive when only generic inactive evidence exists", () => {
    const events = [
      event({ status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Inactive");
  });

  it("keeps a generic Unverified signal distinct from confirmed Inactive", () => {
    const events = [
      event({ status: "Active", source: "rmls", eventDate: "2026-07-17" }),
      event({ status: "Unverified", source: "watchlist-status-check", eventDate: "2026-07-18" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Unverified");
    expect(displayStatusFromRaw("Unverified")).toBe("Unverified");
  });

  it("ignores events without any usable timeline position", () => {
    const events = [
      event({ status: "Pending", source: "zillow", eventDate: null, observedAt: null }),
      event({ status: "Active", source: "zillow", eventDate: "2026-07-01", observedAt: "2026-07-01T00:00:00Z" }),
    ];
    expect(resolveDisplayStatus(events)).toBe("Active");
  });
});

describe("resolveDisplayStatuses", () => {
  it("resolves each property independently from a flat row list", () => {
    const rows = [
      event({ propertyId: "a", status: "Pending", source: "user-status-update", observedAt: "2026-07-17T02:00:00Z" }),
      event({ propertyId: "a", status: "Inactive", source: "watchlist-status-check", eventDate: "2026-07-18", observedAt: "2026-07-18T00:00:00Z" }),
      event({ propertyId: "b", status: "Active", source: "rmls", eventDate: "2026-07-15" }),
    ];
    const resolved = resolveDisplayStatuses(rows);
    expect(resolved.get("a")).toBe("Pending");
    expect(resolved.get("b")).toBe("Active");
    expect(resolved.has("c")).toBe(false);
  });
});

describe("displayStatusFromRaw", () => {
  it("maps raw statuses directly with no pending rescue", () => {
    expect(displayStatusFromRaw("Active")).toBe("Active");
    expect(displayStatusFromRaw("Off Market")).toBe("Inactive");
    expect(displayStatusFromRaw(null)).toBe("Unknown");
    expect(displayStatusFromRaw("odd value")).toBe("Unknown");
  });
});

describe("filterByDisplayStatus", () => {
  const houses = (["Active", "Pending", "Inactive", "Unknown"] as DisplayStatus[]).map((displayStatus, i) => ({
    id: `p${i}`,
    displayStatus,
  }));

  it("passes everything through with no filter", () => {
    expect(filterByDisplayStatus(houses, null)).toHaveLength(4);
    expect(filterByDisplayStatus(houses, [])).toHaveLength(4);
  });

  it("matches resolved statuses case-insensitively, including Unknown", () => {
    expect(filterByDisplayStatus(houses, ["pending"]).map((h) => h.displayStatus)).toEqual(["Pending"]);
    expect(filterByDisplayStatus(houses, ["Active", "Unknown"]).map((h) => h.displayStatus)).toEqual([
      "Active",
      "Unknown",
    ]);
  });
});
