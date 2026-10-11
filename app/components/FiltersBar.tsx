"use client";

import { ALL_KNOWN_STATUSES } from "../../lib/filters";
import type { FilterFormValue } from "../../lib/url-state";

// The canonical form shape now lives in lib/url-state.ts (it round-trips
// through the URL); re-exported here so existing imports keep working.
export { EMPTY_FILTER_FORM, type FilterFormValue } from "../../lib/url-state";

interface FiltersBarProps {
  value: FilterFormValue;
  onChange: (next: FilterFormValue) => void;
  onApply: () => void;
  onReset: () => void;
  isDirty: boolean;
}

export function FiltersBar({ value, onChange, onApply, onReset, isDirty }: FiltersBarProps) {
  function toggleStatus(status: string) {
    const has = value.statuses.includes(status);
    onChange({
      ...value,
      statuses: has ? value.statuses.filter((s) => s !== status) : [...value.statuses, status],
    });
  }

  return (
    <form
      className="filters-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
    >
      <div className="filters-group">
        <span className="filters-group-label">Status</span>
        <div className="status-chip-row">
          {ALL_KNOWN_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`status-chip${value.statuses.includes(status) ? " status-chip-active" : ""}`}
              onClick={() => toggleStatus(status)}
              aria-pressed={value.statuses.includes(status)}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      <label className="filters-field">
        <span>Max price</span>
        <input
          type="number"
          min={0}
          step={1000}
          placeholder="Any"
          value={value.maxPrice}
          onChange={(e) => onChange({ ...value, maxPrice: e.target.value })}
        />
      </label>

      <label className="filters-field">
        <span>Min bedrooms</span>
        <input
          type="number"
          min={0}
          step={1}
          placeholder="Any"
          value={value.minBedrooms}
          onChange={(e) => onChange({ ...value, minBedrooms: e.target.value })}
        />
      </label>

      <label className="filters-field">
        <span>Max year built</span>
        <input
          type="number"
          min={1800}
          max={2100}
          step={1}
          placeholder="Any"
          value={value.maxYearBuilt}
          onChange={(e) => onChange({ ...value, maxYearBuilt: e.target.value })}
        />
      </label>

      <label className="filters-field">
        <span>Date range from</span>
        <input type="date" value={value.dateFrom} onChange={(e) => onChange({ ...value, dateFrom: e.target.value })} />
      </label>

      <label className="filters-field">
        <span>Date range to</span>
        <input type="date" value={value.dateTo} onChange={(e) => onChange({ ...value, dateTo: e.target.value })} />
      </label>

      <div className="filters-actions">
        <button type="submit" className="btn-primary">
          Apply filters
        </button>
        <button type="button" className="btn-secondary" onClick={onReset} disabled={!isDirty}>
          Reset
        </button>
      </div>

      <p className="filters-hint">
        Date range filters research freshness for the KPIs/table/map and listing-event dates for the history chart.
      </p>
    </form>
  );
}
