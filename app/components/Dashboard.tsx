"use client";

import { useTrack } from "./TrackContext";
import { trackUrl } from "../../lib/track";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyEditorSaveToHouses, type EditorNotes } from "../../lib/editor";
import {
  applyLocalFunnelState,
  EMPTY_LOCAL_FUNNEL_STATE,
  FUNNEL_BUCKET_LABELS,
  type FunnelAction,
  type LocalFunnelState,
} from "../../lib/funnel";
import {
  DEFAULT_PITI_ASSUMPTIONS,
  parseStoredAssumptions,
  serializeAssumptions,
  type PitiAssumptions,
} from "../../lib/piti";
import { ROW_HIGHLIGHT_DURATION_MS, rowHighlightOnEditorClose } from "../../lib/row-highlight";
import type { DashboardResponse, HouseRecord } from "../../lib/types";
import type { FilterFormValue, HousesView } from "../../lib/url-state";
import { EMPTY_FILTER_FORM, FiltersBar } from "./FiltersBar";
import { FunnelBoard, type MovePlacement } from "./FunnelBoard";
import { KpiCards } from "./KpiCards";
import { PitiAssumptionsPanel } from "./PitiAssumptionsPanel";
import { PropertyEditorScreen } from "./PropertyEditorScreen";
import { PropertyMap } from "./PropertyMap";
import { RejectPropertyDialog } from "./RejectPropertyDialog";
import { CoverageNote, DbUnavailableBanner, EmptyDatasetBanner, LoadErrorBanner } from "./StatusBanners";
import { HistoryChart } from "./charts/HistoryChart";
import { PriceDistributionChart } from "./charts/PriceDistributionChart";
import { StatusDistributionChart } from "./charts/StatusDistributionChart";

function buildQueryString(form: FilterFormValue): string {
  const params = new URLSearchParams();
  if (form.statuses.length > 0) params.set("status", form.statuses.join(","));
  if (form.maxPrice.trim() !== "") params.set("maxPrice", form.maxPrice.trim());
  if (form.minBedrooms.trim() !== "") params.set("minBedrooms", form.minBedrooms.trim());
  if (form.maxYearBuilt.trim() !== "") params.set("maxYearBuilt", form.maxYearBuilt.trim());
  if (form.dateFrom.trim() !== "") params.set("dateFrom", form.dateFrom.trim());
  if (form.dateTo.trim() !== "") params.set("dateTo", form.dateTo.trim());
  const query = params.toString();
  return query ? `?${query}` : "";
}

function isDirty(form: FilterFormValue): boolean {
  return (
    form.statuses.length > 0 ||
    form.maxPrice.trim() !== "" ||
    form.minBedrooms.trim() !== "" ||
    form.maxYearBuilt.trim() !== "" ||
    form.dateFrom.trim() !== "" ||
    form.dateTo.trim() !== ""
  );
}

const VIEW_OPTIONS: Array<{ id: HousesView; label: string }> = [
  { id: "map", label: "Map" },
  { id: "list", label: "List" },
];
const DEFAULT_PITI_STORAGE_KEY = "real-estate-dashboard.piti-assumptions.v1";

export function Dashboard({
  view,
  onViewChange,
  filters,
  onFiltersChange,
  editingId,
  onOpenEditor,
  onCloseEditor,
  refreshSeq,
  onLoadSettled,
  pitiStorageKey: configuredPitiStorageKey,
}: {
  /** URL-persisted Map/List view, owned by the app-level coordinator. */
  view: HousesView;
  onViewChange: (view: HousesView) => void;
  /** URL-persisted APPLIED filters; the in-progress draft stays local. */
  filters: FilterFormValue;
  onFiltersChange: (filters: FilterFormValue) => void;
  /** URL-persisted open-editor property id (null = closed). */
  editingId: string | null;
  onOpenEditor: (propertyId: string) => void;
  onCloseEditor: () => void;
  /** Bumped by the global Refresh button to trigger a database re-fetch. */
  refreshSeq: number;
  /** Reports every settled load so the app-level refresh feedback is honest. */
  onLoadSettled: (ok: boolean) => void;
  /** Optional deployment-specific storage key, configured only at runtime. */
  pitiStorageKey?: string;
}) {
  const track = useTrack();
  const pitiStorageKey = configuredPitiStorageKey || DEFAULT_PITI_STORAGE_KEY;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [draft, setDraft] = useState<FilterFormValue>(filters);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Optimistic funnel moves/rejections layered over the server payload so
  // both views update immediately, with honest rollback on write failure.
  const [localFunnel, setLocalFunnel] = useState<LocalFunnelState>(EMPTY_LOCAL_FUNNEL_STATE);
  const [announcement, setAnnouncement] = useState("");
  // House pending rejection from a MAP quick view; the list view keeps its
  // own inline confirm inside the Rejected drop zone. Both feed requestMove.
  const [mapRejectTarget, setMapRejectTarget] = useState<HouseRecord | null>(null);
  // Row to briefly highlight after the editor opened from the list closes.
  const [highlightRowId, setHighlightRowId] = useState<string | null>(null);
  const prevEditingIdRef = useRef<string | null>(editingId);
  // Global PITI assumptions: start from defaults for a stable server render,
  // then hydrate any persisted values from localStorage after mount. Every
  // change recalculates the cards immediately and persists client-side only.
  const [pitiAssumptions, setPitiAssumptions] = useState<PitiAssumptions>(DEFAULT_PITI_ASSUMPTIONS);
  const [pitiHydrated, setPitiHydrated] = useState(false);

  // Keep the local draft in sync when the applied filters change from
  // outside this component (URL hydration, back/forward navigation).
  useEffect(() => {
    setDraft(filters);
  }, [filters]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(pitiStorageKey);
      setPitiAssumptions(parseStoredAssumptions(stored));
    } catch {
      // Storage unavailable (private mode, etc.): keep defaults in memory.
    }
    setPitiHydrated(true);
  }, [pitiStorageKey]);

  useEffect(() => {
    if (!pitiHydrated) return;
    try {
      window.localStorage.setItem(pitiStorageKey, serializeAssumptions(pitiAssumptions));
    } catch {
      // Best-effort persistence only; the in-memory value still applies.
    }
  }, [pitiAssumptions, pitiHydrated, pitiStorageKey]);

  // When the editor that was opened from a list row closes, briefly
  // highlight that row so the eye can re-find it, then let the CSS fade it
  // out (static cue under prefers-reduced-motion). Never scrolls or
  // repositions the list — the row simply glows in place.
  useEffect(() => {
    const previous = prevEditingIdRef.current;
    prevEditingIdRef.current = editingId;
    const rowId = rowHighlightOnEditorClose(previous, editingId, view);
    if (!rowId) return;
    setHighlightRowId(rowId);
    const timer = window.setTimeout(() => setHighlightRowId(null), ROW_HIGHLIGHT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [editingId, view]);

  const query = useMemo(() => buildQueryString(filters), [filters]);

  // The settle reporter lives in a ref so load() doesn't re-create (and
  // re-trigger the fetch effect) when the parent re-renders.
  const onLoadSettledRef = useRef(onLoadSettled);
  onLoadSettledRef.current = onLoadSettled;

  const load = useCallback(async (signal: AbortSignal) => {
    if (!mountedRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(trackUrl(`/api/dashboard${query}`, track), { signal, cache: "no-store" });
      if (!res.ok) {
        throw new Error(`request failed with status ${res.status}`);
      }
      const json = (await res.json()) as DashboardResponse;
      if (signal.aborted || !mountedRef.current) return;
      setData(json);
      // A fresh payload is authoritative: drop optimistic overlays so rows
      // reflect exactly what the database returned.
      setLocalFunnel(EMPTY_LOCAL_FUNNEL_STATE);
      onLoadSettledRef.current(true);
    } catch (err) {
      if (signal.aborted || !mountedRef.current || (err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "unknown error");
      onLoadSettledRef.current(false);
    } finally {
      if (!signal.aborted && mountedRef.current) setLoading(false);
    }
  }, [query, track]);

  // Initial load, filter changes, and global refreshes all funnel through
  // this one effect; refreshSeq bumps re-run it against the same query.
  useEffect(() => {
    void refreshSeq;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, refreshSeq]);

  const visibleProperties = useMemo(
    () => (data ? applyLocalFunnelState(data.properties, localFunnel) : []),
    [data, localFunnel],
  );

  const editingHouse = useMemo(
    () => (editingId && data ? (data.properties.find((p) => p.id === editingId) ?? null) : null),
    [editingId, data],
  );

  /** Successful editor saves patch the already-loaded rows in place with
   * the server-confirmed values, so judgment pills update immediately
   * without a reload. Failed saves never reach this callback. */
  const handleEditorSaved = useCallback((propertyId: string, notes: EditorNotes) => {
    setData((current) => {
      if (!current) return current;
      const properties = applyEditorSaveToHouses(current.properties, propertyId, notes);
      return properties === current.properties ? current : { ...current, properties };
    });
  }, []);

  // Monotonic sequence for optimistic ordering placements, so multiple
  // in-flight drags replay deterministically.
  const placementSeqRef = useRef(0);

  /**
   * Applies a funnel move optimistically (bucket, ordering placement, or
   * rejection), persists it through the narrow /api/funnel/move endpoint,
   * and rolls back exactly this move (announcing the failure) if the write
   * does not land — including 409 stale-order conflicts from concurrent
   * moves, which additionally refresh the payload so the true order shows.
   */
  const requestMove = useCallback(
    async (
      house: HouseRecord,
      action: FunnelAction,
      options: { note?: string | null; placement?: MovePlacement } = {},
    ) => {
      const { note = null, placement } = options;
      const targetLabel = action === "reject" ? "Rejected archive" : FUNNEL_BUCKET_LABELS[action];

      // Snapshot exactly what this move overwrites so rollback restores it
      // even with other optimistic moves in flight.
      let prevMove: FunnelAction | undefined;
      let prevPlacement: LocalFunnelState["placements"][string] | undefined;

      setLocalFunnel((prev) => {
        prevMove = prev.moves[house.id];
        prevPlacement = prev.placements[house.id];
        if (action === "reject") {
          return { ...prev, rejectedIds: [...prev.rejectedIds, house.id] };
        }
        const next: LocalFunnelState = {
          ...prev,
          moves: { ...prev.moves, [house.id]: action },
          placements: { ...prev.placements },
        };
        if (placement) {
          next.placements[house.id] = {
            bucket: action,
            afterId: placement.afterId,
            beforeId: placement.beforeId,
            seq: placementSeqRef.current++,
          };
        } else {
          delete next.placements[house.id];
        }
        return next;
      });
      setAnnouncement(`Moving ${house.address} to ${targetLabel}\u2026`);

      const rollback = () => {
        setLocalFunnel((prev) => {
          if (action === "reject") {
            return { ...prev, rejectedIds: prev.rejectedIds.filter((id) => id !== house.id) };
          }
          const moves = { ...prev.moves };
          const placements = { ...prev.placements };
          if (prevMove !== undefined && prevMove !== "reject") moves[house.id] = prevMove;
          else delete moves[house.id];
          if (prevPlacement !== undefined) placements[house.id] = prevPlacement;
          else delete placements[house.id];
          return { ...prev, moves, placements };
        });
      };

      try {
        const res = await fetch(trackUrl("/api/funnel/move", track), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            propertyId: house.id,
            action,
            ...(note ? { note } : {}),
            ...(placement?.afterId ? { afterId: placement.afterId } : {}),
            ...(placement?.beforeId ? { beforeId: placement.beforeId } : {}),
          }),
        });
        if (res.status === 409) {
          // A concurrent move made this placement stale. Nothing was
          // written server-side; roll back and re-fetch the true order.
          rollback();
          setAnnouncement(
            `Could not place ${house.address}: the list changed under you. Reloading the current order.`,
          );
          const controller = new AbortController();
          load(controller.signal);
          return;
        }
        if (!res.ok) {
          throw new Error(`request failed with status ${res.status}`);
        }
        setAnnouncement(
          action === "reject"
            ? `${house.address} rejected. It now lives in the Rejected archive tab.`
            : `${house.address} moved to ${targetLabel}.`,
        );
      } catch {
        // Honest rollback: undo exactly this house's optimistic change.
        rollback();
        setAnnouncement(`Could not move ${house.address} to ${targetLabel}. The change was not saved.`);
      }
    },
    [load],
  );

  return (
    <>
      <header className="dashboard-header">
        <p className="eyebrow">PRIVATE MARKET INTELLIGENCE</p>
        <h1>My Search</h1>
        <p className="lede">
          A research log of the {track === "plex" ? "plexes" : "houses"} you have tracked in the property store: current status, prices,
          bedroom sizing, and how that set has grown over time. Not a live market feed.
        </p>
      </header>

      <FiltersBar
        value={draft}
        onChange={setDraft}
        onApply={() => onFiltersChange(draft)}
        onReset={() => {
          setDraft(EMPTY_FILTER_FORM);
          onFiltersChange(EMPTY_FILTER_FORM);
        }}
        isDirty={isDirty(draft) || isDirty(filters)}
      />

      {error && <LoadErrorBanner message={error} />}
      {!error && data && !data.meta.dbAvailable && <DbUnavailableBanner />}
      {!error && data && data.meta.dbAvailable && data.properties.length === 0 && <EmptyDatasetBanner />}

      {loading && !data && <p className="loading-note">Loading dashboard data{"\u2026"}</p>}

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      {data && (
        <>
          <KpiCards summary={data.summary} />

          <section className="dashboard-section">
            <h2>Tracked listing activity over time</h2>
            <p className="section-note">
              Monthly count of listing events this dashboard has recorded, and their median price. This is the
              tracked/researched dataset, <strong>not</strong> full Portland MLS inventory.
            </p>
            <HistoryChart data={data.history} />
          </section>

          <section className="dashboard-grid-2">
            <div className="dashboard-section">
              <h2>Price distribution</h2>
              <PriceDistributionChart data={data.priceDistribution} />
            </div>
            <div className="dashboard-section">
              <h2>Status distribution</h2>
              <StatusDistributionChart data={data.statusDistribution} />
            </div>
          </section>

          <section className="dashboard-section">
            <div className="houses-view-header">
              <h2 id="houses-view-heading">Tracked {track === "plex" ? "plexes" : "houses"}</h2>
              <div className="view-toggle" role="group" aria-label="Tracked properties view">
                {VIEW_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`view-toggle-button${view === option.id ? " view-toggle-button-active" : ""}`}
                    aria-pressed={view === option.id}
                    onClick={() => onViewChange(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="section-note">{data.meta.photoCoverageNote}</p>
            <p className="section-note">{data.meta.streetViewNote}</p>

            {view === "map" ? (
              <PropertyMap
                properties={visibleProperties}
                large
                onEditNotes={(house) => onOpenEditor(house.id)}
                onReject={setMapRejectTarget}
              />
            ) : (
              <>
                <PitiAssumptionsPanel value={pitiAssumptions} onChange={setPitiAssumptions} />
                <FunnelBoard
                  properties={visibleProperties}
                  placements={localFunnel.placements}
                  onMove={requestMove}
                  pitiAssumptions={pitiAssumptions}
                  onEditNotes={(house) => onOpenEditor(house.id)}
                  highlightId={highlightRowId}
                />
              </>
            )}
          </section>

          {mapRejectTarget && (
            <RejectPropertyDialog
              house={mapRejectTarget}
              onCancel={() => setMapRejectTarget(null)}
              onConfirm={(note) => {
                // Same optimistic + persisted workflow as the list view:
                // the house leaves both views immediately, with honest
                // rollback if the write fails.
                requestMove(mapRejectTarget, "reject", { note });
                setMapRejectTarget(null);
              }}
            />
          )}

          {editingId && (
            <PropertyEditorScreen
              propertyId={editingId}
              address={editingHouse?.address ?? "Tracked property"}
              onClose={onCloseEditor}
              onSaved={handleEditorSaved}
            />
          )}

          <CoverageNote note={data.meta.coverageNote} />
          <p className="generated-at">
            Generated {new Date(data.meta.generatedAt).toLocaleString()} {"\u00b7"} {data.meta.trackedPropertyTotal} {track === "plex" ? "plexes" : "houses"}
            tracked in total (before filters)
          </p>
        </>
      )}
    </>
  );
}
