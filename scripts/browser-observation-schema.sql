-- Apply separately as a schema owner; provision browser_observation_writer as a LOGIN role.
BEGIN;
CREATE TABLE browser_observation_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property_records(id),
  zpid text NOT NULL, source_url text NOT NULL, observed_at timestamptz NOT NULL,
  content_hash text NOT NULL, capture_hash text NOT NULL, price integer, status text,
  UNIQUE(property_id, capture_hash),
  CHECK (price IS NOT NULL OR status IS NOT NULL)
);
GRANT SELECT (property_id, kind, value) ON property_identifiers TO browser_observation_writer;
GRANT SELECT (id, latest_price, latest_status, latest_status_observed_at) ON property_current TO browser_observation_writer;
GRANT SELECT (id, property_id, content_hash, capture_hash) ON browser_observation_history TO browser_observation_writer;
GRANT INSERT (property_id, zpid, source_url, observed_at, content_hash, capture_hash, price, status) ON browser_observation_history TO browser_observation_writer;
GRANT INSERT (property_id, event_type, price, status, source, source_ref, observed_at) ON property_listing_events TO browser_observation_writer;
GRANT USAGE ON SEQUENCE browser_observation_history_id_seq, property_listing_events_id_seq TO browser_observation_writer;
COMMIT;
