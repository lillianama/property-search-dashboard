-- Property editor notes: the user’s own Remarks / Pros / Cons per property,
-- edited from the dashboard's property editor screen.
--
-- Design: APPEND-ONLY revisions. Every save inserts a new row per changed
-- field; the "current" value of a field is simply its latest revision
-- (saved_at DESC, id DESC). Nothing is ever UPDATEd or DELETEd, so the full
-- edit history — with provenance and timestamps — survives forever, matching
-- how the rest of the property store preserves conflicting facts.
--
-- These are EDITOR notes (the user’s judgment), deliberately separate from
-- source listing remarks/descriptions, which live in raw source payloads
-- and are never mixed into this table.
--
-- Idempotent and purely additive: safe to re-run, touches nothing else.

CREATE TABLE IF NOT EXISTS property_editor_notes (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('remarks', 'pros', 'cons')),
  value TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'dashboard-editor'
);

CREATE INDEX IF NOT EXISTS property_editor_notes_current_idx
  ON property_editor_notes (property_id, field, saved_at DESC, id DESC);
