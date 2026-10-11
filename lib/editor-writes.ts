import type { PropertyTrack } from "./track";
// The property editor's write path: persists the user’s Remarks / Pros /
// Cons as APPEND-ONLY revisions in property_editor_notes, inside one atomic
// transaction. Statements here are a fixed allowlist — a SELECT ... FOR
// UPDATE lock on the property, a read of each field's current revision,
// and INSERTs of new revisions — all parameterized. Nothing is ever
// UPDATEd or DELETEd, so the complete edit history (with timestamps and
// source provenance) survives forever. What counts as a valid request is
// decided by the pure parser in lib/editor.ts (unit-tested); this module
// only translates it into SQL. Together with lib/funnel-writes.ts these
// are the only two writers in the app.

import type { PoolClient } from "pg";
import { withWriteTransaction } from "./db";
import {
  EDITOR_FIELDS,
  JUDGMENT_FIELDS,
  JUDGMENT_STORAGE_FIELDS,
  isTriStateJudgment,
  type EditorField,
  type EditorNotes,
  type EditorSaveRequest,
  type JudgmentField,
} from "./editor";
import type { QuickJudgments, TriStateJudgment } from "./types";
import { UNKNOWN_JUDGMENTS } from "./types";

export const EDITOR_WRITE_SOURCE = "dashboard-editor";

export type EditorSaveOutcome =
  | { ok: true; changedFields: Array<EditorField | JudgmentField>; notes: EditorNotes }
  | { ok: false; error: "not-found" };

interface CurrentRow {
  field: string;
  value: string;
  saved_at: string | null;
}

async function fetchCurrentNotesForUpdate(
  client: PoolClient,
  propertyId: string,
): Promise<Map<EditorField, CurrentRow>> {
  // DISTINCT ON picks each field's latest revision; the surrounding
  // transaction already holds the property lock, serializing writers.
  const result = await client.query<CurrentRow>(
    `SELECT DISTINCT ON (field) field, value, saved_at::text AS saved_at
     FROM property_editor_notes
     WHERE property_id = $1::uuid
     ORDER BY field, saved_at DESC, id DESC`,
    [propertyId],
  );
  const map = new Map<EditorField, CurrentRow>();
  for (const row of result.rows) {
    if ((EDITOR_FIELDS as readonly string[]).includes(row.field)) {
      map.set(row.field as EditorField, row);
    }
  }
  return map;
}

const STORAGE_TO_JUDGMENT = Object.fromEntries(
  (Object.entries(JUDGMENT_STORAGE_FIELDS) as Array<[JudgmentField, string]>).map(([k, v]) => [v, k]),
) as Record<string, JudgmentField>;

async function fetchCurrentJudgmentsForUpdate(
  client: PoolClient,
  propertyId: string,
): Promise<QuickJudgments> {
  const result = await client.query<{ field: string; verdict: string }>(
    `SELECT DISTINCT ON (field) field, verdict
     FROM property_editor_judgments
     WHERE property_id = $1::uuid
     ORDER BY field, saved_at DESC, id DESC`,
    [propertyId],
  );
  const judgments: QuickJudgments = { ...UNKNOWN_JUDGMENTS };
  for (const row of result.rows) {
    const field = STORAGE_TO_JUDGMENT[row.field];
    if (field && isTriStateJudgment(row.verdict)) judgments[field] = row.verdict;
  }
  return judgments;
}

/**
 * Applies one editor save atomically:
 *
 * - Locks the property row (and refuses anything that is not a tracked
 *   house) so concurrent saves for the same house serialize.
 * - For each submitted field whose normalized value differs from the
 *   current revision, INSERTs a new revision row. Unchanged fields write
 *   nothing, so re-saving an untouched form is a clean no-op.
 * - Returns the resulting current notes so the client can render exactly
 *   what was persisted.
 *
 * Everything commits or rolls back together via withWriteTransaction.
 */
export async function executeEditorSave(
  propertyId: string,
  request: EditorSaveRequest,
  track: PropertyTrack = "house",
): Promise<EditorSaveOutcome> {
  return withWriteTransaction(async (client) => {
    const houseResult = await client.query(
      `SELECT id FROM property_records WHERE id = $1::uuid AND track = $2 FOR UPDATE`,
      [propertyId, track],
    );
    if (houseResult.rowCount === 0) {
      return { ok: false as const, error: "not-found" as const };
    }

    const current = await fetchCurrentNotesForUpdate(client, propertyId);
    const changedNoteFields: EditorField[] = [];

    for (const field of EDITOR_FIELDS) {
      const submitted = request.fields[field];
      if (submitted === undefined) continue;
      const existing = current.get(field);
      // A field never edited before counts as changed even when cleared to
      // "" would be pointless — only skip when the value is truly identical.
      if (existing !== undefined ? existing.value === submitted : submitted === "") continue;
      changedNoteFields.push(field);
    }

    const currentJudgments = await fetchCurrentJudgmentsForUpdate(client, propertyId);
    const changedJudgmentFields: JudgmentField[] = [];
    for (const field of JUDGMENT_FIELDS) {
      const submitted = request.judgments[field];
      if (submitted === undefined) continue;
      // "unknown" for a never-judged field is the implicit state already;
      // only a genuinely different verdict inserts a revision.
      if (submitted === currentJudgments[field]) continue;
      changedJudgmentFields.push(field);
    }

    const notes: EditorNotes = {
      remarks: null,
      pros: null,
      cons: null,
      judgments: { ...currentJudgments },
    };
    for (const field of EDITOR_FIELDS) {
      const existing = current.get(field);
      if (existing) notes[field] = { value: existing.value, savedAt: existing.saved_at };
    }

    for (const field of changedNoteFields) {
      const value = request.fields[field] as string;
      const inserted = await client.query<{ saved_at: string }>(
        `INSERT INTO property_editor_notes (property_id, field, value, source)
         VALUES ($1::uuid, $2, $3, $4)
         RETURNING saved_at::text AS saved_at`,
        [propertyId, field, value, EDITOR_WRITE_SOURCE],
      );
      notes[field] = { value, savedAt: inserted.rows[0]?.saved_at ?? null };
    }

    for (const field of changedJudgmentFields) {
      const verdict = request.judgments[field] as TriStateJudgment;
      await client.query(
        `INSERT INTO property_editor_judgments (property_id, field, verdict, source)
         VALUES ($1::uuid, $2, $3, $4)`,
        [propertyId, JUDGMENT_STORAGE_FIELDS[field], verdict, EDITOR_WRITE_SOURCE],
      );
      notes.judgments[field] = verdict;
    }

    return {
      ok: true as const,
      changedFields: [...changedNoteFields, ...changedJudgmentFields],
      notes,
    };
  });
}
