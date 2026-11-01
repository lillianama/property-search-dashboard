-- New additive schema; apply as the trusted schema owner. Provision the LOGIN
-- role separately, without memberships or inherited application privileges.
BEGIN;
CREATE TABLE public.browser_observation_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.property_records(id),
  zpid text NOT NULL,
  capture_id uuid NOT NULL,
  source_url text NOT NULL,
  observed_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  price integer NOT NULL CHECK (price BETWEEN 1 AND 1000000000),
  status text NOT NULL CHECK (status IN ('Active', 'Pending')),
  changed_fields text[] NOT NULL,
  UNIQUE (zpid, capture_id)
);

CREATE FUNCTION public.save_browser_observation(observation jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tracked_id uuid;
  identities uuid[];
  capture uuid;
  captured_at timestamptz;
  effective_at timestamptz;
  prior_result text[];
  before_row record;
  after_row record;
  changes text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(observation) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid observation' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(observation)) <> 6
    OR NOT observation ?& ARRAY['zpid','url','captureId','observedAt','price','status']
    OR jsonb_typeof(observation->'zpid') IS DISTINCT FROM 'string'
    OR (observation->>'zpid') !~ '^[1-9][0-9]{0,19}$'
    OR jsonb_typeof(observation->'url') IS DISTINCT FROM 'string'
    OR observation->>'url' <> 'https://www.zillow.com/homedetails/' || (observation->>'zpid') || '_zpid/'
    OR jsonb_typeof(observation->'captureId') IS DISTINCT FROM 'string'
    OR (observation->>'captureId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(observation->'observedAt') IS DISTINCT FROM 'string'
    OR (observation->>'observedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR jsonb_typeof(observation->'price') IS DISTINCT FROM 'number'
    OR (observation->>'price')::numeric NOT BETWEEN 1 AND 1000000000
    OR (observation->>'price')::numeric <> trunc((observation->>'price')::numeric)
    OR jsonb_typeof(observation->'status') IS DISTINCT FROM 'string'
    OR (observation->>'status') NOT IN ('Active','Pending') THEN
    RAISE EXCEPTION 'invalid observation' USING ERRCODE = '22023';
  END IF;
  capture := (observation->>'captureId')::uuid;
  captured_at := (observation->>'observedAt')::timestamptz;
  IF NOT isfinite(captured_at) OR captured_at < statement_timestamp() - interval '24 hours'
    OR captured_at > statement_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid observation timestamp' USING ERRCODE = '22023';
  END IF;
  effective_at := LEAST(captured_at, statement_timestamp());
  PERFORM pg_advisory_xact_lock(hashtextextended('zillow:' || (observation->>'zpid'), 0));
  -- A capture is immutable: retries replay its original acknowledgement.
  SELECT h.changed_fields INTO prior_result FROM public.browser_observation_history h
    WHERE h.zpid = observation->>'zpid' AND h.capture_id = capture;
  IF FOUND THEN
    RETURN jsonb_build_object('matched',true,'zpid',observation->>'zpid','changedFields',prior_result);
  END IF;
  SELECT array_agg(DISTINCT i.property_id) INTO identities
    FROM public.property_identifiers i
    WHERE (i.kind IN ('zpid','zillow_zpid') AND i.value = observation->>'zpid')
      OR (i.kind = 'zillow_url' AND i.value ~
        ('^https://(www\.)?zillow\.com/homedetails/([^/?#]+/)?' || (observation->>'zpid') || '_zpid/?([?#].*)?$'));
  IF coalesce(cardinality(identities),0) <> 1 THEN
    RETURN jsonb_build_object('matched',false,'changedFields',ARRAY[]::text[]);
  END IF;
  tracked_id := identities[1];
  PERFORM pg_advisory_xact_lock(hashtextextended('property:' || tracked_id::text, 0));
  -- Serialize against ordinary foreign-key-backed event inserts as well.
  PERFORM 1 FROM public.property_records p WHERE p.id = tracked_id FOR UPDATE;
  SELECT p.latest_price,p.latest_status INTO STRICT before_row
    FROM public.property_current p WHERE p.id = tracked_id;
  -- Keep stale evidence in the audit only: never let it fill or replace a
  -- projected field, including the base view's uncertainty price adjustment.
  IF NOT EXISTS (
    SELECT 1 FROM public.property_listing_events e WHERE e.property_id = tracked_id
      AND (e.price IS NOT NULL OR e.status IS NOT NULL)
      AND (CASE WHEN e.event_type='sold' AND e.event_date IS NOT NULL
        THEN e.event_date::timestamptz ELSE e.observed_at END) >= effective_at
  ) THEN
    INSERT INTO public.property_listing_events
      (property_id,event_type,price,status,source,source_ref,observed_at)
    VALUES (tracked_id,'browser_observation',(observation->>'price')::integer,
      observation->>'status','zillow-browser',observation->>'url',effective_at);
    SELECT p.latest_price,p.latest_status INTO STRICT after_row
      FROM public.property_current p WHERE p.id = tracked_id;
    IF before_row.latest_price IS DISTINCT FROM after_row.latest_price THEN changes := array_append(changes,'price'); END IF;
    IF before_row.latest_status IS DISTINCT FROM after_row.latest_status THEN changes := array_append(changes,'status'); END IF;
  END IF;
  INSERT INTO public.browser_observation_history
    (property_id,zpid,capture_id,source_url,observed_at,effective_at,price,status,changed_fields)
  VALUES (tracked_id,observation->>'zpid',capture,observation->>'url',captured_at,
    effective_at,(observation->>'price')::integer,observation->>'status',changes);
  RETURN jsonb_build_object('matched',true,'zpid',observation->>'zpid','changedFields',changes);
END;
$$;
REVOKE ALL ON FUNCTION public.save_browser_observation(jsonb) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM browser_observation_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM browser_observation_writer;
REVOKE ALL ON SCHEMA public FROM browser_observation_writer;
GRANT USAGE ON SCHEMA public TO browser_observation_writer;
GRANT EXECUTE ON FUNCTION public.save_browser_observation(jsonb) TO browser_observation_writer;
COMMIT;
