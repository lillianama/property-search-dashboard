"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTION_EDIT_CLASS, ACTION_REJECT_CLASS } from "../../lib/action-styles";
import { createAutoscroller, type Autoscroller } from "../../lib/drag-autoscroll";
import {
  FUNNEL_BUCKETS,
  FUNNEL_BUCKET_LABELS,
  groupByBucket,
  type FunnelAction,
  type LocalPlacement,
} from "../../lib/funnel";
import { formatCurrency, formatDate, formatNumber, formatYear } from "../../lib/format";
import { computePiti, type PitiAssumptions } from "../../lib/piti";
import type { FunnelBucket, HouseRecord, QuickJudgments, TriStateJudgment } from "../../lib/types";
import { PlexUnits } from "./PlexUnits";
import { RejectPropertyDialog } from "./RejectPropertyDialog";
import { useTrack } from "./TrackContext";
import { PropertyPhoto } from "./PropertyPhoto";

const FLAG_LABELS: Record<HouseRecord["bedroomSizeFlag"], string> = {
  critical: "Beds critical (<90 sqft)",
  small: "Beds small (90\u2013<100 sqft)",
  ok: "Beds OK (\u2265100 sqft)",
  unknown: "Beds unmeasured",
};

const FLAG_TITLES: Record<HouseRecord["bedroomSizeFlag"], string> = {
  critical: "Measured bedroom sizing: critical \u2014 smallest bedroom under 90 sqft (published measurements)",
  small: "Measured bedroom sizing: small \u2014 smallest bedroom 90 to under 100 sqft (published measurements)",
  ok: "Measured bedroom sizing: OK \u2014 every measured bedroom is 100 sqft or larger (published measurements)",
  unknown: "Measured bedroom sizing: unknown \u2014 no published bedroom dimensions recorded",
};

const BUCKET_HINTS: Record<FunnelBucket, string> = {
  "top-contenders": "The short list \u2014 properties the user is seriously considering.",
  "to-tour": "Queued up to visit.",
  watchlist: "Everything else being tracked. New properties land here by default.",
};

const JUDGMENT_SHORT_LABELS: Record<keyof QuickJudgments, string> = {
  bedroomSizeOk: "Bed size",
  rentalIncome: "Rental",
  drumSpace: "Drums",
};

const JUDGMENT_FULL_LABELS: Record<keyof QuickJudgments, string> = {
  bedroomSizeOk: "Bedroom size acceptable (the user’s judgment \u2014 does not change the measured flag)",
  rentalIncome: "Can support rental income (separate studio, basement unit, ADU-like space)",
  drumSpace: "Has a place to play drums",
};

/** The exact placement a drop/keyboard commit requests: target bucket plus
 * the display neighbors at that spot. */
export interface MovePlacement {
  afterId: string | null;
  beforeId: string | null;
}

/** A rejected drop is destructive-ish (the house leaves My Search), so it
 * always goes through this confirmation instead of committing on drop. */
interface PendingReject {
  house: HouseRecord;
}

/** In-flight keyboard drag: the grabbed house and its current preview
 * position (bucket + index within that bucket, dragged row excluded). */
interface KeyboardDrag {
  houseId: string;
  bucket: FunnelBucket;
  index: number;
}

export function FunnelBoard({
  properties,
  placements,
  onMove,
  onWatchlistBottom,
  bottomMoveBusy = false,
  pitiAssumptions,
  onEditNotes,
  highlightId = null,
}: {
  properties: HouseRecord[];
  placements: Record<string, LocalPlacement>;
  onMove: (
    house: HouseRecord,
    action: FunnelAction,
    options?: { note?: string | null; placement?: MovePlacement },
  ) => void;
  onWatchlistBottom: (house: HouseRecord) => void;
  bottomMoveBusy?: boolean;
  pitiAssumptions: PitiAssumptions;
  onEditNotes: (house: HouseRecord) => void;
  /** Row to briefly highlight (editor-close return cue); null = none. */
  highlightId?: string | null;
}) {
  const groups = useMemo(() => groupByBucket(properties, placements), [properties, placements]);
  const byId = useMemo(() => new Map(properties.map((p) => [p.id, p])), [properties]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Pointer-drag drop indicator: bucket + insertion index (or the reject zone).
  const [dropIndicator, setDropIndicator] = useState<{ bucket: FunnelBucket; index: number } | null>(null);
  const [rejectHover, setRejectHover] = useState(false);
  const [pendingReject, setPendingReject] = useState<PendingReject | null>(null);
  const [keyboardDrag, setKeyboardDrag] = useState<KeyboardDrag | null>(null);
  const [kbAnnouncement, setKbAnnouncement] = useState("");
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());

  /** Rows of one bucket without the actively dragged row, i.e. the list an
   * insertion index refers to. */
  const rowsWithout = useCallback(
    (bucket: FunnelBucket, excludeId: string | null) =>
      excludeId === null ? groups[bucket] : groups[bucket].filter((h) => h.id !== excludeId),
    [groups],
  );

  const placementAt = useCallback(
    (bucket: FunnelBucket, index: number, excludeId: string): MovePlacement => {
      const rows = rowsWithout(bucket, excludeId);
      const clamped = Math.max(0, Math.min(index, rows.length));
      return {
        afterId: clamped > 0 ? rows[clamped - 1].id : null,
        beforeId: clamped < rows.length ? rows[clamped].id : null,
      };
    },
    [rowsWithout],
  );

  const commitMove = useCallback(
    (house: HouseRecord, bucket: FunnelBucket, index: number) => {
      const placement = placementAt(bucket, index, house.id);
      onMove(house, bucket, { placement });
    },
    [onMove, placementAt],
  );

  // ── Pointer drag/drop ──────────────────────────────────────────────────────

  // Viewport-edge auto-scroll while a pointer drag is in flight. Lazily
  // created, driven from dragover positions, and always stopped on
  // drop/dragend/cancel and unmount. Keyboard dragging never touches this —
  // it relies on focus scrolling, so accessibility behavior is unchanged.
  const autoscrollerRef = useRef<Autoscroller | null>(null);

  const autoscrollUpdate = useCallback((clientY: number) => {
    if (!autoscrollerRef.current) autoscrollerRef.current = createAutoscroller();
    autoscrollerRef.current.update(clientY, window.innerHeight);
  }, []);

  const autoscrollStop = useCallback(() => {
    autoscrollerRef.current?.stop();
  }, []);

  useEffect(() => () => autoscrollerRef.current?.stop(), []);

  // Native HTML5 drags only fire dragover on valid drop targets; listening
  // document-wide keeps edge auto-scroll working while the pointer travels
  // the gaps between buckets. Bounded to the duration of one drag.
  useEffect(() => {
    if (!draggingId) return;
    const onDragOver = (event: DragEvent) => autoscrollUpdate(event.clientY);
    const onDragEnd = () => autoscrollStop();
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDragEnd);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDragEnd);
      document.removeEventListener("dragend", onDragEnd);
      autoscrollStop();
    };
  }, [draggingId, autoscrollUpdate, autoscrollStop]);

  const clearDrag = () => {
    setDraggingId(null);
    setDropIndicator(null);
    setRejectHover(false);
    autoscrollStop();
  };

  const handleListDragOver = (bucket: FunnelBucket) => (event: React.DragEvent) => {
    if (!draggingId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setRejectHover(false);

    // Insertion index from the pointer position relative to row midlines.
    const list = event.currentTarget as HTMLElement;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-row-id]")).filter(
      (el) => el.dataset.rowId !== draggingId,
    );
    let index = rows.length;
    for (let i = 0; i < rows.length; i += 1) {
      const rect = rows[i].getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        index = i;
        break;
      }
    }
    setDropIndicator((current) =>
      current && current.bucket === bucket && current.index === index ? current : { bucket, index },
    );
  };

  const handleListDrop = (bucket: FunnelBucket) => (event: React.DragEvent) => {
    event.preventDefault();
    const house = draggingId ? byId.get(draggingId) : undefined;
    const indicator = dropIndicator;
    clearDrag();
    if (!house) return;
    const index = indicator && indicator.bucket === bucket ? indicator.index : rowsWithout(bucket, house.id).length;
    commitMove(house, bucket, index);
  };

  const rejectZoneProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!draggingId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropIndicator(null);
      setRejectHover(true);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setRejectHover(false);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const house = draggingId ? byId.get(draggingId) : undefined;
      clearDrag();
      if (house) setPendingReject({ house });
    },
  };

  // ── Keyboard drag (Space grab \u00b7 arrows move \u00b7 Space/Enter drop \u00b7 Esc cancel) ─

  const bucketAndIndexOf = useCallback(
    (houseId: string): { bucket: FunnelBucket; index: number } | null => {
      for (const bucket of FUNNEL_BUCKETS) {
        const index = groups[bucket].findIndex((h) => h.id === houseId);
        if (index !== -1) return { bucket, index };
      }
      return null;
    },
    [groups],
  );

  const announceKb = (drag: KeyboardDrag, house: HouseRecord, picked = false) => {
    const rows = rowsWithout(drag.bucket, drag.houseId);
    const position = `position ${drag.index + 1} of ${rows.length + 1} in ${FUNNEL_BUCKET_LABELS[drag.bucket]}`;
    setKbAnnouncement(
      picked
        ? `Grabbed ${house.address}, ${position}. Arrow keys move, Space or Enter drops, Escape cancels.`
        : `${house.address}, ${position}.`,
    );
  };

  const handleHandleKeyDown = (house: HouseRecord) => (event: React.KeyboardEvent) => {
    const isGrabbed = keyboardDrag?.houseId === house.id;

    if (!isGrabbed) {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        const pos = bucketAndIndexOf(house.id);
        if (!pos) return;
        const drag = { houseId: house.id, bucket: pos.bucket, index: pos.index };
        setKeyboardDrag(drag);
        announceKb(drag, house, true);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setKeyboardDrag(null);
      setKbAnnouncement(`Move cancelled. ${house.address} stays where it was.`);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      const drag = keyboardDrag as KeyboardDrag;
      setKeyboardDrag(null);
      const origin = bucketAndIndexOf(house.id);
      if (origin && origin.bucket === drag.bucket && origin.index === drag.index) {
        setKbAnnouncement(`${house.address} kept its position.`);
        return;
      }
      setKbAnnouncement(`Dropped ${house.address} in ${FUNNEL_BUCKET_LABELS[drag.bucket]}.`);
      commitMove(house, drag.bucket, drag.index);
      return;
    }

    const drag = keyboardDrag as KeyboardDrag;
    const move = (next: KeyboardDrag) => {
      setKeyboardDrag(next);
      announceKb(next, house);
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const rows = rowsWithout(drag.bucket, drag.houseId);
      if (drag.index < rows.length) {
        move({ ...drag, index: drag.index + 1 });
      } else {
        const bucketIdx = FUNNEL_BUCKETS.indexOf(drag.bucket);
        if (bucketIdx < FUNNEL_BUCKETS.length - 1) {
          move({ ...drag, bucket: FUNNEL_BUCKETS[bucketIdx + 1], index: 0 });
        }
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (drag.index > 0) {
        move({ ...drag, index: drag.index - 1 });
      } else {
        const bucketIdx = FUNNEL_BUCKETS.indexOf(drag.bucket);
        if (bucketIdx > 0) {
          const prev = FUNNEL_BUCKETS[bucketIdx - 1];
          move({ ...drag, bucket: prev, index: rowsWithout(prev, drag.houseId).length });
        }
      }
    }
  };

  // Keep focus on the grabbed row's handle as it re-renders in new spots.
  useEffect(() => {
    if (!keyboardDrag) return;
    handleRefs.current.get(keyboardDrag.houseId)?.focus();
  });

  if (properties.length === 0) {
    return <p className="chart-empty">No tracked properties match the current filters.</p>;
  }

  /** Render order for one bucket with the keyboard preview applied. */
  const displayRows = (bucket: FunnelBucket): Array<HouseRecord | "indicator"> => {
    let rows: HouseRecord[] = groups[bucket];
    if (keyboardDrag) {
      const grabbed = byId.get(keyboardDrag.houseId);
      rows = rows.filter((h) => h.id !== keyboardDrag.houseId);
      if (grabbed && keyboardDrag.bucket === bucket) {
        rows = [...rows.slice(0, keyboardDrag.index), grabbed, ...rows.slice(keyboardDrag.index)];
      }
    }
    if (draggingId && dropIndicator && dropIndicator.bucket === bucket) {
      const without = rows.filter((h) => h.id !== draggingId);
      const out: Array<HouseRecord | "indicator"> = [...without];
      out.splice(Math.min(dropIndicator.index, without.length), 0, "indicator");
      return out;
    }
    return rows;
  };

  return (
    <div className="funnel-board">
      <p className="section-note">
        Drag a row between or within buckets to set both its bucket and its place in your one global ranking
        {" \u2014 "}order is the ranking; there are no numbers. Keyboard: focus a row{"\u2019"}s handle, press Space
        to grab, arrows to move, Space or Enter to drop, Escape to cancel. Dropping on Rejected asks for
        confirmation first, then archives the property to the Rejected tab.
      </p>

      <p className="visually-hidden" role="status" aria-live="assertive">
        {kbAnnouncement}
      </p>

      {FUNNEL_BUCKETS.map((bucket) => (
        <section
          key={bucket}
          className="funnel-bucket"
          aria-label={`${FUNNEL_BUCKET_LABELS[bucket]} (${groups[bucket].length})`}
        >
          <header className="funnel-bucket-header">
            <h3>
              {FUNNEL_BUCKET_LABELS[bucket]} <span className="funnel-bucket-count">{groups[bucket].length}</span>
            </h3>
            <p className="funnel-bucket-hint">{BUCKET_HINTS[bucket]}</p>
          </header>

          <ul
            className="funnel-row-list"
            onDragOver={handleListDragOver(bucket)}
            onDrop={handleListDrop(bucket)}
          >
            {displayRows(bucket).length === 0 && (
              <li className="funnel-bucket-empty" aria-hidden={draggingId !== null}>
                Nothing here right now. Drop a row to place it.
              </li>
            )}
            {displayRows(bucket).map((entry, i) =>
              entry === "indicator" ? (
                <li key={`indicator-${i}`} className="funnel-drop-indicator" aria-hidden="true" />
              ) : (
                <li key={entry.id} data-row-id={entry.id}>
                  <FunnelRow
                    house={entry}
                    pitiAssumptions={pitiAssumptions}
                    dragging={draggingId === entry.id}
                    grabbed={keyboardDrag?.houseId === entry.id}
                    highlighted={highlightId === entry.id}
                    registerHandle={(el) => {
                      if (el) handleRefs.current.set(entry.id, el);
                      else handleRefs.current.delete(entry.id);
                    }}
                    onHandleKeyDown={handleHandleKeyDown(entry)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", entry.id);
                      setDraggingId(entry.id);
                    }}
                    onDragEnd={clearDrag}
                    onReject={() => setPendingReject({ house: entry })}
                    onEditNotes={() => onEditNotes(entry)}
                    onBottom={bucket === "watchlist" ? () => onWatchlistBottom(entry) : undefined}
                    bottomMoveBusy={bottomMoveBusy}
                    onQuickMove={bucket === "watchlist" ? (target) => commitMove(entry, target, 0) : undefined}
                  />
                </li>
              ),
            )}
          </ul>
        </section>
      ))}

      <section
        className={`funnel-bucket funnel-bucket-reject${rejectHover ? " funnel-bucket-droptarget" : ""}`}
        aria-label="Rejected (drop target)"
        {...rejectZoneProps}
      >
        <header className="funnel-bucket-header">
          <h3>Rejected</h3>
          <p className="funnel-bucket-hint">
            Drop a property here (or use a row{"\u2019"}s Reject button) to rule it out. It leaves My Search
            immediately and lives on in the Rejected tab {"\u2014"} nothing is deleted, its ranking is remembered,
            and a later reconsideration brings it back.
          </p>
        </header>


      </section>
      {pendingReject && (
        <RejectPropertyDialog
          house={pendingReject.house}
          onConfirm={(note) => {
            onMove(pendingReject.house, "reject", { note });
            setPendingReject(null);
          }}
          onCancel={() => setPendingReject(null)}
        />
      )}
    </div>
  );
}

/** Human-readable provenance for the actual recorded tax amount: tax year
 * (RentCast county bills) or as-of date, plus the source. */
function describeTaxProvenance(house: HouseRecord): string {
  const parts: string[] = [];
  if (house.annualTaxYear !== null) {
    parts.push(`${house.annualTaxYear} bill`);
  } else if (house.annualTaxAsOf) {
    parts.push(`as of ${formatDate(house.annualTaxAsOf)}`);
  }
  if (house.annualTaxSource) parts.push(house.annualTaxSource);
  return parts.length > 0 ? parts.join(" \u00b7 ") : "recorded";
}

/** Compact, expandable estimated-PITI line for one row. Everything shown
 * here is an estimate (never a quote or Loan Estimate) and HOA is always
 * excluded — the expanded breakdown says both explicitly. Property taxes
 * are only ever the ACTUAL recorded annual amount; without one the total is
 * labeled "PITI incomplete" (property tax unavailable), never padded with
 * an estimate. */
function PitiEstimate({ house, assumptions }: { house: HouseRecord; assumptions: PitiAssumptions }) {
  const piti = computePiti(
    { price: house.latestPrice, actualAnnualTax: house.annualTaxAmount },
    assumptions,
  );

  if (!piti) {
    return <p className="piti-unavailable">Est. PITI unavailable (no listed price)</p>;
  }

  return (
    <details className="piti-details">
      <summary
        className="piti-summary"
        aria-label={
          piti.taxIncluded
            ? `Estimated monthly PITI for ${house.address}`
            : `PITI incomplete for ${house.address} (property tax unavailable)`
        }
      >
        <span className="piti-label">{piti.taxIncluded ? "Est. PITI" : "PITI incomplete"}</span>
        <span className="piti-total">{formatCurrency(piti.monthlyTotal)}/mo</span>
        <span className="piti-hint">
          {piti.taxIncluded ? <>estimate {"\u00b7"} breakdown</> : <>no actual tax {"\u00b7"} partial</>}
        </span>
      </summary>
      <div className="piti-breakdown">
        {!piti.taxIncluded && (
          <p className="piti-incomplete-note">
            PITI incomplete {"\u2014"} no actual property-tax amount is recorded for this property, and taxes are
            never estimated from the price. The total below is principal &amp; interest + insurance
            {piti.pmiApplied ? " + PMI" : ""} only.
          </p>
        )}
        <dl className="piti-lines">
          <div>
            <dt>Principal &amp; interest</dt>
            <dd>{formatCurrency(piti.monthlyPrincipalAndInterest)}</dd>
          </div>
          <div>
            <dt>
              Property tax{" "}
              {piti.taxIncluded ? `(actual \u00b7 ${describeTaxProvenance(house)})` : "(unavailable)"}
            </dt>
            <dd>{piti.monthlyPropertyTax !== null ? formatCurrency(piti.monthlyPropertyTax) : "\u2014"}</dd>
          </div>
          <div>
            <dt>Insurance (estimated)</dt>
            <dd>{formatCurrency(piti.monthlyInsurance)}</dd>
          </div>
          {piti.pmiApplied && (
            <div>
              <dt>PMI (estimated)</dt>
              <dd>{formatCurrency(piti.monthlyPmi)}</dd>
            </div>
          )}
        </dl>
        <p className="piti-fineprint">
          {assumptions.downPaymentPct}% down ({formatCurrency(piti.downPaymentAmount)}),{" "}
          {assumptions.termYears}-yr fixed @ {assumptions.interestRatePct}% note rate (not APR).
          {piti.pmiApplied ? "" : " No PMI at 20%+ down."} Estimate only {"\u2014"} not a quote, rate lock, or
          Loan Estimate. Excludes HOA dues.
        </p>
      </div>
    </details>
  );
}

/** Assessor neighborhood plus its Zillow SFR ZHVI context (latest typical
 * value and exact-year-ago YoY percentage — the same numbers as the Market
 * tab's table). Unknown/unmatched states are said plainly, never guessed. */
function NeighborhoodLine({ house }: { house: HouseRecord }) {
  if (!house.neighborhood) {
    return <span className="funnel-row-neighborhood funnel-row-neighborhood-unknown">Neighborhood unknown</span>;
  }
  const market = house.neighborhoodMarket;
  return (
    <span className="funnel-row-neighborhood">
      <span
        className="funnel-row-neighborhood-name"
        title="County assessor neighborhood (PortlandMaps)"
      >
        {house.neighborhood}
      </span>
      {market ? (
        <span
          className="funnel-row-neighborhood-market"
          title={`Zillow Research SFR ZHVI for ${market.regionName}: typical mid-tier single-family value, as of ${market.latestMonth} — same figures as the Portland Market tab`}
        >
          {" \u00b7 "}neighborhood median {formatCurrency(market.latestValue)}
          {" \u00b7 "}
          {market.yearChangePct === null ? (
            <>1-yr change unknown</>
          ) : (
            <span className={market.yearChangePct >= 0 ? "delta-up" : "delta-down"}>
              {market.yearChangePct >= 0 ? "+" : ""}
              {market.yearChangePct.toFixed(1)}% 1-yr
            </span>
          )}
        </span>
      ) : (
        <span className="funnel-row-neighborhood-market"> {"\u00b7"} no Zillow ZHVI match</span>
      )}
    </span>
  );
}

/** Compact tri-state indicator pills for the quick preference judgments.
 * Unknown stays visually quiet; yes/no get color. These are the user’s
 * editor judgments — the measured bedroom flag renders separately and is
 * never replaced by the bedroom-size judgment. */
function JudgmentPills({ judgments }: { judgments: QuickJudgments }) {
  const glyph: Record<TriStateJudgment, string> = { yes: "\u2713", no: "\u2715", unknown: "?" };
  return (
    <span className="judgment-pills">
      {(Object.keys(JUDGMENT_SHORT_LABELS) as Array<keyof QuickJudgments>).map((field) => {
        const verdict = judgments[field];
        return (
          <span
            key={field}
            className={`judgment-pill judgment-pill-${verdict}`}
            title={`${JUDGMENT_FULL_LABELS[field]}: ${verdict}`}
            aria-label={`${JUDGMENT_FULL_LABELS[field]}: ${verdict}`}
          >
            {JUDGMENT_SHORT_LABELS[field]} {glyph[verdict]}
          </span>
        );
      })}
    </span>
  );
}

function FunnelRow({
  house,
  pitiAssumptions,
  dragging,
  grabbed,
  highlighted,
  registerHandle,
  onHandleKeyDown,
  onDragStart,
  onDragEnd,
  onReject,
  onEditNotes,
  onQuickMove,
  onBottom,
  bottomMoveBusy,
}: {
  house: HouseRecord;
  pitiAssumptions: PitiAssumptions;
  dragging: boolean;
  grabbed: boolean;
  /** Editor-close return cue: briefly glows, then fades (CSS). */
  highlighted: boolean;
  registerHandle: (el: HTMLButtonElement | null) => void;
  onHandleKeyDown: (event: React.KeyboardEvent) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragEnd: () => void;
  onReject: () => void;
  onEditNotes: () => void;
  onQuickMove?: (bucket: "to-tour" | "top-contenders") => void;
  onBottom?: () => void;
  bottomMoveBusy: boolean;
}) {
  const status = house.displayStatus;
  const track = useTrack();

  return (
    <article
      className={`funnel-row${dragging ? " funnel-row-dragging" : ""}${grabbed ? " funnel-row-grabbed" : ""}${highlighted ? " funnel-row-editor-return" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      aria-label={`${house.address}, in ${FUNNEL_BUCKET_LABELS[house.funnelBucket]}`}
    >
      <button
        ref={registerHandle}
        type="button"
        className="funnel-row-handle"
        aria-label={`Reorder ${house.address}. Press Space to grab, then arrow keys to move, Space or Enter to drop, Escape to cancel.`}
        aria-pressed={grabbed}
        onKeyDown={onHandleKeyDown}
      >
        <span aria-hidden="true">{"\u2261"}</span>
      </button>

      <div className="funnel-row-media">
        <PropertyPhoto house={house} variant="card" />
      </div>

      <div className="funnel-row-body">
        <div className="funnel-row-line funnel-row-line-primary">
          {house.zillowUrl ? (
            <a
              className="funnel-row-address"
              href={house.zillowUrl}
              target="_blank"
              rel="noreferrer noopener"
              title="Open on Zillow"
            >
              {house.address} {"\u2197"}
            </a>
          ) : (
            <span className="funnel-row-address">{house.address}</span>
          )}
          <span className="funnel-row-price">{formatCurrency(house.latestPrice)}</span>
          <span className={`status-pill status-pill-${status.toLowerCase()}`}>{status}</span>
        </div>

        <div className="funnel-row-line funnel-row-facts">
          <span>
            {formatNumber(house.bedrooms)} bd {"\u00b7"} {formatNumber(house.bathrooms)} ba {"\u00b7"}{" "}
            {formatNumber(house.finishedSqft)} sqft {"\u00b7"} built {formatYear(house.yearBuilt)}
          </span>
          <span
            className={`flag-pill flag-pill-${house.bedroomSizeFlag}`}
            title={FLAG_TITLES[house.bedroomSizeFlag]}
          >
            {FLAG_LABELS[house.bedroomSizeFlag]}
          </span>
          <span className="funnel-row-added" title="When this property entered the dashboard’s store, not the listing date">
            Added {formatDate(house.dateAdded)}
          </span>
        </div>

        <div className="funnel-row-line funnel-row-facts">
          <NeighborhoodLine house={house} />
        </div>

        <PlexUnits track={track} summary={house.plexUnits} />

        <div className="funnel-row-line funnel-row-meta">
          <PitiEstimate house={house} assumptions={pitiAssumptions} />
          <JudgmentPills judgments={house.judgments} />
        </div>
      </div>

      <div className="funnel-row-actions">
        {onQuickMove && <>
          <button type="button" className="btn-secondary funnel-row-action funnel-quick-move"
            onClick={() => onQuickMove("to-tour")} aria-label={`Move ${house.address} to To tour`}>
            <QuickMoveIcon kind="tour" /> To tour
          </button>
          <button type="button" className="btn-secondary funnel-row-action funnel-quick-move"
            onClick={() => onQuickMove("top-contenders")} aria-label={`Move ${house.address} to Top contenders`}>
            <QuickMoveIcon kind="contender" /> Top contender
          </button>
        </>}
        {onBottom && <button type="button" className="btn-secondary funnel-row-action funnel-quick-move"
          onClick={onBottom} disabled={bottomMoveBusy} aria-label={`Move ${house.address} to bottom of Watchlist`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M12 3v12m-4-4 4 4 4-4M5 21h14" />
          </svg>
          To bottom
        </button>}

        <button
          type="button"
          className={`btn-secondary funnel-row-action ${ACTION_EDIT_CLASS}`}
          onClick={onEditNotes}
          aria-label={`Edit notes and judgments for ${house.address}`}
        >
          Edit
        </button>
        <button
          type="button"
          className={`btn-secondary funnel-row-action ${ACTION_REJECT_CLASS}`}
          onClick={onReject}
          aria-label={`Reject ${house.address}`}
        >
          Reject
        </button>
      </div>
    </article>
  );
}

/** Decorative little badges; the button labels carry the accessible meaning. */
function QuickMoveIcon({ kind }: { kind: "tour" | "contender" }) {
  return (
    <svg className="quick-move-icon" width="22" height="22" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" focusable="false">
      {kind === "tour" ? <>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5.5 9v11h13V9" fill="#f7eaff" />
        <path d="M12 17.5s-4-2.3-4-4.6c0-2.2 2.6-2.8 4-.8 1.4-2 4-1.4 4 .8 0 2.3-4 4.6-4 4.6Z"
          fill="#df84b3" stroke="#a4467a" strokeWidth="1.2" />
      </> : <>
        <path d="m4 9 4 4 4-7 4 7 4-4-2 10H6Z" fill="#efd0ff" />
        <path d="M7 21h10" />
        <path d="M19 2v4m-2-2h4" stroke="#b45d94" />
        <circle cx="3" cy="5" r="1" fill="#b45d94" stroke="none" />
        <path d="m12 14 1.2 1.5L12 17l-1.2-1.5Z" fill="#a4467a" stroke="none" />
      </>}
    </svg>
  );
}
