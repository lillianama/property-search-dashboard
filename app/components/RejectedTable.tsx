import { formatCurrency, formatDate, formatNumber, formatYear } from "../../lib/format";
import type { RejectedHouseRecord } from "../../lib/types";
import { PropertyPhoto } from "./PropertyPhoto";

const FLAG_LABELS: Record<RejectedHouseRecord["bedroomSizeFlag"], string> = {
  critical: "Critical (<90 sqft)",
  small: "Small (90\u2013<100 sqft)",
  ok: "OK (\u2265100 sqft)",
  unknown: "Unknown",
};

export function RejectedTable({
  properties,
  onEditNotes,
}: {
  properties: RejectedHouseRecord[];
  onEditNotes: (house: RejectedHouseRecord) => void;
}) {
  if (properties.length === 0) {
    return <p className="chart-empty">No rejected properties to show.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="property-table">
        <thead>
          <tr>
            <th>Photo</th>
            <th>Address</th>
            <th>Rejected</th>
            <th>Reason</th>
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
            <tr key={p.id}>
              <td className="photo-cell">
                <PropertyPhoto house={p} variant="thumb" />
              </td>
              <td>{p.address}</td>
              <td>{formatDate(p.rejectionAt)}</td>
              <td className="cell-wrap">{p.rejectionReason?.trim() || "No reason recorded"}</td>
              <td>{formatCurrency(p.latestPrice)}</td>
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
