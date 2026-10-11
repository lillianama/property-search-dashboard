import type { PropertyTrack } from "./track";
import { EMPTY_HOUSE_FILTERS } from "./filters";
import { DatabaseUnavailableError } from "./db";
import { attachPhotoSelections, buildPhotoCoverageNote, selectPhotosByProperty } from "./photos";
import { fetchHouses, fetchLatestDecisionRows, fetchPhotoSourceRows, fetchStatusEventRows } from "./queries";
import { computeRejections, partitionByRejection, sortByRejectionRecency } from "./rejection";
import { resolveDisplayStatuses } from "./status";
import type { RejectedHouseRecord, RejectedHousesResponse } from "./types";
import { buildStreetViewFallbackNote, choosePhotoDisplay } from "./streetview";

function emptyRejectedHousesResponse(dbAvailable: boolean): RejectedHousesResponse {
  return {
    properties: [],
    meta: {
      generatedAt: new Date().toISOString(),
      photoCoverageNote: buildPhotoCoverageNote(0, 0),
      streetViewNote: buildStreetViewFallbackNote(0, 0),
      dbAvailable,
    },
  };
}

/**
 * Builds the Rejected archive payload: every tracked house whose latest
 * explicit decision in property_interactions is a human rejection (see
 * lib/rejection.ts for the exact rule). Intentionally ignores the My Search
 * filter set — this is a fixed, separately-selected archive, not another
 * filtered view. Mirrors buildDashboardResponse's failure contract.
 */
export async function buildRejectedHousesResponse(track: PropertyTrack = "house"): Promise<RejectedHousesResponse> {
  let rejected: RejectedHouseRecord[];
  try {
    const allHouses = await fetchHouses(EMPTY_HOUSE_FILTERS, track);
    const decisionRows = await fetchLatestDecisionRows(allHouses.map((h) => h.id));
    const rejections = computeRejections(decisionRows);
    // Most recently rejected first (deterministic tie-breakers; undated
    // rejections last) — see lib/rejection.ts compareByRejectionRecency.
    rejected = sortByRejectionRecency(partitionByRejection(allHouses, rejections).rejected);
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return emptyRejectedHousesResponse(false);
    }
    console.error("[rejected] query failure:", err instanceof Error ? err.message : err);
    return emptyRejectedHousesResponse(false);
  }

  // The archive shows the same canonical resolved status as My Search.
  // Best-effort: a failure keeps the fallback derived from latest_status.
  try {
    const statusRows = await fetchStatusEventRows(rejected.map((h) => h.id));
    const resolved = resolveDisplayStatuses(statusRows);
    rejected = rejected.map((house) => {
      const displayStatus = resolved.get(house.id);
      return displayStatus && displayStatus !== house.displayStatus ? { ...house, displayStatus } : house;
    });
  } catch (err) {
    console.error("[rejected] status resolution failure:", err instanceof Error ? err.message : err);
  }

  // Photo lookup is best-effort, same as the main dashboard: a failure here
  // degrades to placeholders rather than hiding the archive.
  let photoSelections = new Map<string, { url: string; source: string }>();
  try {
    const photoRows = await fetchPhotoSourceRows(rejected.map((h) => h.id));
    photoSelections = selectPhotosByProperty(photoRows);
  } catch (err) {
    console.error("[rejected] photo lookup failure:", err instanceof Error ? err.message : err);
  }
  const { houses: rejectedWithPhotos, withPhoto } = attachPhotoSelections(rejected, photoSelections);
  const rejectedRecords = rejectedWithPhotos as RejectedHouseRecord[];

  const withoutStoredPhoto = rejectedRecords.filter((h) => h.photoUrl === null);
  const streetViewEligible = withoutStoredPhoto.filter((h) => choosePhotoDisplay(h) === "street-view").length;

  return {
    properties: rejectedRecords,
    meta: {
      generatedAt: new Date().toISOString(),
      photoCoverageNote: buildPhotoCoverageNote(withPhoto, rejectedRecords.length),
      streetViewNote: buildStreetViewFallbackNote(streetViewEligible, withoutStoredPhoto.length),
      dbAvailable: true,
    },
  };
}
