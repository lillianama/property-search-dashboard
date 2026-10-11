import { parseTrack, type PropertyTrack } from "./track";
// URL persistence for the dashboard's client-side view state: active top
// tab, My Search map/list view, applied filters, and the open editor
// property. Pure and dependency-free (no window/history access here) so
// parsing and serialization round-trip in unit tests; the components apply
// these helpers with pushState/replaceState.

export type TabId = "market" | "search" | "rejected";

export const DEFAULT_TAB: TabId = "market";

export type HousesView = "map" | "list";

export const DEFAULT_HOUSES_VIEW: HousesView = "map";

/** The filter form exactly as typed (strings, not parsed numbers). Kept
 * here so both the FiltersBar component and URL round-tripping share one
 * canonical shape. */
export interface FilterFormValue {
  statuses: string[];
  maxPrice: string;
  minBedrooms: string;
  maxYearBuilt: string;
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_FILTER_FORM: FilterFormValue = {
  statuses: [],
  maxPrice: "",
  minBedrooms: "",
  maxYearBuilt: "",
  dateFrom: "",
  dateTo: "",
};

/** Everything the dashboard persists in the URL. */
export interface AppUrlState {
  track: PropertyTrack;
  tab: TabId;
  view: HousesView;
  filters: FilterFormValue;
  /** Property id of the open editor screen, or null when closed. */
  editingId: string | null;
}

export const DEFAULT_APP_URL_STATE: AppUrlState = {
  track: "house",
  tab: DEFAULT_TAB,
  view: DEFAULT_HOUSES_VIEW,
  filters: EMPTY_FILTER_FORM,
  editingId: null,
};

function isTabId(value: string | null): value is TabId {
  return value === "market" || value === "search" || value === "rejected";
}

function isHousesView(value: string | null): value is HousesView {
  return value === "map" || value === "list";
}

/**
 * Parses the app state from a query string (with or without the leading
 * "?"). Never throws: malformed or unknown values fall back to defaults so
 * a mangled shared link still loads the dashboard.
 */
export function parseAppUrlState(search: string): AppUrlState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  const rawTab = params.get("tab");
  const rawView = params.get("view");
  const rawEdit = params.get("edit");

  const statuses = (params.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    track: parseTrack(params.get("track")),
    tab: isTabId(rawTab) ? rawTab : DEFAULT_TAB,
    view: isHousesView(rawView) ? rawView : DEFAULT_HOUSES_VIEW,
    filters: {
      statuses: Array.from(new Set(statuses)),
      maxPrice: params.get("maxPrice") ?? "",
      minBedrooms: params.get("minBedrooms") ?? "",
      maxYearBuilt: params.get("maxYearBuilt") ?? "",
      dateFrom: params.get("dateFrom") ?? "",
      dateTo: params.get("dateTo") ?? "",
    },
    editingId: rawEdit && rawEdit.trim() !== "" ? rawEdit : null,
  };
}

/**
 * Serializes the app state to a query string ("" or "?..."). Defaults are
 * omitted so pristine state keeps a clean URL, and the parameter order is
 * fixed so identical states always produce identical strings (the scroll
 * restoration key depends on that).
 */
export function serializeAppUrlState(state: AppUrlState): string {
  const params = new URLSearchParams();
  if (state.track === "plex") params.set("track", state.track);
  if (state.tab !== DEFAULT_TAB) params.set("tab", state.tab);
  if (state.tab === "search" && state.view !== DEFAULT_HOUSES_VIEW) params.set("view", state.view);
  const f = state.filters;
  if (f.statuses.length > 0) params.set("status", f.statuses.join(","));
  if (f.maxPrice.trim() !== "") params.set("maxPrice", f.maxPrice.trim());
  if (f.minBedrooms.trim() !== "") params.set("minBedrooms", f.minBedrooms.trim());
  if (f.maxYearBuilt.trim() !== "") params.set("maxYearBuilt", f.maxYearBuilt.trim());
  if (f.dateFrom.trim() !== "") params.set("dateFrom", f.dateFrom.trim());
  if (f.dateTo.trim() !== "") params.set("dateTo", f.dateTo.trim());
  if (state.editingId) params.set("edit", state.editingId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Next-style searchParams shape (each value a string, repeated-key array,
 * or absent). */
export type ServerSearchParams = Record<string, string | string[] | undefined>;

/**
 * Rebuilds a query string ("" or "?...") from Next's server-side
 * searchParams object so the SAVED route/view can be parsed during the
 * server render — before any dashboard content is painted — instead of the
 * default (Home) tab flashing first and being corrected after hydration.
 * Repeated keys keep their first value, matching URLSearchParams.get().
 */
export function searchStringFromParams(params: ServerSearchParams): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    searchParams.set(key, Array.isArray(value) ? (value[0] ?? "") : value);
  }
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

/** True when the two states serialize to the same URL, i.e. no history
 * update is needed. */
export function sameUrlState(a: AppUrlState, b: AppUrlState): boolean {
  return serializeAppUrlState(a) === serializeAppUrlState(b);
}
