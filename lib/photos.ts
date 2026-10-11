// Photo URLs come only from raw source payloads already persisted in the
// property store (property_observations.raw, property_listing_events.raw,
// property_source_snapshots.payload). Nothing here fetches, scrapes, or
// fabricates anything: this module validates stored candidates and picks one
// deterministically. Extraction reads a fixed allowlist of top-level payload
// keys, so private fields (owner, legal_description, agent contact info) can
// never leak into the API by accident.

import type { HouseRecord } from "./types";

/** One raw payload row that may carry photo URLs, with its provenance. */
export interface PhotoSourceRow {
  propertyId: string;
  payload: unknown;
  source: string;
  observedAt: string | null;
  confidence: number | null;
}

export interface PhotoCandidate {
  url: string;
  source: string;
  observedAt: string | null;
  confidence: number | null;
  /** Position within the payload's candidate list; earlier wins ties. */
  sequence: number;
}

export interface PhotoSelection {
  url: string;
  source: string;
}

/**
 * Top-level payload keys that are allowed to supply photo URLs. Listing
 * sources (RentCast, rmls, Zillow-shaped payloads) use these names for
 * photo media. Keys like `description`, `owner`, or agent URLs are never
 * consulted, even if they happen to contain an image link.
 */
export const PHOTO_PAYLOAD_KEYS = [
  "photos",
  "photoUrls",
  "photo_urls",
  "images",
  "imageUrls",
  "image_urls",
  "photoUrl",
  "photo_url",
  "primaryPhoto",
  "primary_photo",
  "primaryImageUrl",
  "imageUrl",
  "image_url",
  "imgSrc",
  "thumbnailUrl",
  "thumbnail_url",
] as const;

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|gif|avif)$/i;

/**
 * Hosts (and their subdomains) known to serve listing photos. URLs on these
 * hosts are accepted even without a file extension in the path; every other
 * host must end in an image extension so agent websites, listing pages, and
 * arbitrary links are never treated as photos.
 */
const TRUSTED_PHOTO_HOSTS = ["zillowstatic.com", "rdcpix.com", "cdn-redfin.com", "rentcast.io"];

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\d+\.\d+\.\d+\.\d+$|\[)/i;

/** True only for https URLs that plausibly point at a listing image. */
export function isSafePhotoUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;

  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || PRIVATE_HOST.test(host)) return false;

  const trusted = TRUSTED_PHOTO_HOSTS.some((t) => host === t || host.endsWith(`.${t}`));
  return trusted || IMAGE_EXTENSION.test(url.pathname);
}

function candidateUrlsFromValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const urls: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        urls.push(entry);
      } else if (entry !== null && typeof entry === "object") {
        // Common media-object shapes: { url }, { href }, { src }.
        const obj = entry as Record<string, unknown>;
        const nested = obj.url ?? obj.href ?? obj.src;
        if (typeof nested === "string") urls.push(nested);
      }
    }
    return urls;
  }
  return [];
}

/**
 * Extracts every safe photo URL from one persisted payload row, in a stable
 * order (allowlist key order, then array order). Unsafe or non-URL values are
 * dropped silently.
 */
export function extractPhotoCandidates(row: PhotoSourceRow): PhotoCandidate[] {
  const payload = row.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];

  const record = payload as Record<string, unknown>;
  const candidates: PhotoCandidate[] = [];
  let sequence = 0;
  for (const key of PHOTO_PAYLOAD_KEYS) {
    if (!(key in record)) continue;
    for (const url of candidateUrlsFromValue(record[key])) {
      if (!isSafePhotoUrl(url)) continue;
      candidates.push({
        url: url.trim(),
        source: row.source,
        observedAt: row.observedAt,
        confidence: row.confidence,
        sequence: sequence++,
      });
    }
  }
  return candidates;
}

function observedAtMillis(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Deterministic selection among candidates: highest source confidence first,
 * then most recently observed, then earliest position within its payload,
 * then lexicographic URL as a final total-order tiebreak.
 */
export function selectBestPhoto(candidates: PhotoCandidate[]): PhotoSelection | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const confA = a.confidence ?? Number.NEGATIVE_INFINITY;
    const confB = b.confidence ?? Number.NEGATIVE_INFINITY;
    if (confA !== confB) return confB - confA;
    const timeA = observedAtMillis(a.observedAt);
    const timeB = observedAtMillis(b.observedAt);
    if (timeA !== timeB) return timeB - timeA;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
  return { url: sorted[0].url, source: sorted[0].source };
}

/** Groups raw rows by property and picks one photo per property. */
export function selectPhotosByProperty(rows: PhotoSourceRow[]): Map<string, PhotoSelection> {
  const byProperty = new Map<string, PhotoCandidate[]>();
  for (const row of rows) {
    const candidates = extractPhotoCandidates(row);
    if (candidates.length === 0) continue;
    const existing = byProperty.get(row.propertyId);
    if (existing) {
      existing.push(...candidates);
    } else {
      byProperty.set(row.propertyId, candidates);
    }
  }

  const selections = new Map<string, PhotoSelection>();
  for (const [propertyId, candidates] of byProperty) {
    const best = selectBestPhoto(candidates);
    if (best) selections.set(propertyId, best);
  }
  return selections;
}

export interface PhotoAttachmentResult {
  houses: HouseRecord[];
  withPhoto: number;
}

/**
 * Returns new house records with `photoUrl`/`photoSource` filled in from the
 * selections (null when no stored photo exists — the UI shows a placeholder,
 * never a fabricated image), plus the count of houses that got a real photo.
 */
export function attachPhotoSelections(
  houses: HouseRecord[],
  selections: Map<string, PhotoSelection>,
): PhotoAttachmentResult {
  let withPhoto = 0;
  const attached = houses.map((house) => {
    const selection = selections.get(house.id) ?? null;
    if (selection) withPhoto += 1;
    return {
      ...house,
      photoUrl: selection?.url ?? null,
      photoSource: selection?.source ?? null,
    };
  });
  return { houses: attached, withPhoto };
}

/**
 * Honest coverage copy shown verbatim in the UI next to photo features. This
 * note is strictly about real persisted listing photos; the Street View
 * fallback has its own separate note (lib/streetview.ts) so fallback imagery
 * never inflates listing-photo coverage.
 */
export function buildPhotoCoverageNote(withPhoto: number, total: number): string {
  if (total === 0) {
    return "No properties match the current filters, so photo coverage is not applicable.";
  }
  const base =
    `${withPhoto} of ${total} filtered properties have a listing photo stored in the property store. ` +
    "Listing photos are only ever read from persisted source data — never fetched live, scraped, or fabricated.";
  if (withPhoto === 0) {
    return (
      base +
      " None of the current sources (RentCast, rmls, PortlandMaps) has persisted photo URLs yet."
    );
  }
  return base;
}
