import { lifecycleDetailLines } from "../../lib/lifecycle-display";
import { formatCurrency, formatNumber, formatYear } from "../../lib/format";
import type { HouseRecord } from "../../lib/types";
import { PropertyPhoto } from "./PropertyPhoto";

const FLAG_LABELS: Record<HouseRecord["bedroomSizeFlag"], string> = {
  critical: "Critical (<90 sqft)",
  small: "Small (90\u2013<100 sqft)",
  ok: "OK (\u2265100 sqft)",
  unknown: "Unknown",
};

export function LifecycleTable({
  properties,
  onEditNotes,
  highlightId,
}: {
  properties: HouseRecord[];
  highlightId: string | null;
  onEditNotes: (house: HouseRecord) => void;
}) {
  if (properties.length === 0) {
    return <p className="chart-empty">No properties to show.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="property-table">
        <thead>
          <tr>
            <th>Photo</th>
            <th>Address</th>
            <th>Price</th>
            <th>Status</th>
            <th>Beds</th>
            <th>Year</th>
            <th>Bedroom size</th>
            <th>Zillow</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {properties.map((p) => (
            <tr key={p.id} className={highlightId === p.id ? "funnel-row-editor-return" : undefined}>
              <td className="photo-cell">
                <PropertyPhoto house={p} variant="thumb" />
              </td>
              <td className="cell-wrap">
                {p.address}
                {lifecycleDetailLines(p).map((line) => <p key={line} className="section-note">{line}</p>)}
              </td>
              <td>{formatCurrency(p.displayStatus === "Sold" ? p.saleComparison?.soldPrice : p.latestPrice)}</td>
              <td>
                <span className={`status-pill status-pill-${p.displayStatus.toLowerCase()}`}>
                  {p.displayStatus}
                </span>
              </td>
              <td>{formatNumber(p.bedrooms)}</td>
              <td>{formatYear(p.yearBuilt)}</td>
              <td>
                <span className={`flag-pill flag-pill-${p.bedroomSizeFlag}`}>{FLAG_LABELS[p.bedroomSizeFlag]}</span>
              </td>
              <td>
                {p.zillowUrl ? (
                  <a href={p.zillowUrl} target="_blank" rel="noreferrer noopener">
                    View
                  </a>
                ) : (
                  "Unknown"
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => onEditNotes(p)}
                  aria-label={`Edit notes for ${p.address}`}
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
