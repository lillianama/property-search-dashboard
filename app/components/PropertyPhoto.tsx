"use client";

import { useTrack } from "./TrackContext";
import { trackUrl } from "../../lib/track";

import { useEffect, useRef, useState } from "react";
import { buildStreetViewLabel, choosePhotoDisplay } from "../../lib/streetview";

/** Inline dashboard-styled house glyph used by every photo placeholder. */
export function PlaceholderGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
      <path d="M10 20v-5h4v5" />
      <path d="M18.8 3.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

type Variant = "thumb" | "card";

function Placeholder({ address, variant }: { address: string; variant: Variant }) {
  return (
    <div
      className={`photo-placeholder photo-${variant}`}
      role="img"
      aria-label={`No stored photo for ${address}`}
    >
      <PlaceholderGlyph size={variant === "thumb" ? 18 : 26} />
      {variant === "card" && <span className="photo-placeholder-label">No stored photo</span>}
    </div>
  );
}

/**
 * Google Street View exterior fallback for a house without a stored listing
 * photo. Availability is only checked (via the server-side proxy's free
 * metadata route) once the element is near the viewport, so a long table
 * never fires a burst of requests for offscreen rows and images are never
 * prefetched. Any failure — no imagery, API denial, broken response — falls
 * back to the dashboard placeholder. The image is always visibly labeled as
 * Street View with its imagery date, never as a listing photo.
 */
function StreetViewPhoto({ id, address, variant }: { id: string; address: string; variant: Variant }) {
  const track = useTrack();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<"waiting" | "available" | "failed">("waiting");
  const [label, setLabel] = useState("Street View");

  useEffect(() => {
    setPhase("waiting");
    setLabel("Street View");
    const node = containerRef.current;
    if (!node) return;

    const controller = new AbortController();
    let cancelled = false;

    const checkAvailability = async () => {
      try {
        const res = await fetch(trackUrl(`/api/street-view/${id}/metadata`, track), {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setPhase("failed");
          return;
        }
        const meta = (await res.json()) as { imageryDate?: string | null };
        if (cancelled) return;
        setLabel(buildStreetViewLabel(meta.imageryDate ?? null));
        setPhase("available");
      } catch {
        if (!cancelled) setPhase("failed");
      }
    };

    if (typeof IntersectionObserver === "undefined") {
      checkAvailability();
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          checkAvailability();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);

    return () => {
      cancelled = true;
      controller.abort();
      observer.disconnect();
    };
  }, [id, track]);

  if (phase === "failed") {
    return <Placeholder address={address} variant={variant} />;
  }

  return (
    <div ref={containerRef} className={`streetview-wrap streetview-${variant}`}>
      {phase === "available" ? (
        <>
          <img
            className={`photo-img photo-${variant}`}
            src={trackUrl(`/api/street-view/${id}`, track)}
            alt={`Google Street View of ${address} (not a listing photo)`}
            title={label}
            loading="lazy"
            decoding="async"
            onError={() => setPhase("failed")}
          />
          <span className="streetview-label">{label}</span>
        </>
      ) : (
        <Placeholder address={address} variant={variant} />
      )}
    </div>
  );
}

export interface PhotoHouse {
  id: string;
  address: string;
  photoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Renders a stored listing photo when one is persisted (always highest
 * priority), otherwise a clearly-labeled Google Street View exterior fallback
 * when the house has Portland coordinates, otherwise the dashboard placeholder.
 * Never invents imagery and never mislabels Street View as a listing photo.
 */
export function PropertyPhoto({ house, variant }: { house: PhotoHouse; variant: Variant }) {
  const [listingFailed, setListingFailed] = useState(false);

  useEffect(() => {
    setListingFailed(false);
  }, [house.photoUrl]);

  const kind = choosePhotoDisplay(house);

  if (kind === "listing" && !listingFailed) {
    return (
      <img
        className={`photo-img photo-${variant}`}
        src={house.photoUrl as string}
        alt={`Listing photo of ${house.address}`}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setListingFailed(true)}
      />
    );
  }

  if (kind === "street-view") {
    return <StreetViewPhoto id={house.id} address={house.address} variant={variant} />;
  }

  return <Placeholder address={house.address} variant={variant} />;
}
