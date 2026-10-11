// Scroll restoration across refreshes, keyed by the full URL so each
// tab/view/filter combination remembers its own position. Positions live in
// sessionStorage (per-tab, survives refresh, gone when the browser tab
// closes). The storage wrapper is injected so everything here is
// unit-testable with a plain object instead of a browser.

const STORAGE_PREFIX = "property-dashboard.scroll.v1:";

/** Minimal Storage surface used here (subset of DOM Storage). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Storage key for one URL: pathname plus the (already canonically ordered)
 * query string. Hash is excluded — in-page anchors shouldn't fork the
 * remembered position. */
export function scrollStorageKey(pathname: string, search: string): string {
  const query = search.startsWith("?") ? search : search ? `?${search}` : "";
  return `${STORAGE_PREFIX}${pathname}${query}`;
}

export function saveScrollPosition(
  storage: KeyValueStorage,
  key: string,
  scrollY: number,
): void {
  try {
    if (scrollY <= 0) {
      // Top-of-page is the default; storing it would only accumulate keys.
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, String(Math.round(scrollY)));
  } catch {
    // Storage unavailable/full: scroll restoration silently degrades.
  }
}

export function readScrollPosition(storage: KeyValueStorage, key: string): number | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
