// Pure helpers for the map quick-view card: the three persisted quick
// preference judgments rendered as explicit Yes / No / Unknown rows.
// Dependency-free (mirrors lib/rejection.ts) so the DOM-building map code
// and the unit tests share exactly one definition of labels, classes, and
// accessible names. The verdicts themselves come straight from the same
// persisted judgment data the list rows and the editor use — nothing here
// evaluates or coerces a judgment ("unknown" stays "Unknown", never "No").

import { JUDGMENT_FIELDS, type JudgmentField } from "./editor";
import type { QuickJudgments, TriStateJudgment } from "./types";

/** Short row labels for the quick view card. Deliberately aligned with the
 * editor's judgment vocabulary (see PropertyEditorScreen). */
export const QUICK_JUDGMENT_LABELS: Record<JudgmentField, string> = {
  bedroomSizeOk: "Bedroom size acceptable",
  rentalIncome: "Rental income support",
  drumSpace: "Drum space",
};

/** Explicit tri-state display text. "Unknown" means "not evaluated yet". */
export const JUDGMENT_STATE_LABELS: Record<TriStateJudgment, string> = {
  yes: "Yes",
  no: "No",
  unknown: "Unknown",
};

export interface QuickViewJudgmentRow {
  field: JudgmentField;
  label: string;
  verdict: TriStateJudgment;
  /** "Yes" | "No" | "Unknown" — never blank, never coerced. */
  stateLabel: string;
  /** Reuses the shared judgment-pill palette so map and list agree. */
  pillClassName: string;
  ariaLabel: string;
}

/**
 * Builds the three quick-judgment display rows for one house, in the same
 * fixed field order as the editor. Every row always renders — an
 * unevaluated judgment shows an explicit "Unknown" rather than being
 * omitted or assumed "No".
 */
export function buildQuickViewJudgmentRows(judgments: QuickJudgments): QuickViewJudgmentRow[] {
  return JUDGMENT_FIELDS.map((field) => {
    const verdict = judgments[field];
    const label = QUICK_JUDGMENT_LABELS[field];
    const stateLabel = JUDGMENT_STATE_LABELS[verdict];
    return {
      field,
      label,
      verdict,
      stateLabel,
      pillClassName: `judgment-pill judgment-pill-${verdict}`,
      ariaLabel: `${label}: ${stateLabel}`,
    };
  });
}
