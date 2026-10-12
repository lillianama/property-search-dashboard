import { formatCurrency } from "./format";
import type { HouseRecord } from "./types";

/** Shared list/map copy: missing sale facts are explicitly unknown. */
export function lifecycleDetailLines(house: HouseRecord): string[] {
  const lines: string[] = [];
  if (house.backOnMarket) lines.push(`Back on market · ${house.backOnMarket.date} · ${house.backOnMarket.source}`);
  if (house.displayStatus !== "Sold") return lines;
  const sale = house.saleComparison;
  lines.push(`Recorded sold price: ${formatCurrency(sale?.soldPrice)} · Sold date: ${sale?.soldDate ?? "Unknown"}${sale?.saleSource ? ` · ${sale.saleSource}` : ""}`);
  lines.push(`Compared list price: ${formatCurrency(sale?.listPrice)}${sale?.listEventId != null ? ` · ${sale.listDate} · ${sale.listSource} · listing event #${sale.listEventId}` : ""}`);
  const delta = sale?.dollarDelta;
  const percent = sale?.percentDelta;
  lines.push(`Sale − list: ${delta != null && percent != null
    ? `${delta > 0 ? "+" : ""}${formatCurrency(delta)} (${percent > 0 ? "+" : ""}${percent.toFixed(1)}%)`
    : "Unknown — no verified sale/listing comparison"}`);
  return lines;
}
