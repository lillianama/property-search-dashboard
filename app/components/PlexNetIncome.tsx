import { formatCurrency, formatDate } from "../../lib/format";
import type { PitiBreakdown } from "../../lib/piti";
import { plexNetIncome } from "../../lib/plex-net-income";
import type { PlexUnitSummary } from "../../lib/plex-units";

export function PlexNetIncome({ summary, piti }: { summary?: PlexUnitSummary; piti: PitiBreakdown | null }) {
  const { actualRent, estimatedRent, basis, rent, amount, reason } = plexNetIncome(summary, piti);
  const tone = amount === null || amount === 0 ? "neutral" : amount > 0 ? "positive" : "negative";
  return <details className={`plex-net-income plex-net-income-${tone}`}>
    <summary>
      <span>Est. net income</span>{" "}
      <strong>{amount === null ? "Unknown / incomplete" : `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${formatCurrency(Math.abs(amount))}/mo`}</strong>
    </summary>
    <div className="plex-net-income-explanation">
      <p>Uses the lower of complete comparable whole-property actual and estimated monthly rent, or the sole complete source, minus current monthly PITI. Actuals are listing-reported (RMLS listing), not lease-verified collection. Includes all units before owner occupancy. Estimate, not actual profit; excludes other operating expenses (including maintenance, vacancy, management and utilities) and HOA dues.</p>
      <p>Listing-reported actual rent: {actualRent === null ? "Unknown / incomplete or noncomparable scope" : `${formatCurrency(actualRent)}/mo`}. Estimated rent: {estimatedRent === null ? "Unknown / incomplete whole-property scope" : `${formatCurrency(estimatedRent)}/mo`}. Selected basis: {basis ?? "unknown"}.</p>
      {reason ? <p>{reason}.</p> : <p>{formatCurrency(rent)}/mo {basis === "actual" ? "listing-reported actual" : "estimated"} rent − {formatCurrency(piti!.monthlyTotal)}/mo PITI.</p>}
      {summary?.units.map(unit => <small key={unit.label}>{unit.label}: {unit.source}{unit.actualRentBasis ? ` · Actual basis: ${unit.actualRentBasis}` : ""}{unit.expectedRentSource ? ` · Estimate source: ${unit.expectedRentSource}` : ""}{unit.expectedRentBasis ? ` · Estimate basis: ${unit.expectedRentBasis}` : ""} · as of {unit.asOf ? formatDate(unit.asOf) : "unknown"}</small>)}
    </div>
  </details>;
}
