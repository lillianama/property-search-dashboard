BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS property_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_address text NOT NULL,
  normalized_address text NOT NULL UNIQUE,
  city text DEFAULT 'Portland',
  state text DEFAULT 'OR',
  zip_code text,
  parcel_id text UNIQUE,
  latitude double precision,
  longitude double precision,
  property_type text,
  track text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS property_identifiers (
  property_id uuid NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  kind text NOT NULL,
  value text NOT NULL,
  source text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);

CREATE TABLE IF NOT EXISTS property_observations (
  id bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  field text NOT NULL,
  value jsonb NOT NULL,
  source text NOT NULL,
  source_ref text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  confidence numeric(4,3) NOT NULL DEFAULT 0.700,
  raw jsonb,
  UNIQUE (property_id, field, source, source_ref, observed_at)
);

CREATE INDEX IF NOT EXISTS property_observations_lookup_idx
  ON property_observations(property_id, field, observed_at DESC);

CREATE TABLE IF NOT EXISTS property_listing_events (
  id bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_date date,
  price integer,
  status text,
  mls_number text,
  source text NOT NULL,
  source_ref text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb,
  UNIQUE (property_id, event_type, event_date, price, status, source)
);

CREATE INDEX IF NOT EXISTS property_listing_events_lookup_idx
  ON property_listing_events(property_id, event_date DESC, observed_at DESC);

CREATE TABLE IF NOT EXISTS property_rooms (
  id bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  room_type text NOT NULL,
  room_label text,
  level text,
  width_ft numeric(7,2),
  length_ft numeric(7,2),
  area_sqft numeric(9,2),
  is_primary boolean,
  source text NOT NULL,
  source_ref text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  confidence numeric(4,3) NOT NULL DEFAULT 0.700,
  raw jsonb,
  UNIQUE (property_id, room_type, room_label, source, source_ref)
);

CREATE TABLE IF NOT EXISTS property_interactions (
  id bigserial PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  interaction_type text NOT NULL,
  verdict text,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  source_ref text
);

CREATE TABLE IF NOT EXISTS property_collections (
  property_id uuid NOT NULL REFERENCES property_records(id) ON DELETE CASCADE,
  collection text NOT NULL,
  track text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  source text,
  note text,
  PRIMARY KEY (property_id, collection, track)
);

CREATE TABLE IF NOT EXISTS property_source_snapshots (
  id bigserial PRIMARY KEY,
  property_id uuid REFERENCES property_records(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_ref text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  content_hash text,
  payload jsonb,
  text_excerpt text,
  UNIQUE (source, source_ref, content_hash)
);

CREATE OR REPLACE VIEW property_current AS
SELECT p.*,
  (SELECT value FROM property_observations o WHERE o.property_id=p.id AND o.field='bedrooms' ORDER BY o.confidence DESC, o.observed_at DESC LIMIT 1) AS bedrooms,
  (SELECT value FROM property_observations o WHERE o.property_id=p.id AND o.field='bathrooms' ORDER BY o.confidence DESC, o.observed_at DESC LIMIT 1) AS bathrooms,
  (SELECT value FROM property_observations o WHERE o.property_id=p.id AND o.field='finished_sqft' ORDER BY o.confidence DESC, o.observed_at DESC LIMIT 1) AS finished_sqft,
  (SELECT value FROM property_observations o WHERE o.property_id=p.id AND o.field='year_built' ORDER BY o.confidence DESC, o.observed_at DESC LIMIT 1) AS year_built,
  CASE
    WHEN active_collection.active_since IS NOT NULL
      AND latest_price_event.effective_at < active_collection.active_since - interval '90 days' THEN NULL
    WHEN lower(coalesce(latest_price_event.status,'')) IN ('inactive','unknown','unverified') THEN NULL
    ELSE latest_price_event.price
  END AS latest_price,
  CASE
    WHEN active_collection.active_since IS NOT NULL
      AND latest_status_event.effective_at < active_collection.active_since - interval '90 days' THEN 'Unverified'
    WHEN lower(coalesce(latest_status_event.status,'')) IN ('inactive','unknown','unverified') THEN 'Unverified'
    ELSE latest_status_event.status
  END AS latest_status,
  (SELECT price FROM property_listing_events e WHERE e.property_id=p.id AND e.event_type='sold' ORDER BY e.event_date DESC NULLS LAST, e.observed_at DESC LIMIT 1) AS latest_sale_price,
  (SELECT event_date FROM property_listing_events e WHERE e.property_id=p.id AND e.event_type='sold' ORDER BY e.event_date DESC NULLS LAST, e.observed_at DESC LIMIT 1) AS latest_sale_date,
  latest_status_event.source AS latest_status_source,
  latest_status_event.observed_at AS latest_status_observed_at
FROM property_records p
LEFT JOIN LATERAL (
  SELECT e.*,
    CASE WHEN e.event_type='sold' AND e.event_date IS NOT NULL THEN e.event_date::timestamptz ELSE e.observed_at END AS effective_at
  FROM property_listing_events e WHERE e.property_id=p.id AND e.price IS NOT NULL
  ORDER BY
    (CASE WHEN e.event_type='sold' AND e.event_date IS NOT NULL THEN e.event_date::timestamptz ELSE e.observed_at END)
      - CASE WHEN lower(coalesce(e.status,'')) IN ('inactive','unknown','unverified')
        THEN interval '45 days' ELSE interval '0 days' END DESC,
    e.observed_at DESC LIMIT 1
) latest_price_event ON true
LEFT JOIN LATERAL (
  SELECT e.*,
    CASE WHEN e.event_type='sold' AND e.event_date IS NOT NULL THEN e.event_date::timestamptz ELSE e.observed_at END AS effective_at
  FROM property_listing_events e WHERE e.property_id=p.id AND e.status IS NOT NULL
  -- Status is a timeline, including uncertainty. A newer Unverified event must
  -- supersede an older Active event; otherwise the app falsely shows Active
  -- after the listing provider has reported it off-market.
  ORDER BY
    (CASE WHEN e.event_type='sold' AND e.event_date IS NOT NULL THEN e.event_date::timestamptz ELSE e.observed_at END) DESC,
    e.observed_at DESC LIMIT 1
) latest_status_event ON true
LEFT JOIN LATERAL (
  SELECT min(c.added_at) AS active_since FROM property_collections c
  WHERE c.property_id=p.id AND c.active
    AND c.collection IN ('watchlist','tour-shortlist','tour_shortlist','top-contenders')
) active_collection ON true;

CREATE OR REPLACE VIEW property_bedroom_flags AS
SELECT p.id AS property_id,
  count(r.id) FILTER (WHERE r.room_type='bedroom') AS measured_bedrooms,
  min(r.area_sqft) FILTER (WHERE r.room_type='bedroom') AS smallest_bedroom_sqft,
  CASE
    WHEN count(r.id) FILTER (WHERE r.room_type='bedroom') = 0 THEN 'unknown'
    WHEN min(r.area_sqft) FILTER (WHERE r.room_type='bedroom') < 90 THEN 'critical'
    WHEN min(r.area_sqft) FILTER (WHERE r.room_type='bedroom') < 100 THEN 'small'
    ELSE 'ok'
  END AS bedroom_size_flag
FROM property_records p
LEFT JOIN property_rooms r ON r.property_id=p.id AND r.room_type='bedroom'
GROUP BY p.id;

COMMIT;
