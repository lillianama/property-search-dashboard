import { formatCurrency, formatDate } from "../../lib/format";
import type { PitiBreakdown } from "../../lib/piti";
import { plexNetIncome } from "../../lib/plex-net-income";
import type { PlexUnitSummary } from "../../lib/plex-units";

export function PlexNetIncome({ summary, piti }: { summary?: PlexUnitSummary; piti: PitiBreakdown | null }) {
  const { rent, amount, reason } = plexNetIncome(summary, piti);
  const tone = amount === null || amount === 0 ? "neutral" : amount > 0 ? "positive" : "negative";
  return <details className={`plex-net-income plex-net-income-${tone}`}>
    <summary>
      <span>Est. net income</span>{" "}
      <strong>{amount === null ? "Unknown / incomplete" : `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${formatCurrency(Math.abs(amount))}/mo`}</strong>
    </summary>
    <div className="plex-net-income-explanation">
      <p>Total estimated monthly rental income for all units minus current monthly PITI. Includes all units before owner occupancy. Estimate, not actual profit; excludes other operating expenses (including maintenance, vacancy, management and utilities) and HOA dues.</p>
      {reason ? <p>{reason}.</p> : <p>{formatCurrency(rent)}/mo estimated rent − {formatCurrency(piti!.monthlyTotal)}/mo PITI.</p>}
      {summary?.units.map(unit => <small key={unit.label}>{unit.label}: {unit.source} · as of {unit.asOf ? formatDate(unit.asOf) : "unknown"}</small>)}
    </div>
  </details>;
}
