import { classifyListingEvent, isGenericAvailabilitySource, resolveDisplayStatus, type StatusEventRow } from "./status";
import type { HouseRecord } from "./types";

export type LifecycleView = "search" | "pending" | "sold";
export function parseLifecycleView(value: string | null): LifecycleView {
  return value === "pending" || value === "sold" ? value : "search";
}

export interface SaleComparison {
  soldPrice: number | null;
  soldDate: string | null;
  saleSource: string | null;
  listPrice: number | null;
  listDate: string | null;
  listSource: string | null;
  listEventId: number | null;
  dollarDelta: number | null;
  percentDelta: number | null;
}

const day = (e: StatusEventRow) => (e.eventDate ?? e.observedAt)?.slice(0, 10) ?? "";
const order = (a: StatusEventRow, b: StatusEventRow) => day(a).localeCompare(day(b))
  || (Date.parse(a.observedAt ?? "") || 0) - (Date.parse(b.observedAt ?? "") || 0) || a.id - b.id;
const status = classifyListingEvent;
const price = (value: number | null | undefined) => value != null && Number.isFinite(value) && value > 0 ? value : null;

/** No price from property_current is used: a comparison requires a recorded
 * sale and a preceding priced listing event with the same source and MLS id.
 * A previous sale closes that cycle, even if an identifier was reused. */
export function saleComparison(rows: StatusEventRow[]): SaleComparison {
  const events = rows.filter(e => day(e)).sort(order);
  const saleIndex = events.findLastIndex(e => e.eventType === "sold");
  // A later authoritative listing/pending cycle means that historical sale
  // cannot supply the current sale's missing facts.
  const laterCycle = events.slice(saleIndex + 1).some(e =>
    !isGenericAvailabilitySource(e.source) && (status(e) === "active" || status(e) === "pending"));
  const sale = laterCycle ? undefined : events[saleIndex];
  const result: SaleComparison = {
    soldPrice: price(sale?.price), soldDate: sale?.eventDate ?? null,
    saleSource: sale?.source ?? null, listPrice: null, listDate: null,
    listSource: null, listEventId: null, dollarDelta: null, percentDelta: null,
  };
  if (!sale?.mlsNumber?.trim() || !sale.source || !sale.eventDate) return result;
  let listing: StatusEventRow | undefined;
  for (let i = saleIndex - 1; i >= 0; i--) {
    const event = events[i];
    if (status(event) === "sold") break;
    if (event.mlsNumber && event.mlsNumber !== sale.mlsNumber) break;
    if (event.mlsNumber === sale.mlsNumber && event.source === sale.source
      && event.eventDate && event.eventDate <= sale.eventDate
      && status(event) === "active" && price(event.price) !== null) {
      listing = event;
      break;
    }
  }
  if (!listing) return result;
  result.listPrice = price(listing.price);
  result.listDate = listing.eventDate;
  result.listSource = listing.source;
  result.listEventId = listing.id;
  if (result.soldPrice !== null && result.listPrice !== null) {
    result.dollarDelta = result.soldPrice - result.listPrice;
    result.percentDelta = result.dollarDelta / result.listPrice * 100;
  }
  return result;
}

export function lifecycleFacts(rows: StatusEventRow[]) {
  const events = rows.filter(e => day(e)).sort(order);
  const displayStatus = resolveDisplayStatus(events);
  let priorLifecycle = false;
  let backOnMarket: { date: string; source: string } | null = null;
  for (const event of events) {
    const cls = status(event);
    if (cls === "pending" || cls === "sold") {
      priorLifecycle = true;
      backOnMarket = null;
    } else if (cls === "active" && priorLifecycle && !isGenericAvailabilitySource(event.source)) {
      backOnMarket ??= { date: day(event), source: event.source! };
    } else if (cls === "inactive" && !isGenericAvailabilitySource(event.source)) {
      backOnMarket = null;
    }
  }
  return { displayStatus, backOnMarket: displayStatus === "Active" ? backOnMarket : null,
    saleComparison: saleComparison(events) };
}

export function filterLifecycle<T extends Pick<HouseRecord, "displayStatus">>(houses: T[], view: LifecycleView): T[] {
  return houses.filter(h => view === "sold" ? h.displayStatus === "Sold"
    : view === "pending" ? h.displayStatus === "Pending"
    : h.displayStatus !== "Sold" && h.displayStatus !== "Pending");
}
