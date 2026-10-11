-- Global manual ranking + quick preference judgments for the dashboard.
--
-- Both tables follow the property_editor_notes pattern: APPEND-ONLY
-- revisions with provenance. Nothing is ever UPDATEd or DELETEd; the
-- "current" value is simply the latest row (created_at/saved_at DESC,
-- id DESC), so the full history survives forever.
--
-- Idempotent and purely additive: safe to re-run, touches nothing else.

-- ── Global manual rank ───────────────────────────────────────────────────────
--
-- One durable manual order across every tracked house, independent of the
-- funnel category. rank_key is a base-36 fractional-index key (see
-- lib/rank.ts) compared lexicographically; the rank NUMBER is never shown
-- anywhere — order is communicated purely by row position. Moving one house
-- inserts ONE new revision (no renumbering of other rows); a rare
-- deterministic compaction inserts a fresh revision per house. Rejected
-- houses keep their latest rank row untouched, so restoring one recovers
-- its old position.

CREATE TABLE IF NOT EXISTS property_funnel_ranks (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  -- Lowercase base-36, no trailing '0' (matches lib/rank.ts isValidRankKey).
  rank_key TEXT NOT NULL CHECK (rank_key ~ '^[0-9a-z]*[1-9a-z]$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'dashboard-funnel',
  note TEXT
);

CREATE INDEX IF NOT EXISTS property_funnel_ranks_current_idx
  ON property_funnel_ranks (property_id, created_at DESC, id DESC);

-- ── Quick preference judgments ───────────────────────────────────────────────
--
-- the user’s tri-state Yes / No / Unknown calls from the property editor:
--   bedroom_size_ok  — "bedroom size acceptable" (a UI judgment overlay;
--                      it NEVER overwrites the measured bedroom flag in
--                      property_bedroom_flags, which stays canonical)
--   rental_income    — can support rental income (separate studio,
--                      basement unit, ADU-like space, ...)
--   drum_space       — has a place to play drums
-- 'unknown' is the default for anything never judged; writing 'unknown'
-- explicitly is allowed (it records "evaluated, still undecided").

CREATE TABLE IF NOT EXISTS property_editor_judgments (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('bedroom_size_ok', 'rental_income', 'drum_space')),
  verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'no', 'unknown')),
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'dashboard-editor'
);

CREATE INDEX IF NOT EXISTS property_editor_judgments_current_idx
  ON property_editor_judgments (property_id, field, saved_at DESC, id DESC);
