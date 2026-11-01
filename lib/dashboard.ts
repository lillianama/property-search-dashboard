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
import { filterByDisplayStatus } from "./status";
import { filterLifecycle, lifecycleFacts, type LifecycleView } from "./lifecycle";
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
 * from KPIs, price distribution, the map, and the table. The tracked
 * property breakdown includes them as a separate saved-decision category.
 * They still exist in the property store and remain visible
 * in the separate Rejected archive (lib/rejected.ts).
 */
export async function buildDashboardResponse(filters: HouseFilters, track: PropertyTrack = "house", lifecycleView: LifecycleView = "search"): Promise<DashboardResponse> {
  let allHouses: HouseRecord[];
  let statusDistribution: DashboardResponse["statusDistribution"];
  let events;
  let trackedTotals;
  try {
    const cohortHouses = await fetchHouses({ ...filters, dateFrom: null, dateTo: null }, track);
    allHouses = filters.dateFrom || filters.dateTo ? await fetchHouses(filters, track) : cohortHouses;

    // Canonical status resolution over the full listing-event history (see
    // lib/status.ts). Fail closed if history is unavailable: a raw latest
    // availability signal must never restore an archived property.
    const statusRows = await fetchStatusEventRows([...new Set([...allHouses, ...cohortHouses].map((h) => h.id))]);
    const byProperty = new Map<string, typeof statusRows>();
    for (const row of statusRows) {
      const rows = byProperty.get(row.propertyId) ?? [];
      rows.push(row);
      byProperty.set(row.propertyId, rows);
    }
    const resolveHouse = (house: HouseRecord) => {
      const rows = byProperty.get(house.id);
      return rows?.length ? { ...house, ...lifecycleFacts(rows) } : house;
    };
    allHouses = allHouses.map(resolveHouse);
    const cohort = filterByDisplayStatus(cohortHouses.map(resolveHouse), filters.statuses);
    const cohortIds = cohort.map(h => h.id);
    const soldCohortIds = cohort.filter(h => h.displayStatus === "Sold").map(h => h.id);

    // The status filter applies to RESOLVED statuses, so a house rescued to
    // Pending matches the Pending chip instead of a stale Inactive.
    allHouses = filterByDisplayStatus(allHouses, filters.statuses);

    const decisionRows = await fetchLatestDecisionRows(allHouses.map((h) => h.id));
    const rejections = computeRejections(decisionRows);
    const { active, rejected } = partitionByRejection(allHouses, rejections);
    // Decision precedence is chart-only: never normalize it as an MLS status
    // or count the rejected property again under its resolved listing status.
    statusDistribution = buildStatusDistribution(active.map(house => house.displayStatus));
    if (rejected.length) statusDistribution.push({ status: "Rejected", count: rejected.length });
    statusDistribution.sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
    allHouses = filterLifecycle(active, lifecycleView);
    [events, trackedTotals] = await Promise.all([
      fetchMonthlyListingEvents(filters, cohortIds, soldCohortIds),
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
      fetchNeighborhoodZhviPoints(),
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

  // KPIs retain current-panel membership. The distribution above counts
  // resolved statuses across panels before lifecycle filtering.
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
    statusDistribution,
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
