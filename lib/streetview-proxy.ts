// Server-side Street View proxy pipeline, shared by the image route and the
// metadata route under /api/street-view/[id]. The browser only ever sees
// property IDs; this module holds the only code path that touches the
// GOOGLE_CLOUD_API_KEY, and it never places the key (or any Google URL that
// embeds it) into results, response bodies, or log lines. Image bytes are
// streamed through without being persisted or cached anywhere, per Google's
// terms.

import {
  buildImageUrl,
  buildMetadataUrl,
  chooseExteriorHeading,
  isWithinPortlandBounds,
  parseStreetViewMetadata,
} from "./streetview";

export interface PropertyLocation {
  latitude: number | null;
  longitude: number | null;
}

export interface StreetViewProxyDeps {
  /** Server-only secret; undefined/empty disables the feature cleanly. */
  apiKey: string | undefined;
  /** Read-only Postgres lookup of the property's coordinates. */
  fetchLocation(propertyId: string): Promise<PropertyLocation | null>;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export type StreetViewProxyResult =
  /** Feature disabled: no API key configured. Maps to 503. */
  | { type: "no_api_key" }
  /**
   * Expected "nothing to show" outcomes (unknown/invalid ID, no coordinates,
   * outside Portland, Street View has no imagery). Maps to 404 and the UI's
   * dashboard placeholder. `reason` is for server logs only.
   */
  | { type: "not_found"; reason: string }
  /** Upstream/database failure (denial, quota, broken response). Maps to 502. */
  | { type: "upstream_error"; reason: string }
  | { type: "metadata"; imageryDate: string | null; copyright: string | null }
  | { type: "image"; contentType: string; body: ArrayBuffer };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves one property ID to either sanitized Street View metadata or the
 * Street View image bytes:
 *
 * 1. validate the ID shape and load coordinates from Postgres (read-only);
 * 2. reject coordinate-less or non-Portland properties before spending quota;
 * 3. run the free metadata availability check;
 * 4. (image mode) aim the camera at the house from the panorama's real
 *    location and fetch the static image with return_error_code=true.
 */
export async function resolveStreetView(
  propertyId: string,
  mode: "image" | "metadata",
  deps: StreetViewProxyDeps,
): Promise<StreetViewProxyResult> {
  if (!UUID_PATTERN.test(propertyId)) {
    return { type: "not_found", reason: "invalid-property-id" };
  }

  const apiKey = deps.apiKey?.trim();
  if (!apiKey) return { type: "no_api_key" };

  let location: PropertyLocation | null;
  try {
    location = await deps.fetchLocation(propertyId);
  } catch {
    return { type: "upstream_error", reason: "location-lookup-failed" };
  }
  if (!location) return { type: "not_found", reason: "unknown-property" };
  if (location.latitude === null || location.longitude === null) {
    return { type: "not_found", reason: "no-coordinates" };
  }
  if (!isWithinPortlandBounds(location.latitude, location.longitude)) {
    return { type: "not_found", reason: "outside-portland" };
  }
  const property = { latitude: location.latitude, longitude: location.longitude };

  const fetchFn = deps.fetchFn ?? fetch;

  let metadataBody: unknown;
  try {
    const metadataResponse = await fetchFn(buildMetadataUrl(apiKey, property));
    if (!metadataResponse.ok) {
      return { type: "upstream_error", reason: `metadata-http-${metadataResponse.status}` };
    }
    metadataBody = await metadataResponse.json();
  } catch {
    return { type: "upstream_error", reason: "metadata-fetch-failed" };
  }

  const metadata = parseStreetViewMetadata(metadataBody);
  if (metadata.kind === "unavailable") return { type: "not_found", reason: "no-street-view-imagery" };
  if (metadata.kind === "error") {
    return { type: "upstream_error", reason: `metadata-${metadata.status}` };
  }

  if (mode === "metadata") {
    return { type: "metadata", imageryDate: metadata.imageryDate, copyright: metadata.copyright };
  }

  const heading = chooseExteriorHeading(property, metadata.panoramaLocation);
  try {
    const imageResponse = await fetchFn(buildImageUrl(apiKey, { panoId: metadata.panoId, heading }));
    if (imageResponse.status === 404) {
      // return_error_code=true: Google says there is no image after all.
      return { type: "not_found", reason: "image-not-found" };
    }
    if (!imageResponse.ok) {
      return { type: "upstream_error", reason: `image-http-${imageResponse.status}` };
    }
    const contentType = imageResponse.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return { type: "upstream_error", reason: "image-not-an-image" };
    }
    return { type: "image", contentType, body: await imageResponse.arrayBuffer() };
  } catch {
    return { type: "upstream_error", reason: "image-fetch-failed" };
  }
}
