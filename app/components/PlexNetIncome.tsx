import { formatCurrency, formatDate } from "../../lib/format";
import type { PitiBreakdown } from "../../lib/piti";
import { plexNetIncome } from "../../lib/plex-net-income";
import type { PlexUnitSummary } from "../../lib/plex-units";

export function PlexNetIncome({ summary, piti, overrideActive = false }: { overrideActive?: boolean; summary?: PlexUnitSummary; piti: PitiBreakdown | null }) {
  const { actualRent, estimatedRent, basis, rent, amount, reason, unitSelections } = plexNetIncome(summary, piti);
  const tone = amount === null || amount === 0 ? "neutral" : amount > 0 ? "positive" : "negative";
  return <details className={`plex-net-income plex-net-income-${tone}`}>
    <summary>
      <span>Est. net income{overrideActive ? " (purchase-price override)" : ""}</span>{" "}
      <strong>{amount === null ? "Unknown / incomplete" : `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${formatCurrency(Math.abs(amount))}/mo`}</strong>
    </summary>
    <div className="plex-net-income-explanation">
      <p>For each unit, uses the lower of supported actual and projected monthly rent, or the sole supported value, then sums the selected rents and subtracts current monthly PITI. If a unit has neither supported value, the total is incomplete. Vacant units do not imply zero actual rent. Actuals are listing-reported (RMLS listing), not lease-verified collection. Includes all units before owner occupancy. Estimate, not actual profit; excludes other operating expenses (including maintenance, vacancy, management and utilities) and HOA dues.</p>
      <p>Listing-reported actual rent: {actualRent === null ? "Unknown / incomplete or noncomparable scope" : `${formatCurrency(actualRent)}/mo`}. Estimated rent: {estimatedRent === null ? "Unknown / incomplete whole-property scope" : `${formatCurrency(estimatedRent)}/mo`}. Selected basis: {basis === "mixed" ? "mixed (actual and estimated per unit)" : basis ?? "unknown"}.</p>
      {reason ? <p>{reason}.</p> : <p>{formatCurrency(rent)}/mo {basis === "actual" ? "listing-reported actual" : basis === "mixed" ? "mixed per-unit selected" : "estimated"} rent − {formatCurrency(piti!.monthlyTotal)}/mo PITI.</p>}
      {summary?.units.map((unit, index) => <small key={unit.label}>{unit.label}: Selected rent: {unitSelections[index].rent === null ? "Unknown / incomplete" : `${formatCurrency(unitSelections[index].rent)}/mo (${unitSelections[index].basis})`} · {unit.source}{unit.actualRentBasis ? ` · Actual basis: ${unit.actualRentBasis}` : ""}{unit.expectedRentSource ? ` · Estimate source: ${unit.expectedRentSource}` : ""}{unit.expectedRentBasis ? ` · Estimate basis: ${unit.expectedRentBasis}` : ""} · as of {unit.asOf ? formatDate(unit.asOf) : "unknown"}</small>)}
    </div>
  </details>;
}
