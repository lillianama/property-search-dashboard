import { fetchPlexUnitSummaries } from "./plex-unit-queries";
import type { PropertyTrack } from "./track";
import {
  buildMonthlyHistory,
  buildPriceDistribution,
  buildStatusDistribution,
  latestFreshness,
  median,
  summarizeStatusCounts,
} from "./aggregate";
import { DatabaseUnavailableError } from "./db";
import type { HouseFilters } from "./filters";
import { deriveFunnelBuckets } from "./funnel";
import { buildNeighborhoodRows } from "./market";
import { fetchNeighborhoodZhviPoints } from "./market-queries";
import { joinNeighborhoodMarket, selectAssessorNeighborhoods } from "./neighborhood";
import { attachPhotoSelections, buildPhotoCoverageNote, selectPhotosByProperty } from "./photos";
import { buildStreetViewFallbackNote, choosePhotoDisplay } from "./streetview";
import { selectActualAnnualTaxes } from "./tax";
import {
  fetchActiveFunnelCollections,
  fetchActualTaxRows,
  fetchCurrentJudgments,
  fetchCurrentRankKeys,
  fetchHouses,
  fetchLatestDecisionRows,
  fetchMonthlyListingEvents,
  fetchNeighborhoodObservationRows,
  fetchPhotoSourceRows,
  fetchStatusEventRows,
  fetchTrackedPropertyTotals,
} from "./queries";
import { computeRejections, partitionByRejection } from "./rejection";
import { filterByDisplayStatus, resolveDisplayStatuses } from "./status";
import type { DashboardResponse, HouseRecord } from "./types";

export function buildCoverageNote(total: number, _storeTotal: number, track: PropertyTrack = "house"): string {
  return `This dashboard reflects only the ${total} ${track === "plex" ? "plexes" : "houses"} you have actively researched and logged in the property store, not the full Portland MLS/market inventory. Treat every chart and KPI as a research log, not a market census.`;
}

function emptyDashboardResponse(dbAvailable: boolean, track: PropertyTrack): DashboardResponse {
  return {
    summary: {
      knownHouses: 0,
      active: 0,
      pending: 0,
      inactive: 0,
      unverified: 0,
      sold: 0,
      unknownStatus: 0,
      medianLatestPrice: null,
      medianSalePrice: null,
      dataFreshness: null,
    },
    history: [],
    priceDistribution: [],
    statusDistribution: [],
    properties: [],
    meta: {
      generatedAt: new Date().toISOString(),
      trackedPropertyTotal: 0,
      coverageNote: buildCoverageNote(0, 0, track),
      photoCoverageNote: buildPhotoCoverageNote(0, 0),
      streetViewNote: buildStreetViewFallbackNote(0, 0),
      dbAvailable,
    },
  };
}

/**
 * Builds the full dashboard payload for the given filters. Never throws for
 * database-unavailability: callers get a well-formed, empty response with
 * `meta.dbAvailable = false` instead of a leaked connection error.
 *
 * Rejected houses (an explicit human rejection decision was the latest
 * decision recorded for that property — see lib/rejection.ts) are excluded
 * from every part of this response: KPIs, history, distributions, the map,
 * and the table. They still exist in the property store and remain visible
 * in the separate Rejected archive (lib/rejected.ts).
 */
export async function buildDashboardResponse(filters: HouseFilters, track: PropertyTrack = "house"): Promise<DashboardResponse> {
  let allHouses: HouseRecord[];
  let events;
  let trackedTotals;
  try {
    allHouses = await fetchHouses(filters, track);

    // Canonical status resolution over the full listing-event history (see
    // lib/status.ts). Best-effort: a failure leaves the fallback
    // displayStatus derived directly from latest_status in place.
    try {
      const statusRows = await fetchStatusEventRows(allHouses.map((h) => h.id));
      const resolved = resolveDisplayStatuses(statusRows);
      allHouses = allHouses.map((house) => {
        const displayStatus = resolved.get(house.id);
        return displayStatus && displayStatus !== house.displayStatus ? { ...house, displayStatus } : house;
      });
    } catch (err) {
      console.error("[dashboard] status resolution failure:", err instanceof Error ? err.message : err);
    }

    // The status filter applies to RESOLVED statuses, so a house rescued to
    // Pending matches the Pending chip instead of a stale Inactive.
    allHouses = filterByDisplayStatus(allHouses, filters.statuses);

    const decisionRows = await fetchLatestDecisionRows(allHouses.map((h) => h.id));
    const rejections = computeRejections(decisionRows);
    const { active } = partitionByRejection(allHouses, rejections);
    allHouses = active;
    [events, trackedTotals] = await Promise.all([
      fetchMonthlyListingEvents(filters, allHouses.map((h) => h.id)),
      fetchTrackedPropertyTotals(track),
    ]);
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return emptyDashboardResponse(false, track);
    }
    console.error("[dashboard] query failure:", err instanceof Error ? err.message : err);
    return emptyDashboardResponse(false, track);
  }
  let houses = allHouses;
  if (track === "plex") {
    let summaries: Awaited<ReturnType<typeof fetchPlexUnitSummaries>> = new Map();
    try {
      summaries = await fetchPlexUnitSummaries(houses.map(house => house.id));
    } catch {
      console.error("[dashboard] plex unit lookup unavailable");
    }
    houses = houses.map(house => ({
      ...house,
      plexUnits: summaries.get(house.id) ?? { units: [], recordedUnitCount: null },
    }));
  }

  // Actual recorded annual property-tax amounts, used by the client-side
  // PITI estimates. Best-effort: a failure means every card honestly shows
  // "property tax unavailable" (an incomplete PITI) rather than losing the
  // dashboard — taxes are never estimated from the price.
  try {
    const taxRows = await fetchActualTaxRows(houses.map((h) => h.id));
    const actualTaxes = selectActualAnnualTaxes(taxRows);
    houses = houses.map((house) => {
      const tax = actualTaxes.get(house.id);
      return tax
        ? {
            ...house,
            annualTaxAmount: tax.amount,
            annualTaxYear: tax.taxYear,
            annualTaxAsOf: tax.asOf,
            annualTaxSource: tax.source,
          }
        : house;
    });
  } catch (err) {
    console.error("[dashboard] actual tax lookup failure:", err instanceof Error ? err.message : err);
  }

  // Funnel bucket lookup is best-effort: a failure degrades every house to
  // the watchlist catch-all instead of taking down the payload. Houses with
  // no funnel membership stay in watchlist by default — nothing is written
  // just because they render there.
  try {
    const collectionRows = await fetchActiveFunnelCollections(houses.map((h) => h.id), track);
    const buckets = deriveFunnelBuckets(collectionRows);
    houses = houses.map((house) => {
      const bucket = buckets.get(house.id);
      return bucket && bucket !== house.funnelBucket ? { ...house, funnelBucket: bucket } : house;
    });
  } catch (err) {
    console.error("[dashboard] funnel lookup failure:", err instanceof Error ? err.message : err);
  }

  // Global rank keys are best-effort: a failure (including the rank table
  // not existing yet) leaves rankKey null everywhere and the list falls
  // back to the deterministic pre-rank ordering.
  try {
    const rankKeys = await fetchCurrentRankKeys(houses.map((h) => h.id));
    houses = houses.map((house) => {
      const rankKey = rankKeys.get(house.id);
      return rankKey !== undefined ? { ...house, rankKey } : house;
    });
  } catch (err) {
    console.error("[dashboard] rank lookup failure:", err instanceof Error ? err.message : err);
  }

  // Quick preference judgments are best-effort: a failure leaves every
  // house at the all-unknown default — never coerced to "no".
  try {
    const judgments = await fetchCurrentJudgments(houses.map((h) => h.id));
    houses = houses.map((house) => {
      const judged = judgments.get(house.id);
      return judged ? { ...house, judgments: judged } : house;
    });
  } catch (err) {
    console.error("[dashboard] judgments lookup failure:", err instanceof Error ? err.message : err);
  }

  // Assessor neighborhood + Zillow ZHVI market context. Best-effort: any
  // failure leaves neighborhood/neighborhoodMarket null (rendered as
  // "unknown") instead of taking down the payload. The ZHVI join reuses the
  // exact buildNeighborhoodRows series the Market view renders, so the
  // typical value and exact-year-ago YoY percentage always match that tab.
  try {
    const [neighborhoodRows, zhviPoints] = await Promise.all([
      fetchNeighborhoodObservationRows(houses.map((h) => h.id)),
      track === "house" ? fetchNeighborhoodZhviPoints() : Promise.resolve([]),
    ]);
    const assessorByProperty = selectAssessorNeighborhoods(neighborhoodRows);
    const marketByProperty = joinNeighborhoodMarket(assessorByProperty, buildNeighborhoodRows(zhviPoints));
    houses = houses.map((house) => {
      const neighborhood = assessorByProperty.get(house.id) ?? null;
      const neighborhoodMarket = marketByProperty.get(house.id) ?? null;
      return neighborhood !== house.neighborhood || neighborhoodMarket !== house.neighborhoodMarket
        ? { ...house, neighborhood, neighborhoodMarket }
        : house;
    });
  } catch (err) {
    console.error("[dashboard] neighborhood lookup failure:", err instanceof Error ? err.message : err);
  }

  // Photo lookup is best-effort: a failure here degrades to placeholders
  // rather than taking down the whole dashboard payload.
  let photoSelections = new Map<string, { url: string; source: string }>();
  try {
    const photoRows = await fetchPhotoSourceRows(houses.map((h) => h.id));
    photoSelections = selectPhotosByProperty(photoRows);
  } catch (err) {
    console.error("[dashboard] photo lookup failure:", err instanceof Error ? err.message : err);
  }
  const { houses: housesWithPhotos, withPhoto } = attachPhotoSelections(houses, photoSelections);

  // Street View fallback coverage is reported separately from real
  // listing-photo coverage and never counted as a photo.
  const withoutStoredPhoto = housesWithPhotos.filter((h) => h.photoUrl === null);
  const streetViewEligible = withoutStoredPhoto.filter((h) => choosePhotoDisplay(h) === "street-view").length;

  // KPIs and the status chart count RESOLVED display statuses so they agree
  // with the pills on the map and cards.
  const statuses = houses.map((h) => h.displayStatus);
  const statusCounts = summarizeStatusCounts(statuses);

  return {
    summary: {
      knownHouses: houses.length,
      active: statusCounts.active,
      pending: statusCounts.pending,
      inactive: statusCounts.inactive,
      unverified: statusCounts.unverified,
      sold: statusCounts.sold,
      unknownStatus: statusCounts.unknown,
      medianLatestPrice: median(houses.map((h) => h.latestPrice)),
      medianSalePrice: median(houses.map((h) => h.latestSalePrice)),
      dataFreshness: latestFreshness(houses.map((h) => ({ lastSeenAt: h.lastSeenAt }))),
    },
    history: buildMonthlyHistory(events),
    priceDistribution: buildPriceDistribution(houses.map((h) => h.latestPrice)),
    statusDistribution: buildStatusDistribution(statuses),
    properties: housesWithPhotos,
    meta: {
      generatedAt: new Date().toISOString(),
      trackedPropertyTotal: trackedTotals.houseTotal,
      coverageNote: buildCoverageNote(trackedTotals.houseTotal, trackedTotals.storeTotal, track),
      photoCoverageNote: buildPhotoCoverageNote(withPhoto, housesWithPhotos.length),
      streetViewNote: buildStreetViewFallbackNote(streetViewEligible, withoutStoredPhoto.length),
      dbAvailable: true,
    },
  };
}
