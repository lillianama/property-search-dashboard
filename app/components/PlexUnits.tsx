import { formatCurrency, formatDate } from "../../lib/format";
import { rentalSubtotal, type PlexUnitSummary } from "../../lib/plex-units";
import type { PropertyTrack } from "../../lib/track";

export function PlexUnits({ track, summary }: { track: PropertyTrack; summary?: PlexUnitSummary }) {
  if (track !== "plex") return null;
  const units = summary?.units ?? [];
  const count = summary?.recordedUnitCount;
  const actual = rentalSubtotal(units, "actualMonthlyRent");
  const expected = rentalSubtotal(units, "expectedMonthlyRent");
  const rent = (amount: number | null) => amount === null ? "Unknown" : `${formatCurrency(amount)}/mo`;
  return <section className="plex-units" aria-label="Units and rental income">
    <strong>Units &amp; rental income</strong>
    {count && <p>{count.count} units recorded · {count.source} · as of {count.asOf ? formatDate(count.asOf) : "unknown"}</p>}
    {units.length === 0 ? <p>Unit details unknown.</p> : <ul>
      {units.map(unit => <li key={unit.label}>
        <strong>{unit.label}</strong>
        {unit.beds !== null && <> · {unit.beds} bd</>}
        {unit.baths !== null && <> · {unit.baths} ba</>}
        {unit.sqft !== null && <> · {unit.sqft} sqft</>}
        <span> · Occupancy: {unit.occupancy}</span>
        <div>Actual rent: {rent(unit.actualMonthlyRent)} · Expected/pro-forma rent: {rent(unit.expectedMonthlyRent)}</div>
        <small>{unit.source} · as of {unit.asOf ? formatDate(unit.asOf) : "unknown"}</small>
      </li>)}
    </ul>}
    {count && units.length > 0 && count.count !== units.length && <p>Recorded unit count and available unit details differ; breakdown may be incomplete.</p>}
    <p>Actual monthly rent subtotal: {rent(actual.amount)} ({actual.count} units with recorded rent)</p>
    <p>Expected/pro-forma monthly rent subtotal: {rent(expected.amount)} ({expected.count} units with recorded rent)</p>
    <small>Subtotals cover recorded unit rents only; missing rents remain unknown.</small>
  </section>;
}
