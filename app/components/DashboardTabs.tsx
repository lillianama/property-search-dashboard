"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearRefreshFeedback,
  INITIAL_REFRESH_STATE,
  settleRefresh,
  startRefresh,
} from "../../lib/refresh";
import { readScrollPosition, saveScrollPosition, scrollStorageKey } from "../../lib/scroll-restore";
import {
  DEFAULT_APP_URL_STATE,
  parseAppUrlState,
  serializeAppUrlState,
  type AppUrlState,
  type FilterFormValue,
  type HousesView,
  type TabId,
} from "../../lib/url-state";
import { TrackContext } from "./TrackContext";
import { Dashboard } from "./Dashboard";
import { MarketView } from "./MarketView";
import { RejectedView } from "./RejectedView";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "market", label: "Market" },
  { id: "search", label: "My Search" },
  { id: "rejected", label: "Rejected" },
];

/** How long the Refresh button's success/error feedback stays visible. */
const REFRESH_FEEDBACK_MS = 4000;

/** How long scroll restoration waits for content to grow tall enough
 * before giving up and scrolling as far as it can. */
const SCROLL_RESTORE_DEADLINE_MS = 3000;

/**
 * App-level coordinator: owns the URL-persisted view state (active tab, My
 * Search map/list view, applied filters, open editor property), restores
 * scroll position across refreshes via sessionStorage keyed by the URL,
 * and coordinates the global Refresh button (PostgreSQL re-fetch only —
 * never external Zillow/RMLS ingestion).
 */
export function DashboardTabs({
  initialUrlState = DEFAULT_APP_URL_STATE,
  pitiStorageKey,
}: {
  /** The saved URL state parsed from the request's query string on the
   * server (see app/page.tsx), so the server render and the first client
   * render both already show the saved tab/view — no Home flash, no
   * hydration mismatch. */
  initialUrlState?: AppUrlState;
  /** Optional deployment-specific browser storage key; supplied server-side. */
  pitiStorageKey?: string;
}) {
  // Server render and first client render share the server-parsed URL
  // state; the mount effect below re-reads window.location purely to stay
  // aligned with client-side history (back/forward, bfcache restores).
  const [urlState, setUrlState] = useState<AppUrlState>(initialUrlState);
  const activeScope = `${urlState.track}:${urlState.tab}`;
  const activeScopeRef = useRef(activeScope);
  activeScopeRef.current = activeScope;
  const [urlHydrated, setUrlHydrated] = useState(false);
  const [refresh, setRefresh] = useState(INITIAL_REFRESH_STATE);
  // Target scrollY waiting to be applied once the page is tall enough.
  const scrollTargetRef = useRef<number | null>(null);
  const scrollDeadlineRef = useRef(0);

  const queueScrollRestore = useCallback(() => {
    const y = readScrollPosition(
      window.sessionStorage,
      scrollStorageKey(window.location.pathname, window.location.search),
    );
    scrollTargetRef.current = y;
    scrollDeadlineRef.current = Date.now() + SCROLL_RESTORE_DEADLINE_MS;
  }, []);

  // Mount: take over scroll restoration, hydrate state from the URL, and
  // track back/forward navigation.
  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    setUrlState(parseAppUrlState(window.location.search));
    setUrlHydrated(true);
    queueScrollRestore();

    const onPopState = () => {
      setRefresh(INITIAL_REFRESH_STATE);
      setUrlState(parseAppUrlState(window.location.search));
      queueScrollRestore();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [queueScrollRestore]);

  // Persist the scroll position (throttled to animation frames) under the
  // CURRENT URL's key, so every tab/view/filter combination remembers its
  // own position across a refresh.
  useEffect(() => {
    if (!urlHydrated) return;
    const save = () => {
      saveScrollPosition(
        window.sessionStorage,
        scrollStorageKey(window.location.pathname, window.location.search),
        window.scrollY,
      );
    };
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        save();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("beforeunload", save);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [urlHydrated]);

  // Apply a queued scroll restore once content has grown tall enough (data
  // arrives async), giving up at the deadline rather than looping forever.
  useEffect(() => {
    if (!urlHydrated || scrollTargetRef.current === null) return;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      const target = scrollTargetRef.current;
      if (target === null) return;
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      if (maxY >= target || Date.now() > scrollDeadlineRef.current) {
        window.scrollTo(0, target);
        scrollTargetRef.current = null;
        return;
      }
      window.requestAnimationFrame(attempt);
    };
    attempt();
    return () => {
      cancelled = true;
    };
  });

  /**
   * Central state updater: applies the next URL state and writes it to the
   * address bar. Big navigations (tab switch, opening/closing the editor)
   * push a history entry so Back does the intuitive thing; transient
   * refinements (view toggle, filters) replace the current entry.
   */
  const applyUrlState = useCallback(
    (next: AppUrlState, mode: "push" | "replace") => {
      setUrlState(next);
      if (!urlHydrated) return;
      const search = serializeAppUrlState(next);
      const current = window.location.search;
      if (search === current || (search === "" && current === "?")) return;
      const url = `${window.location.pathname}${search}`;
      if (mode === "push") {
        window.history.pushState(null, "", url);
      } else {
        window.history.replaceState(null, "", url);
      }
    },
    [urlHydrated],
  );

  const setTab = useCallback(
    (tab: TabId) => {
      if (tab === urlState.tab) return;
      // Leaving a tab closes its editor; the destination tab starts clean.
      applyUrlState({ ...urlState, tab, editingId: null }, "push");
    },
    [applyUrlState, urlState],
  );

  const setView = useCallback(
    (view: HousesView) => applyUrlState({ ...urlState, view }, "replace"),
    [applyUrlState, urlState],
  );

  const setFilters = useCallback(
    (filters: FilterFormValue) => applyUrlState({ ...urlState, filters }, "replace"),
    [applyUrlState, urlState],
  );

  const openEditor = useCallback(
    (propertyId: string) => applyUrlState({ ...urlState, editingId: propertyId }, "push"),
    [applyUrlState, urlState],
  );

  const closeEditor = useCallback(() => {
    if (urlState.editingId === null) return;
    applyUrlState({ ...urlState, editingId: null }, "push");
  }, [applyUrlState, urlState]);

  // ── Global refresh (database re-fetch only) ────────────────────────────────

  const requestRefresh = useCallback(() => setRefresh((state) => startRefresh(state)), []);

  /** Reported by whichever view's load settles; only an in-flight refresh
   * consumes the outcome (routine loads never flash refresh feedback). */
  const handleLoadSettled = useCallback((ok: boolean) => {
    if (activeScopeRef.current !== activeScope) return;
    setRefresh((state) => settleRefresh(state, ok));
  }, [activeScope]);

  useEffect(() => {
    if (refresh.phase !== "success" && refresh.phase !== "error") return;
    const timer = window.setTimeout(
      () => setRefresh((state) => clearRefreshFeedback(state)),
      REFRESH_FEEDBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [refresh.phase]);

  const { tab, view, filters, editingId, track } = urlState;

  return (
    <main className="dashboard">
      <div className="view-toggle" role="group" aria-label="Property track">
        {(["house", "plex"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={track === value}
            className={`view-toggle-button${track === value ? " view-toggle-button-active" : ""}`}
            onClick={() => {
              if (track === value) return;
              setRefresh(INITIAL_REFRESH_STATE);
              applyUrlState({ ...urlState, track: value, editingId: null }, "push");
            }}>
            {value === "house" ? "Houses" : "Plexes"}
          </button>
        ))}
      </div>
      <nav className="tab-bar" aria-label="Dashboard views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab-button${tab === t.id ? " tab-button-active" : ""}`}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}

        <div className="refresh-control">
          <button
            type="button"
            className="btn-secondary refresh-button"
            onClick={requestRefresh}
            disabled={refresh.phase === "refreshing"}
            title="Re-fetch this view's data from the local PostgreSQL property store. Does not run any external Zillow/RMLS ingestion."
          >
            {refresh.phase === "refreshing" ? "Refreshing\u2026" : "Refresh"}
          </button>
          <span className="refresh-feedback" role="status" aria-live="polite">
            {refresh.phase === "refreshing" && <span>Re-fetching from the database{"\u2026"}</span>}
            {refresh.phase === "success" && <span className="refresh-feedback-success">Up to date.</span>}
            {refresh.phase === "error" && (
              <span className="refresh-feedback-error">Refresh failed {"\u2014"} showing the last loaded data.</span>
            )}
          </span>
        </div>
      </nav>

      {/* Remount the entire view on track changes: data, drafts, maps and optimistic moves stay isolated. */}
      <TrackContext.Provider key={track} value={track}>
        {tab === "market" && <MarketView refreshSeq={refresh.seq} onLoadSettled={handleLoadSettled} />}
        {tab === "search" && (
          <Dashboard
            pitiStorageKey={pitiStorageKey}
            view={view}
            onViewChange={setView}
            filters={filters}
            onFiltersChange={setFilters}
            editingId={editingId}
            onOpenEditor={openEditor}
            onCloseEditor={closeEditor}
            refreshSeq={refresh.seq}
            onLoadSettled={handleLoadSettled}
          />
        )}
        {tab === "rejected" && (
          <RejectedView
            editingId={editingId}
            onOpenEditor={openEditor}
            onCloseEditor={closeEditor}
            refreshSeq={refresh.seq}
            onLoadSettled={handleLoadSettled}
          />
        )}
      </TrackContext.Provider>
    </main>
  );
}
