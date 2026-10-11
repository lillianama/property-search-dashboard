import { describe, expect, it } from "vitest";
import { readScrollPosition, saveScrollPosition, scrollStorageKey, type KeyValueStorage } from "./scroll-restore";
import {
  DEFAULT_APP_URL_STATE,
  EMPTY_FILTER_FORM,
  parseAppUrlState,
  sameUrlState,
  searchStringFromParams,
  serializeAppUrlState,
  type AppUrlState,
} from "./url-state";

function state(overrides: Partial<AppUrlState>): AppUrlState {
  return { ...DEFAULT_APP_URL_STATE, filters: { ...EMPTY_FILTER_FORM }, ...overrides };
}

describe("serializeAppUrlState / parseAppUrlState", () => {
  it("serializes pristine state to an empty string (clean URL)", () => {
    expect(serializeAppUrlState(DEFAULT_APP_URL_STATE)).toBe("");
  });

  it("round-trips every persisted field", () => {
    const original = state({
      tab: "search",
      view: "list",
      filters: {
        statuses: ["Active", "Pending"],
        maxPrice: "480000",
        minBedrooms: "3",
        maxYearBuilt: "1965",
        dateFrom: "2026-01-01",
        dateTo: "2026-06-30",
      },
      editingId: "eeeeeeee-1111-4222-8333-444444444444",
    });

    const parsed = parseAppUrlState(serializeAppUrlState(original));
    expect(parsed).toEqual(original);
  });

  it("defaults both tracks to list but retains explicitly requested maps", () => {
    for (const track of ["house", "plex"]) {
      expect(parseAppUrlState(`?track=${track}&tab=search`).view).toBe("list");
      const map = parseAppUrlState(`?track=${track}&tab=search&view=map`);
      expect(map.view).toBe("map");
      expect(parseAppUrlState(serializeAppUrlState(map))).toEqual(map);
    }
  });

  it("accepts search strings with or without the leading question mark", () => {
    expect(parseAppUrlState("?tab=rejected").tab).toBe("rejected");
    expect(parseAppUrlState("tab=rejected").tab).toBe("rejected");
  });

  it("falls back to defaults on malformed or unknown values", () => {
    const parsed = parseAppUrlState("?tab=bogus&view=cube&edit=");
    expect(parsed.tab).toBe("market");
    expect(parsed.view).toBe("list");
    expect(parsed.editingId).toBeNull();
  });

  it("omits the view parameter outside the search tab", () => {
    const s = serializeAppUrlState(state({ tab: "rejected", view: "list" }));
    expect(s).not.toContain("view=");
  });

  it("dedupes statuses and drops empties when parsing", () => {
    const parsed = parseAppUrlState("?status=Active,,Active,Pending");
    expect(parsed.filters.statuses).toEqual(["Active", "Pending"]);
  });

  it("produces deterministic output so equal states share a scroll key", () => {
    const a = state({ tab: "search", view: "list", editingId: "x" });
    const b = state({ tab: "search", view: "list", editingId: "x" });
    expect(serializeAppUrlState(a)).toBe(serializeAppUrlState(b));
    expect(sameUrlState(a, b)).toBe(true);
    expect(sameUrlState(a, state({ tab: "search" }))).toBe(false);
  });
});

describe("searchStringFromParams (server-side route restoration)", () => {
  it("rebuilds a query string from Next-style searchParams", () => {
    expect(searchStringFromParams({ tab: "search", view: "list" })).toBe("?tab=search&view=list");
  });

  it("returns an empty string for no params (Home stays a clean URL)", () => {
    expect(searchStringFromParams({})).toBe("");
  });

  it("keeps the first value of repeated keys and skips undefined ones", () => {
    expect(searchStringFromParams({ tab: ["rejected", "search"], view: undefined })).toBe("?tab=rejected");
  });

  it("restores the full saved state before render: server-parsed state equals the client URL state", () => {
    // This is the no-Home-flash contract: app/page.tsx parses the request's
    // searchParams through this exact pipeline, so the server render (and
    // therefore the FIRST paint) already shows the saved tab, map/list
    // view, filters, and open editor instead of defaulting to Home.
    const saved = state({
      tab: "search",
      view: "list",
      filters: {
        statuses: ["Active"],
        maxPrice: "480000",
        minBedrooms: "3",
        maxYearBuilt: "1965",
        dateFrom: "2026-01-01",
        dateTo: "2026-06-30",
      },
      editingId: "eeeeeeee-1111-4222-8333-444444444444",
    });
    const clientSearch = serializeAppUrlState(saved);
    const serverParams = Object.fromEntries(new URLSearchParams(clientSearch.slice(1)).entries());
    expect(parseAppUrlState(searchStringFromParams(serverParams))).toEqual(saved);
  });

  it("falls back to defaults (Home) for mangled params rather than throwing", () => {
    const parsed = parseAppUrlState(searchStringFromParams({ tab: "bogus", view: ["cube"] }));
    expect(parsed).toEqual(DEFAULT_APP_URL_STATE);
  });
});

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("scroll restoration storage", () => {
  it("keys positions by pathname plus query string", () => {
    expect(scrollStorageKey("/", "?tab=search")).toBe("property-dashboard.scroll.v1:/?tab=search");
    expect(scrollStorageKey("/", "tab=search")).toBe("property-dashboard.scroll.v1:/?tab=search");
    expect(scrollStorageKey("/", "")).toBe("property-dashboard.scroll.v1:/");
    expect(scrollStorageKey("/", "?tab=search")).not.toBe(scrollStorageKey("/", "?tab=rejected"));
  });

  it("round-trips a saved position", () => {
    const storage = memoryStorage();
    const key = scrollStorageKey("/", "?tab=search");
    saveScrollPosition(storage, key, 1234.6);
    expect(readScrollPosition(storage, key)).toBe(1235);
  });

  it("removes the entry at top-of-page instead of storing zero", () => {
    const storage = memoryStorage();
    const key = scrollStorageKey("/", "");
    saveScrollPosition(storage, key, 500);
    saveScrollPosition(storage, key, 0);
    expect(storage.data.size).toBe(0);
    expect(readScrollPosition(storage, key)).toBeNull();
  });

  it("returns null for corrupted values and unknown keys", () => {
    const storage = memoryStorage();
    storage.setItem("k", "not-a-number");
    expect(readScrollPosition(storage, "k")).toBeNull();
    expect(readScrollPosition(storage, "missing")).toBeNull();
  });

  it("silently degrades when storage throws (private mode, quota)", () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
      removeItem: () => {
        throw new Error("nope");
      },
    };
    expect(() => saveScrollPosition(throwing, "k", 100)).not.toThrow();
    expect(readScrollPosition(throwing, "k")).toBeNull();
  });
});

describe("property track URL persistence", () => {
  it("defaults legacy and malformed links to Houses", () => {
    expect(parseAppUrlState("").track).toBe("house");
    expect(parseAppUrlState("?track=unknown").track).toBe("house");
  });

  it("round-trips Plexes with filters, view, archive and editor on refresh/history", () => {
    for (const tab of ["market", "search", "rejected"] as const) {
      const original = state({ track: "plex", tab, editingId: "plex-id", filters: { ...EMPTY_FILTER_FORM, maxPrice: "600000" } });
      const search = serializeAppUrlState(original);
      expect(search).toContain("track=plex");
      expect(parseAppUrlState(search)).toEqual(original);
      expect(sameUrlState(original, { ...original, track: "house" })).toBe(false);
      expect(scrollStorageKey("/", search)).not.toBe(scrollStorageKey("/", serializeAppUrlState({ ...original, track: "house" })));
    }
  });
});
