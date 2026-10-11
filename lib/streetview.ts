// Google Street View exterior fallback for houses that have no persisted
// listing photo. Everything in this module is pure logic shared by the
// server-side proxy (lib/streetview-proxy.ts) and the UI's display selection.
// The GOOGLE_CLOUD_API_KEY only ever appears inside URLs built here, which are
// fetched server-side and never returned to, logged for, or rendered by the
// browser. Street View imagery is always labeled as Street View in the UI and
// is never presented as a listing photo.

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * Generous bounding box around Portland, OR (city plus close-in metro). The
 * proxy refuses to spend Street View quota on anything outside it, and the UI
 * uses the same check so it never requests imagery the server would reject.
 */
export const PORTLAND_BOUNDS = {
  minLatitude: 45.35,
  maxLatitude: 45.72,
  minLongitude: -122.95,
  maxLongitude: -122.35,
} as const;

export function isWithinPortlandBounds(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= PORTLAND_BOUNDS.minLatitude &&
    latitude <= PORTLAND_BOUNDS.maxLatitude &&
    longitude >= PORTLAND_BOUNDS.minLongitude &&
    longitude <= PORTLAND_BOUNDS.maxLongitude
  );
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Initial great-circle bearing from `from` to `to`, in degrees [0, 360).
 * Used as the Street View camera heading so the panorama faces the house
 * instead of pointing down the street.
 */
export function computeHeading(from: LatLng, to: LatLng): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLng = toRadians(to.longitude - from.longitude);
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

/** Coordinates closer than roughly a meter give a meaningless bearing. */
const SAME_POINT_EPSILON_DEGREES = 1e-5;

/**
 * Picks the camera heading for an exterior-facing view: the bearing from the
 * panorama's actual location toward the property. Returns null (let Google
 * pick its default) when the panorama location is unknown or effectively the
 * same point as the property.
 */
export function chooseExteriorHeading(property: LatLng, panoramaLocation: LatLng | null): number | null {
  if (!panoramaLocation) return null;
  if (
    Math.abs(panoramaLocation.latitude - property.latitude) < SAME_POINT_EPSILON_DEGREES &&
    Math.abs(panoramaLocation.longitude - property.longitude) < SAME_POINT_EPSILON_DEGREES
  ) {
    return null;
  }
  return Math.round(computeHeading(panoramaLocation, property) * 100) / 100;
}

// Single image size shared by the table thumb and the map quick view; well
// under the Static Street View 640x640 cap and cheap enough not to need
// per-variant fetches.
export const STREET_VIEW_IMAGE_WIDTH = 640;
export const STREET_VIEW_IMAGE_HEIGHT = 400;
/** Slightly tighter than the API's 90-degree default so the house fills more of the frame. */
export const STREET_VIEW_FOV = 80;

const METADATA_ENDPOINT = "https://maps.googleapis.com/maps/api/streetview/metadata";
const IMAGE_ENDPOINT = "https://maps.googleapis.com/maps/api/streetview";

/**
 * Metadata lookup URL. The metadata endpoint is free, so the proxy always
 * checks availability here before spending an image request. `source=outdoor`
 * keeps indoor/business panoramas out of the results.
 */
export function buildMetadataUrl(apiKey: string, location: LatLng): string {
  const url = new URL(METADATA_ENDPOINT);
  url.searchParams.set("location", `${location.latitude},${location.longitude}`);
  url.searchParams.set("source", "outdoor");
  url.searchParams.set("key", apiKey);
  return url.toString();
}

export interface ImageUrlOptions {
  panoId: string;
  heading: number | null;
}

/**
 * Static Street View image URL for a known panorama. `return_error_code=true`
 * makes Google answer broken lookups with an HTTP error instead of a gray
 * placeholder image, so failures fall through to the dashboard placeholder.
 */
export function buildImageUrl(apiKey: string, options: ImageUrlOptions): string {
  const url = new URL(IMAGE_ENDPOINT);
  url.searchParams.set("size", `${STREET_VIEW_IMAGE_WIDTH}x${STREET_VIEW_IMAGE_HEIGHT}`);
  url.searchParams.set("pano", options.panoId);
  if (options.heading !== null) url.searchParams.set("heading", String(options.heading));
  url.searchParams.set("fov", String(STREET_VIEW_FOV));
  url.searchParams.set("return_error_code", "true");
  url.searchParams.set("key", apiKey);
  return url.toString();
}

export type StreetViewMetadata =
  | {
      kind: "available";
      panoId: string;
      panoramaLocation: LatLng | null;
      /** Imagery capture date as published by Google, usually "YYYY-MM". */
      imageryDate: string | null;
      copyright: string | null;
    }
  | { kind: "unavailable" }
  | { kind: "error"; status: string };

/**
 * Interprets a Street View metadata response body. ZERO_RESULTS/NOT_FOUND mean
 * "no imagery here" (an expected outcome, not an error); everything else that
 * is not a well-formed OK is treated as an upstream error.
 */
export function parseStreetViewMetadata(body: unknown): StreetViewMetadata {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "error", status: "malformed-response" };
  }
  const record = body as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "missing-status";

  if (status === "ZERO_RESULTS" || status === "NOT_FOUND") return { kind: "unavailable" };
  if (status !== "OK") return { kind: "error", status };

  const panoId = record.pano_id;
  if (typeof panoId !== "string" || panoId.length === 0) {
    return { kind: "error", status: "ok-without-pano" };
  }

  let panoramaLocation: LatLng | null = null;
  const location = record.location;
  if (location !== null && typeof location === "object" && !Array.isArray(location)) {
    const { lat, lng } = location as Record<string, unknown>;
    if (typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)) {
      panoramaLocation = { latitude: lat, longitude: lng };
    }
  }

  return {
    kind: "available",
    panoId,
    panoramaLocation,
    imageryDate: typeof record.date === "string" && record.date.length > 0 ? record.date : null,
    copyright: typeof record.copyright === "string" && record.copyright.length > 0 ? record.copyright : null,
  };
}

// ── UI display selection ─────────────────────────────────────────────────────

export type PhotoDisplayKind = "listing" | "street-view" | "placeholder";

export interface PhotoDisplayInput {
  photoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Which media a property card should show: a persisted listing photo always
 * wins; otherwise a Street View exterior fallback when the property has
 * coordinates inside Portland (the same rule the proxy enforces); otherwise
 * the dashboard placeholder.
 */
export function choosePhotoDisplay(input: PhotoDisplayInput): PhotoDisplayKind {
  if (input.photoUrl) return "listing";
  if (
    input.latitude !== null &&
    input.longitude !== null &&
    isWithinPortlandBounds(input.latitude, input.longitude)
  ) {
    return "street-view";
  }
  return "placeholder";
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-06" → "Jun 2024"; anything unparseable → null. */
export function formatImageryDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return `${MONTH_NAMES[monthIndex]} ${match[1]}`;
}

/** Truthful caption for Street View media, e.g. "Street View · Jun 2024". */
export function buildStreetViewLabel(imageryDate: string | null): string {
  const formatted = formatImageryDate(imageryDate);
  return formatted ? `Street View \u00b7 ${formatted}` : "Street View";
}

/**
 * Honest note about the Street View fallback, kept separate from the stored
 * listing-photo coverage note so real photo coverage is never conflated with
 * fallback imagery.
 */
export function buildStreetViewFallbackNote(eligible: number, withoutStoredPhoto: number): string {
  if (withoutStoredPhoto === 0) {
    return "Every filtered property has a stored listing photo, so no Street View fallback is shown.";
  }
  return (
    `${eligible} of the ${withoutStoredPhoto} filtered properties without a stored listing photo have coordinates ` +
    "inside Portland and may show a Google Street View exterior image instead, fetched on demand through a " +
    "server-side proxy and always labeled as Street View \u2014 never presented as a listing photo. Houses " +
    "where Street View has no imagery keep the dashboard placeholder."
  );
}
