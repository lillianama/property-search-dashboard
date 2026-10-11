"use client";

import { useTrack } from "./TrackContext";
import { trackUrl } from "../../lib/track";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RejectedHousesResponse } from "../../lib/types";
import { PropertyEditorScreen } from "./PropertyEditorScreen";
import { RejectedTable } from "./RejectedTable";
import { DbUnavailableBanner, EmptyRejectedBanner, LoadErrorBanner } from "./StatusBanners";

/**
 * The Rejected archive: a separate, intentionally-selected view so rejected
 * houses never clutter My Search, but nothing is ever deleted or hidden
 * from the user. Only houses with an explicit human rejection as their
 * latest recorded decision appear here — see lib/rejection.ts.
 */
export function RejectedView({
  editingId,
  onOpenEditor,
  onCloseEditor,
  refreshSeq,
  onLoadSettled,
}: {
  /** URL-persisted open-editor property id (null = closed). */
  editingId: string | null;
  onOpenEditor: (propertyId: string) => void;
  onCloseEditor: () => void;
  /** Bumped by the global Refresh button to trigger a database re-fetch. */
  refreshSeq: number;
  /** Reports every settled load so the app-level refresh feedback is honest. */
  onLoadSettled: (ok: boolean) => void;
}) {
  const track = useTrack();
  const [data, setData] = useState<RejectedHousesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onLoadSettledRef = useRef(onLoadSettled);
  onLoadSettledRef.current = onLoadSettled;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(trackUrl("/api/rejected", track), { signal: controller.signal, cache: "no-store" });
        if (!res.ok) {
          throw new Error(`request failed with status ${res.status}`);
        }
        const json = (await res.json()) as RejectedHousesResponse;
        if (controller.signal.aborted) return;
        setData(json);
        onLoadSettledRef.current(true);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "unknown error");
        onLoadSettledRef.current(false);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refreshSeq, track]);

  const editingAddress = useMemo(
    () =>
      editingId ? (data?.properties.find((p) => p.id === editingId)?.address ?? "Tracked property") : null,
    [editingId, data],
  );

  return (
    <>
      <header className="dashboard-header">
        <p className="eyebrow">MY SEARCH {"\u00b7"} ARCHIVE</p>
        <h1>Rejected</h1>
        <p className="lede">
          Properties you have explicitly ruled out, kept separately so they never clutter the main search. Nothing is
          deleted: every rejection reason and date is preserved here, and a later reconsideration automatically
          moves a property back to My Search.
        </p>
      </header>

      {error && <LoadErrorBanner message={error} />}
      {!error && data && !data.meta.dbAvailable && <DbUnavailableBanner />}
      {!error && data && data.meta.dbAvailable && data.properties.length === 0 && <EmptyRejectedBanner />}

      {loading && !data && <p className="loading-note">Loading rejected properties{"\u2026"}</p>}

      {data && data.meta.dbAvailable && data.properties.length > 0 && (
        <>
          <section className="dashboard-section">
            <h2>Rejected {track === "plex" ? "plexes" : "houses"}</h2>
            <p className="section-note">{data.meta.photoCoverageNote}</p>
            <p className="section-note">{data.meta.streetViewNote}</p>
            <RejectedTable
              properties={data.properties}
              onEditNotes={(house) => onOpenEditor(house.id)}
            />
          </section>
          <p className="generated-at">
            Generated {new Date(data.meta.generatedAt).toLocaleString()} {"\u00b7"} {data.properties.length} rejected
          </p>
        </>
      )}

      {editingId && (
        <PropertyEditorScreen
          propertyId={editingId}
          address={editingAddress ?? "Tracked property"}
          onClose={onCloseEditor}
        />
      )}
    </>
  );
}
