// The property editor: pure, dependency-free logic for the user’s own
// Remarks / Pros / Cons notes on a property. Everything here is
// unit-testable without a database or browser; the SQL lives in
// lib/editor-writes.ts / lib/queries.ts and the HTTP surface in
// app/api/editor/[id].
//
// These are EDITOR notes — the user’s judgment about a house — and are
// deliberately distinct from source listing remarks/descriptions (which
// live in raw source payloads and are never mixed in here). Storage is
// append-only revisions in property_editor_notes: every save inserts a new
// row per changed field and the current value is simply the latest
// revision, so the full edit history survives with provenance.

import type { QuickJudgments, TriStateJudgment } from "./types";
import { UNKNOWN_JUDGMENTS } from "./types";

export const EDITOR_FIELDS = ["remarks", "pros", "cons"] as const;
export type EditorField = (typeof EDITOR_FIELDS)[number];

export function isEditorField(value: string): value is EditorField {
  return (EDITOR_FIELDS as readonly string[]).includes(value);
}

// ── Quick preference judgments (tri-state Yes / No / Unknown) ────────────────
//
// Editor-controlled judgments stored as append-only revisions in
// property_editor_judgments. "unknown" is the default for anything never
// evaluated; an unevaluated property is NEVER coerced to "no". The
// bedroom-size judgment is a manual UI overlay only — it never overwrites
// or falsifies published bedroom measurements or the canonical measured
// bedroomSizeFlag, which stays visible alongside it.

export const JUDGMENT_FIELDS = ["bedroomSizeOk", "rentalIncome", "drumSpace"] as const;
export type JudgmentField = (typeof JUDGMENT_FIELDS)[number];

/** camelCase API field → snake_case storage field. */
export const JUDGMENT_STORAGE_FIELDS: Record<JudgmentField, string> = {
  bedroomSizeOk: "bedroom_size_ok",
  rentalIncome: "rental_income",
  drumSpace: "drum_space",
};

export const JUDGMENT_VERDICTS: readonly TriStateJudgment[] = ["yes", "no", "unknown"];

export function isJudgmentField(value: string): value is JudgmentField {
  return (JUDGMENT_FIELDS as readonly string[]).includes(value);
}

export function isTriStateJudgment(value: unknown): value is TriStateJudgment {
  return value === "yes" || value === "no" || value === "unknown";
}

/** Generous per-field ceiling; long enough for real notes, small enough
 * that nobody can turn the notes table into blob storage. */
export const MAX_FIELD_LENGTH = 20_000;

/** The current (latest-revision) value of one editor field. */
export interface EditorFieldState {
  value: string;
  savedAt: string | null;
}

/** The non-sensitive editor payload the API returns: exactly the three
 * note fields plus the three tri-state judgments, nothing else. Fields
 * never edited are null; judgments never evaluated are "unknown". */
export interface EditorNotes {
  remarks: EditorFieldState | null;
  pros: EditorFieldState | null;
  cons: EditorFieldState | null;
  judgments: QuickJudgments;
}

export const EMPTY_EDITOR_NOTES: EditorNotes = {
  remarks: null,
  pros: null,
  cons: null,
  judgments: UNKNOWN_JUDGMENTS,
};

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalizes a field value for storage: CRLF/CR become LF, trailing
 * whitespace is stripped from each line, and leading/trailing blank lines
 * are dropped. Internal blank lines and entry order are preserved exactly —
 * pros/cons are line-separated entries and must round-trip cleanly.
 */
export function normalizeFieldValue(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Splits a pros/cons value into its non-empty entries (one per line) for
 * list-style display. Content is returned verbatim — rendering must go
 * through React text nodes so nothing is ever parsed as HTML. */
export function splitEntries(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// ── Request validation (used by the narrow mutation endpoint) ────────────────

export interface EditorSaveRequest {
  /** Only the fields present in the body; each already normalized. An
   * empty string means "clear this field" (recorded as a revision). */
  fields: Partial<Record<EditorField, string>>;
  /** Only the judgments present in the body; each an explicit tri-state
   * verdict. Omitted judgments are left untouched. */
  judgments: Partial<Record<JudgmentField, TriStateJudgment>>;
}

export type ParsedEditorSaveRequest =
  | { ok: true; request: EditorSaveRequest }
  | { ok: false; error: string };

/**
 * Strictly validates an editor-save body. Only the three known note fields
 * (strings within MAX_FIELD_LENGTH after normalization) and the three known
 * judgment fields (exactly "yes" | "no" | "unknown") are ever accepted, and
 * at least one of them must be present. There is no generic
 * column/table/SQL surface here at all.
 */
export function parseEditorSaveRequest(body: unknown): ParsedEditorSaveRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const record = body as Record<string, unknown>;

  const fields: Partial<Record<EditorField, string>> = {};
  for (const field of EDITOR_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
    const normalized = normalizeFieldValue(value);
    if (normalized.length > MAX_FIELD_LENGTH) {
      return { ok: false, error: `${field} must be at most ${MAX_FIELD_LENGTH} characters` };
    }
    fields[field] = normalized;
  }

  const judgments: Partial<Record<JudgmentField, TriStateJudgment>> = {};
  for (const field of JUDGMENT_FIELDS) {
    const value = record[field];
    if (value === undefined) continue;
    if (!isTriStateJudgment(value)) {
      return { ok: false, error: `${field} must be one of: yes, no, unknown` };
    }
    judgments[field] = value;
  }

  if (Object.keys(fields).length === 0 && Object.keys(judgments).length === 0) {
    return {
      ok: false,
      error: "at least one of remarks, pros, cons, bedroomSizeOk, rentalIncome, drumSpace must be provided",
    };
  }
  return { ok: true, request: { fields, judgments } };
}

// ── Applying a confirmed save to already-loaded house rows ───────────────────

/**
 * Returns the given house list with the server-confirmed judgments from a
 * successful editor save applied to the one saved property, so parent views
 * (funnel rows, judgment pills) update immediately without a reload.
 * Only called with a CONFIRMED response payload — never with an optimistic
 * draft — so the rows always reflect what the store actually persisted.
 * Untouched houses keep their exact object identity, and an unknown
 * property id returns the input array unchanged (identity), so memoized
 * children don't re-render needlessly.
 */
export function applyEditorSaveToHouses<T extends { id: string; judgments: QuickJudgments }>(
  houses: T[],
  propertyId: string,
  notes: EditorNotes,
): T[] {
  const index = houses.findIndex((house) => house.id === propertyId);
  if (index === -1) return houses;
  const house = houses[index];
  const j = house.judgments;
  const next = notes.judgments;
  if (
    j.bedroomSizeOk === next.bedroomSizeOk &&
    j.rentalIncome === next.rentalIncome &&
    j.drumSpace === next.drumSpace
  ) {
    return houses;
  }
  const updated = houses.slice();
  updated[index] = { ...house, judgments: { ...next } };
  return updated;
}

// ── Current-value selection (pure, mirrors the SQL ordering) ─────────────────

/** One raw property_editor_notes revision row. */
export interface EditorNoteRevisionRow {
  field: string;
  value: string;
  savedAt: string | null;
  id: number;
}

/**
 * Picks the current value of each editor field from its revision rows:
 * latest saved_at wins, row id breaks exact ties (the same ordering the
 * append-only table's index serves). Unknown field names are ignored.
 */
export function selectCurrentNotes(rows: EditorNoteRevisionRow[]): EditorNotes {
  const notes: EditorNotes = { ...EMPTY_EDITOR_NOTES, judgments: { ...UNKNOWN_JUDGMENTS } };
  const bestByField = new Map<EditorField, EditorNoteRevisionRow>();
  for (const row of rows) {
    if (!isEditorField(row.field)) continue;
    const existing = bestByField.get(row.field);
    if (!existing) {
      bestByField.set(row.field, row);
      continue;
    }
    const rowMs = row.savedAt ? new Date(row.savedAt).getTime() : Number.NEGATIVE_INFINITY;
    const existingMs = existing.savedAt ? new Date(existing.savedAt).getTime() : Number.NEGATIVE_INFINITY;
    if (rowMs > existingMs || (rowMs === existingMs && row.id > existing.id)) {
      bestByField.set(row.field, row);
    }
  }
  for (const [field, row] of bestByField) {
    notes[field] = { value: row.value, savedAt: row.savedAt };
  }
  return notes;
}

/** One raw property_editor_judgments revision row. */
export interface JudgmentRevisionRow {
  field: string;
  verdict: string;
  savedAt: string | null;
  id: number;
}

const STORAGE_FIELD_TO_JUDGMENT: Record<string, JudgmentField> = {
  bedroom_size_ok: "bedroomSizeOk",
  rental_income: "rentalIncome",
  drum_space: "drumSpace",
};

/**
 * Picks the current tri-state verdict of each judgment field from its
 * revision rows: latest saved_at wins, row id breaks exact ties. Unknown
 * field names and malformed verdicts are ignored — fields with no usable
 * revision stay "unknown" and are never coerced to "no".
 */
export function selectCurrentJudgments(rows: JudgmentRevisionRow[]): QuickJudgments {
  const judgments: QuickJudgments = { ...UNKNOWN_JUDGMENTS };
  const bestByField = new Map<JudgmentField, JudgmentRevisionRow>();
  for (const row of rows) {
    const field = STORAGE_FIELD_TO_JUDGMENT[row.field];
    if (!field || !isTriStateJudgment(row.verdict)) continue;
    const existing = bestByField.get(field);
    if (!existing) {
      bestByField.set(field, row);
      continue;
    }
    const rowMs = row.savedAt ? new Date(row.savedAt).getTime() : Number.NEGATIVE_INFINITY;
    const existingMs = existing.savedAt ? new Date(existing.savedAt).getTime() : Number.NEGATIVE_INFINITY;
    if (rowMs > existingMs || (rowMs === existingMs && row.id > existing.id)) {
      bestByField.set(field, row);
    }
  }
  for (const [field, row] of bestByField) {
    judgments[field] = row.verdict as TriStateJudgment;
  }
  return judgments;
}
