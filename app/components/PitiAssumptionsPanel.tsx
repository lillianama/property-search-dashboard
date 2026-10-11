"use client";

import { useEffect, useState } from "react";
import {
  clampAssumptionValue,
  DEFAULT_PITI_ASSUMPTIONS,
  PITI_FIELD_BOUNDS,
  type InsuranceMode,
  type PitiAssumptions,
} from "../../lib/piti";

type NumericField = keyof typeof PITI_FIELD_BOUNDS;

/**
 * One numeric assumption input. Keeps its own string draft so typing (and
 * temporarily-empty fields) works naturally; every parseable value is
 * clamped to the field's sane bounds and propagated immediately, and blur
 * snaps the draft back to the committed value.
 */
function AssumptionField({
  field,
  label,
  hint,
  step,
  value,
  onCommit,
}: {
  field: NumericField;
  label: string;
  hint?: string;
  step: number;
  value: number;
  onCommit: (field: NumericField, value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // Resync the draft when the committed value changes from outside this
  // input (reset button, clamping, another tab's storage write).
  useEffect(() => {
    setDraft((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  const bounds = PITI_FIELD_BOUNDS[field];

  return (
    <label className="piti-panel-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={bounds.min}
        max={bounds.max}
        step={step}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(parsed)) {
            onCommit(field, clampAssumptionValue(field, parsed));
          }
        }}
        onBlur={() => setDraft(String(value))}
        aria-describedby={hint ? `piti-hint-${field}` : undefined}
      />
      {hint && (
        <span className="piti-panel-hint" id={`piti-hint-${field}`}>
          {hint}
        </span>
      )}
    </label>
  );
}

/**
 * Editable global assumptions behind every card's estimated PITI. Values
 * are validated/clamped in lib/piti.ts, persisted to localStorage by the
 * parent, and recalculate every card immediately — nothing here writes to
 * the server or the property store.
 */
export function PitiAssumptionsPanel({
  value,
  onChange,
}: {
  value: PitiAssumptions;
  onChange: (next: PitiAssumptions) => void;
}) {
  const commit = (field: NumericField, fieldValue: number) => {
    if (value[field] !== fieldValue) onChange({ ...value, [field]: fieldValue });
  };

  return (
    <details className="piti-panel">
      <summary className="piti-panel-summary">
        PITI assumptions: {value.downPaymentPct}% down {"\u00b7"} {value.termYears}-yr fixed {"\u00b7"}{" "}
        {value.interestRatePct}% note rate {"\u00b7"} edit
      </summary>

      <div className="piti-panel-body">
        <p className="section-note">
          Default comparison assumptions: 5% down (95% LTV), 30-year fixed, 6.5% mortgage
          note rate (the rate in the payment formula {"\u2014"} not APR, which is a separate disclosure figure and
          never used here), $1,200/yr homeowners insurance, and PMI at 0.36% of the base loan per year {"\u00f7"}{" "}
          12. Everything is editable and saved in this browser only (localStorage) {"\u2014"} nothing is written
          to the property store. Estimates are for comparing houses, never a quote, rate lock, or Loan Estimate,
          and always exclude HOA dues. Property taxes are never an assumption: each row uses the actual recorded
          annual tax from the property store, and houses without one show an explicitly incomplete PITI instead
          of an estimate.
        </p>

        <div className="piti-panel-grid">
          <AssumptionField
            field="downPaymentPct"
            label="Down payment (% of price)"
            step={1}
            value={value.downPaymentPct}
            onCommit={commit}
            hint={value.downPaymentPct < 20 ? "Below 20%: an estimated PMI line is added to every row." : "20%+: no PMI."}
          />
          <AssumptionField
            field="interestRatePct"
              label={"Mortgage note rate (% / yr, fixed \u2014 not APR)"}
            step={0.125}
            value={value.interestRatePct}
            onCommit={commit}
          />
          <AssumptionField
            field="termYears"
            label="Loan term (years)"
            step={1}
            value={value.termYears}
            onCommit={commit}
          />
          <div className="piti-panel-field">
            <span id="piti-insurance-mode-label">Homeowners insurance (estimated)</span>
            <select
              className="piti-panel-select"
              aria-labelledby="piti-insurance-mode-label"
              value={value.insuranceMode}
              onChange={(e) => onChange({ ...value, insuranceMode: e.target.value as InsuranceMode })}
            >
              <option value="annualAmount">Flat annual $ (comparison default)</option>
              <option value="annualRatePct">Annual % of price</option>
              <option value="monthlyAmount">Flat monthly $</option>
            </select>
          </div>
          {value.insuranceMode === "annualAmount" && (
            <AssumptionField
              field="insuranceAnnualAmount"
              label="Insurance ($ / year)"
              step={50}
              value={value.insuranceAnnualAmount}
              onCommit={commit}
            />
          )}
          {value.insuranceMode === "annualRatePct" && (
            <AssumptionField
              field="insuranceAnnualRatePct"
              label="Insurance rate (% of price / yr)"
              step={0.05}
              value={value.insuranceAnnualRatePct}
              onCommit={commit}
            />
          )}
          {value.insuranceMode === "monthlyAmount" && (
            <AssumptionField
              field="insuranceMonthlyAmount"
              label="Insurance ($ / month)"
              step={5}
              value={value.insuranceMonthlyAmount}
              onCommit={commit}
            />
          )}

          {value.downPaymentPct < 20 && (
            <AssumptionField
              field="pmiAnnualRatePct"
              label="PMI (% of base loan / yr, estimated)"
              step={0.01}
              value={value.pmiAnnualRatePct}
              onCommit={commit}
              hint={"Monthly PMI = base loan \u00d7 this rate \u00f7 12. Default: 0.36%."}
            />
          )}
        </div>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => onChange({ ...DEFAULT_PITI_ASSUMPTIONS })}
        >
          Reset to comparison defaults (5% down, 30-yr, 6.5% note rate)
        </button>
      </div>
    </details>
  );
}
