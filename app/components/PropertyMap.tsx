"use client";

import { useTrack } from "./TrackContext";
import { trackUrl, type PropertyTrack } from "../../lib/track";

import maplibregl, { type Map as MapLibreMap, type LngLatBoundsLike, type Marker, type Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { ACTION_EDIT_CLASS, ACTION_REJECT_CLASS } from "../../lib/action-styles";
import { formatCurrency } from "../../lib/format";
import { buildQuickViewJudgmentRows } from "../../lib/map-quickview";
import { buildStreetViewLabel, choosePhotoDisplay } from "../../lib/streetview";
import type { HouseRecord } from "../../lib/types";

const STATUS_COLORS: Record<string, string> = {
  Active: "#34d399",
  Pending: "#fbbf24",
  Inactive: "#94a3b8",
  Unverified: "#f97316",
  Sold: "#a78bfa",
  Unknown: "#4b5563",
};

const FLAG_LABELS: Record<HouseRecord["bedroomSizeFlag"], string> = {
  critical: "Bedrooms: critical (<90 sqft)",
  small: "Bedrooms: small (90\u2013<100 sqft)",
  ok: "Bedrooms: OK (\u2265100 sqft)",
  unknown: "Bedrooms: unknown",
};

/** Delay before a hover/focus quick view closes, so the pointer can travel
 * from marker to popup (and vice versa) without flicker. */
const CLOSE_GRACE_MS = 180;

type Located = HouseRecord & { latitude: number; longitude: number };

function hasCoords(p: HouseRecord): p is Located {
  return p.latitude !== null && p.longitude !== null;
}

/** Marker color and pill text come from the canonical RESOLVED status (see
 * lib/status.ts), matching the funnel cards and status chart. */
function statusOf(p: HouseRecord): string {
  return p.displayStatus in STATUS_COLORS ? p.displayStatus : "Unknown";
}

/** Placeholder shown in the quick view when no stored photo exists or the
 * stored URL fails to load. Built with textContent only — never innerHTML. */
function buildPlaceholder(address: string): HTMLElement {
  const placeholder = document.createElement("div");
  placeholder.className = "photo-placeholder photo-card";
  placeholder.setAttribute("role", "img");
  placeholder.setAttribute("aria-label", `No stored photo for ${address}`);
  placeholder.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>' +
    '<path d="M18.8 3.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="currentColor" stroke="none"/></svg>';
  const label = document.createElement("span");
  label.className = "photo-placeholder-label";
  label.textContent = "No stored photo";
  placeholder.appendChild(label);
  return placeholder;
}

/**
 * Google Street View fallback for the quick view: starts as the placeholder,
 * then swaps in the proxied Street View image once the server-side metadata
 * check confirms outdoor imagery exists. Quick views only exist while a
 * marker is hovered/pinned, so nothing is prefetched. The caption element is
 * filled with a truthful "Street View · <imagery date>" label (plus Google's
 * copyright line when published); Google's own attribution stays embedded in
 * the image bytes. Any failure leaves the dashboard placeholder.
 */
function attachStreetViewMedia(media: HTMLElement, caption: HTMLElement, house: Located, track: PropertyTrack): void {
  const placeholder = buildPlaceholder(house.address);
  media.appendChild(placeholder);

  fetch(trackUrl(`/api/street-view/${house.id}/metadata`, track), { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("unavailable"))))
    .then((meta: { imageryDate?: string | null; copyright?: string | null }) => {
      const img = document.createElement("img");
      img.className = "photo-img photo-card";
      img.src = trackUrl(`/api/street-view/${house.id}`, track);
      img.alt = `Google Street View of ${house.address} (not a listing photo)`;
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.replaceWith(buildPlaceholder(house.address));
        caption.textContent = "";
      });
      placeholder.replaceWith(img);
      const label = buildStreetViewLabel(meta.imageryDate ?? null);
      caption.textContent = meta.copyright ? `${label} \u00b7 ${meta.copyright}` : label;
    })
    .catch(() => {
      // Placeholder is already showing; nothing else to do.
    });
}

/** Builds the quick-view card DOM. All listing values are set through
 * textContent/setAttribute so nothing from the database is parsed as HTML. */
function buildQuickViewContent(
  house: Located,
  track: PropertyTrack,
  onEditNotes?: (house: Located) => void,
  onReject?: (house: Located) => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "map-quickview";

  const media = document.createElement("div");
  media.className = "map-quickview-media";
  const mediaCaption = document.createElement("p");
  mediaCaption.className = "map-quickview-media-caption";

  const displayKind = choosePhotoDisplay(house);
  if (displayKind === "listing" && house.photoUrl) {
    const img = document.createElement("img");
    img.className = "photo-img photo-card";
    img.src = house.photoUrl;
    img.alt = `Listing photo of ${house.address}`;
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      img.replaceWith(buildPlaceholder(house.address));
    });
    media.appendChild(img);
  } else if (displayKind === "street-view") {
    attachStreetViewMedia(media, mediaCaption, house, track);
  } else {
    media.appendChild(buildPlaceholder(house.address));
  }
  root.appendChild(media);
  root.appendChild(mediaCaption);

  const body = document.createElement("div");
  body.className = "map-quickview-body";

  const address = document.createElement("p");
  address.className = "map-quickview-address";
  address.textContent = house.address;
  body.appendChild(address);

  const priceRow = document.createElement("p");
  priceRow.className = "map-quickview-price";
  priceRow.textContent = formatCurrency(house.latestPrice);
  const status = statusOf(house);
  const statusPill = document.createElement("span");
  statusPill.className = `status-pill status-pill-${status.toLowerCase()}`;
  statusPill.textContent = status;
  priceRow.appendChild(document.createTextNode(" "));
  priceRow.appendChild(statusPill);
  body.appendChild(priceRow);

  const flagRow = document.createElement("p");
  flagRow.className = "map-quickview-flag";
  const flagPill = document.createElement("span");
  flagPill.className = `flag-pill flag-pill-${house.bedroomSizeFlag}`;
  flagPill.textContent = FLAG_LABELS[house.bedroomSizeFlag];
  flagRow.appendChild(flagPill);
  body.appendChild(flagRow);

  // The three persisted quick judgments, each with an explicit
  // Yes / No / Unknown state (unknown is never coerced or hidden).
  const judgmentsBox = document.createElement("div");
  judgmentsBox.className = "map-quickview-judgments";
  judgmentsBox.setAttribute("role", "list");
  judgmentsBox.setAttribute("aria-label", `Quick judgments for ${house.address}`);
  for (const row of buildQuickViewJudgmentRows(house.judgments)) {
    const item = document.createElement("div");
    item.className = "map-quickview-judgment";
    item.setAttribute("role", "listitem");
    item.setAttribute("aria-label", row.ariaLabel);
    item.title = row.ariaLabel;
    const label = document.createElement("span");
    label.className = "map-quickview-judgment-label";
    label.textContent = row.label;
    const state = document.createElement("span");
    state.className = `${row.pillClassName} map-quickview-judgment-state`;
    state.textContent = row.stateLabel;
    item.append(label, state);
    judgmentsBox.appendChild(item);
  }
  body.appendChild(judgmentsBox);

  if (house.zillowUrl) {
    const link = document.createElement("a");
    link.className = "map-quickview-link";
    link.href = house.zillowUrl;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "View listing \u2197";
    body.appendChild(link);
  } else {
    const noLink = document.createElement("p");
    noLink.className = "map-quickview-nolink";
    noLink.textContent = "No listing link stored";
    body.appendChild(noLink);
  }

  // Quick actions: Edit (subtle blue) and Reject (subtle red) share the
  // same semantic action classes as the list rows.
  const actions = document.createElement("div");
  actions.className = "map-quickview-actions";
  if (onEditNotes) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = `map-quickview-action ${ACTION_EDIT_CLASS}`;
    editButton.textContent = "Edit notes";
    editButton.setAttribute("aria-label", `Edit notes for ${house.address}`);
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onEditNotes(house);
    });
    actions.appendChild(editButton);
  }
  if (onReject) {
    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.className = `map-quickview-action ${ACTION_REJECT_CLASS}`;
    rejectButton.textContent = "Reject";
    rejectButton.setAttribute("aria-label", `Reject ${house.address}`);
    rejectButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onReject(house);
    });
    actions.appendChild(rejectButton);
  }
  if (actions.childElementCount > 0) body.appendChild(actions);

  root.appendChild(body);
  return root;
}

interface QuickViewController {
  open(house: Located, opts: { pinned: boolean }): void;
  close(): void;
  scheduleClose(): void;
  cancelClose(): void;
  isPinnedFor(id: string): boolean;
  destroy(): void;
}

function createQuickViewController(
  map: MapLibreMap,
  track: PropertyTrack,
  getOnEditNotes: () => ((house: Located) => void) | undefined,
  getOnReject: () => ((house: Located) => void) | undefined,
): QuickViewController {
  let popup: Popup | null = null;
  let currentId: string | null = null;
  let pinned = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelClose = () => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  };

  const close = () => {
    cancelClose();
    popup?.remove();
    popup = null;
    currentId = null;
    pinned = false;
  };

  const scheduleClose = () => {
    if (pinned) return;
    cancelClose();
    closeTimer = setTimeout(close, CLOSE_GRACE_MS);
  };

  const open = (house: Located, opts: { pinned: boolean }) => {
    cancelClose();
    if (currentId === house.id && popup) {
      pinned = pinned || opts.pinned;
      return;
    }
    popup?.remove();

    // Rejecting opens the confirmation dialog; the quick view closes first
    // so the dialog never stacks over (or fights focus with) the popup.
    const onReject = getOnReject();
    const content = buildQuickViewContent(
      house,
      track,
      getOnEditNotes(),
      onReject
        ? (h) => {
            close();
            onReject(h);
          }
        : undefined,
    );
    // The popup must not steal hover: moving the pointer onto it cancels the
    // pending close, leaving it schedules one. Escape anywhere in it closes.
    content.addEventListener("pointerenter", cancelClose);
    content.addEventListener("pointerleave", scheduleClose);
    content.addEventListener("focusin", cancelClose);
    content.addEventListener("focusout", scheduleClose);
    content.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });

    popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      closeOnMove: false,
      offset: 16,
      maxWidth: "280px",
      className: "map-quickview-popup",
      focusAfterOpen: false,
    })
      .setLngLat([house.longitude, house.latitude])
      .setDOMContent(content)
      .addTo(map);
    currentId = house.id;
    pinned = opts.pinned;
  };

  return {
    open,
    close,
    scheduleClose,
    cancelClose,
    isPinnedFor: (id) => pinned && currentId === id,
    destroy: close,
  };
}

function buildMarker(house: Located, quickView: QuickViewController): Marker {
  const status = statusOf(house);
  const el = document.createElement("button");
  el.type = "button";
  el.className = "map-marker";
  el.style.setProperty("--marker-color", STATUS_COLORS[status]);
  el.setAttribute(
    "aria-label",
    `${house.address}. ${formatCurrency(house.latestPrice)}, ${status}. ${FLAG_LABELS[house.bedroomSizeFlag]}. Press Enter to pin details.`,
  );

  // Hover opens the quick view for mouse/pen; touch relies on the click/tap
  // path below so a tap never has to fight a synthetic hover.
  el.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "touch") return;
    quickView.open(house, { pinned: false });
  });
  el.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "touch") return;
    quickView.scheduleClose();
  });

  // Keyboard focus mirrors hover; blur closes unless focus moved into the
  // popup (its own focusin cancels the pending close).
  el.addEventListener("focus", () => quickView.open(house, { pinned: false }));
  el.addEventListener("blur", () => quickView.scheduleClose());
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") quickView.close();
  });

  // Click (mouse or tap) pins the card so touch users can reach the listing
  // link; a second activation on the same marker dismisses it.
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    if (quickView.isPinnedFor(house.id)) {
      quickView.close();
    } else {
      quickView.open(house, { pinned: true });
    }
  });

  return new maplibregl.Marker({ element: el }).setLngLat([house.longitude, house.latitude]);
}

function fitToProperties(map: MapLibreMap, located: Located[]) {
  if (located.length === 0) return;
  const lons = located.map((p) => p.longitude);
  const lats = located.map((p) => p.latitude);
  const bounds: LngLatBoundsLike = [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
  const reduceMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  map.fitBounds(bounds, { padding: 56, maxZoom: 13, duration: reduceMotion ? 0 : 350 });
}

export function PropertyMap({
  properties,
  photoNote,
  large = false,
  onEditNotes,
  onReject,
}: {
  properties: HouseRecord[];
  photoNote?: string;
  /** Full-width, substantially taller canvas for the My Search map view. */
  large?: boolean;
  /** Opens the property editor screen from a quick view, when provided. */
  onEditNotes?: (house: HouseRecord) => void;
  /** Starts the shared rejection workflow (confirmation dialog + the
   * existing /api/funnel/move persistence) from a quick view, when
   * provided. */
  onReject?: (house: HouseRecord) => void;
}) {
  const track = useTrack();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const quickViewRef = useRef<QuickViewController | null>(null);
  const markersRef = useRef<Marker[]>([]);
  // Kept in refs so quick views built by the once-created controller
  // always call the latest handlers.
  const onEditNotesRef = useRef(onEditNotes);
  onEditNotesRef.current = onEditNotes;
  const onRejectRef = useRef(onReject);
  onRejectRef.current = onReject;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      // Free, no-key OpenStreetMap raster basemap. Deliberately no polygon
      // boundary baked in here; geographic filtering is left extensible.
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "\u00a9 OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm-base", type: "raster", source: "osm" }],
      },
      center: [-122.66, 45.53],
      zoom: 10,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    const quickView = createQuickViewController(
      map,
      track,
      () => onEditNotesRef.current,
      () => onRejectRef.current,
    );
    quickViewRef.current = quickView;

    // Clicking or tapping empty map space dismisses a pinned card; Escape
    // anywhere over the map dismisses whatever is open.
    map.on("click", () => quickView.close());
    const container = containerRef.current;
    const onContainerKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") quickView.close();
    };
    container.addEventListener("keydown", onContainerKeyDown);

    return () => {
      container.removeEventListener("keydown", onContainerKeyDown);
      quickView.destroy();
      quickViewRef.current = null;
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [track]);

  useEffect(() => {
    const map = mapRef.current;
    const quickView = quickViewRef.current;
    if (!map || !quickView) return;

    quickView.close();
    for (const marker of markersRef.current) marker.remove();

    const located = properties.filter(hasCoords);
    markersRef.current = located.map((house) => buildMarker(house, quickView).addTo(map));
    fitToProperties(map, located);
  }, [properties]);

  const withCoords = properties.filter(hasCoords).length;

  return (
    <div>
      <div ref={containerRef} className={`map-canvas${large ? " map-canvas-large" : ""}`} />
      <p className="map-caption">
        {withCoords} of {properties.length} filtered houses have known coordinates. Hover, focus, or tap a marker
        for a quick view; click or tap to pin it, Escape to dismiss. Basemap: OpenStreetMap contributors (free, no
        API key).
      </p>
      {photoNote && <p className="map-caption">{photoNote}</p>}
    </div>
  );
}
