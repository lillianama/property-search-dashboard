-- New additive schema; apply as the trusted schema owner. Provision the LOGIN
-- role separately, without memberships or inherited application privileges.
BEGIN;
CREATE TABLE IF NOT EXISTS public.browser_observation_history (
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

-- Resolve exact identifiers only. No address guesses, intake, or record merges.
-- Both independent legacy anchors are required before persisting a missing zpid.
CREATE OR REPLACE FUNCTION public.resolve_browser_observation_identity(observation jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  evidence jsonb := observation->'identity';
  ids uuid[]; parcels uuid[]; listings uuid[]; tracked uuid; legacy boolean := false;
BEGIN
  IF observation ? 'identity' THEN
    IF jsonb_typeof(evidence) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid identity' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(evidence))<>2
      OR NOT evidence ?& ARRAY['parcelId','mlsNumber']
      OR jsonb_typeof(evidence->'parcelId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(evidence->'mlsNumber') IS DISTINCT FROM 'string'
      OR evidence->>'parcelId' !~ '^[A-Za-z0-9-]{1,40}$'
      OR evidence->>'mlsNumber' !~ '^[A-Za-z0-9-]{1,40}$'
      THEN RAISE EXCEPTION 'invalid identity' USING ERRCODE='22023'; END IF;
  END IF;
  SELECT array_agg(DISTINCT i.property_id) INTO ids FROM public.property_identifiers i
    WHERE (i.kind IN ('zpid','zillow_zpid') AND i.value=observation->>'zpid')
      OR (i.kind='zillow_url' AND i.value ~ ('^https://(www\.)?zillow\.com/homedetails/([^/?#]+/)?' || (observation->>'zpid') || '_zpid/?([?#].*)?$'));
  IF coalesce(cardinality(ids),0)>1 THEN RETURN NULL; END IF;
  IF evidence IS NOT NULL THEN
    SELECT array_agg(DISTINCT property_id) INTO parcels FROM public.property_identifiers WHERE kind IN ('parcel','parcel_id') AND value=evidence->>'parcelId';
    SELECT array_agg(DISTINCT property_id) INTO listings FROM public.property_identifiers WHERE kind IN ('mls','mls_number') AND value=evidence->>'mlsNumber';
    IF coalesce(cardinality(ids),0)=0 THEN
      IF coalesce(cardinality(parcels),0)<>1 OR coalesce(cardinality(listings),0)<>1 OR parcels[1]<>listings[1] THEN RETURN NULL; END IF;
      ids:=parcels; legacy:=true;
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(parcels || listings) p WHERE p<>ids[1]) THEN RETURN NULL; END IF;
  END IF;
  IF coalesce(cardinality(ids),0)<>1 THEN RETURN NULL; END IF;
  tracked:=ids[1];
  PERFORM pg_advisory_xact_lock(hashtextextended('property:' || tracked::text,0));
  PERFORM 1 FROM public.property_records WHERE id=tracked FOR UPDATE;
  -- Reject contradictory identifiers even when another alias selected the row.
  IF EXISTS (SELECT 1 FROM public.property_identifiers i WHERE i.property_id=tracked AND
    ((i.kind IN ('zpid','zillow_zpid') AND i.value<>observation->>'zpid') OR
     (i.kind='zillow_url' AND i.value ~ '^https://(www\.)?zillow\.com/homedetails/([^/?#]+/)?[1-9][0-9]*_zpid/?([?#].*)?$'
       AND i.value !~ ('^https://(www\.)?zillow\.com/homedetails/([^/?#]+/)?' || (observation->>'zpid') || '_zpid/?([?#].*)?$')) OR
     (evidence IS NOT NULL AND i.kind IN ('parcel','parcel_id') AND i.value<>evidence->>'parcelId') OR
     (evidence IS NOT NULL AND i.kind IN ('mls','mls_number') AND i.value<>evidence->>'mlsNumber')))
    THEN RETURN NULL; END IF;
  -- Unique(kind,value) and the zpid transaction lock prevent competing bindings.
  IF legacy THEN
    INSERT INTO public.property_identifiers(property_id,kind,value,source)
      VALUES(tracked,'zpid',observation->>'zpid','zillow-browser-exact-identity') ON CONFLICT(kind,value) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM public.property_identifiers WHERE kind='zpid' AND value=observation->>'zpid' AND property_id=tracked) THEN RETURN NULL; END IF;
  END IF;
  RETURN tracked;
END; $$;
REVOKE ALL ON FUNCTION public.resolve_browser_observation_identity(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.save_browser_observation_v1(observation jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  tracked_id uuid;
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
  IF (SELECT count(*) FROM jsonb_object_keys(observation)) <> (CASE WHEN observation ? 'identity' THEN 7 ELSE 6 END)
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
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(observation) k WHERE k NOT IN ('zpid','url','captureId','observedAt','price','status','identity')) THEN RAISE EXCEPTION 'invalid observation' USING ERRCODE='22023'; END IF;
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
  tracked_id := public.resolve_browser_observation_identity(observation);
  IF tracked_id IS NULL THEN RETURN jsonb_build_object('matched',false,'changedFields',ARRAY[]::text[]); END IF;
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
REVOKE ALL ON FUNCTION public.save_browser_observation_v1(jsonb) FROM PUBLIC;
CREATE TABLE IF NOT EXISTS public.browser_observation_field_history (
  zpid text NOT NULL, capture_id uuid NOT NULL, property_id uuid NOT NULL REFERENCES public.property_records(id),
  payload jsonb NOT NULL, changed_fields text[] NOT NULL, PRIMARY KEY (zpid,capture_id)
);
CREATE OR REPLACE FUNCTION public.save_browser_observation(observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  field_name text; val jsonb; captured timestamptz; effective timestamptz; capture uuid;
  tracked uuid; previous jsonb; after_value jsonb; prior_payload jsonb; old_price integer; old_status text;
  new_price integer; new_status text; changes text[] := ARRAY[]::text[]; prior text[];
  added_id bigint; tax_year integer; v_event_date date; min_value numeric; max_value numeric; integral boolean := false; item jsonb;
BEGIN
  IF octet_length(observation::text) > 256000 THEN RAISE EXCEPTION 'invalid observation' USING ERRCODE='22023'; END IF;
  IF observation ? 'identity' THEN
    IF jsonb_typeof(observation->'identity') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid identity' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(observation->'identity'))<>2
      OR NOT (observation->'identity') ?& ARRAY['parcelId','mlsNumber']
      OR jsonb_typeof(observation->'identity'->'parcelId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(observation->'identity'->'mlsNumber') IS DISTINCT FROM 'string'
      OR observation->'identity'->>'parcelId' !~ '^[A-Za-z0-9-]{1,40}$'
      OR observation->'identity'->>'mlsNumber' !~ '^[A-Za-z0-9-]{1,40}$'
      THEN RAISE EXCEPTION 'invalid identity' USING ERRCODE='22023'; END IF;
  END IF;
  IF NOT (observation ? 'field') THEN RETURN public.save_browser_observation_v1(observation); END IF;
  IF jsonb_typeof(observation) IS DISTINCT FROM 'object' OR octet_length(observation::text) > 256000
    OR (SELECT count(*) FROM jsonb_object_keys(observation)) <> (CASE WHEN observation ? 'identity' THEN 7 ELSE 6 END)
    OR NOT observation ?& ARRAY['zpid','url','captureId','observedAt','field','value']
    OR jsonb_typeof(observation->'zpid') IS DISTINCT FROM 'string' OR observation->>'zpid' !~ '^[1-9][0-9]{0,19}$'
    OR jsonb_typeof(observation->'url') IS DISTINCT FROM 'string' OR observation->>'url' <> 'https://www.zillow.com/homedetails/' || (observation->>'zpid') || '_zpid/'
    OR jsonb_typeof(observation->'captureId') IS DISTINCT FROM 'string' OR observation->>'captureId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(observation->'observedAt') IS DISTINCT FROM 'string' OR observation->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR jsonb_typeof(observation->'field') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'invalid observation' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(observation) k WHERE k NOT IN ('zpid','url','captureId','observedAt','field','value','identity')) THEN RAISE EXCEPTION 'invalid observation' USING ERRCODE='22023'; END IF;
  field_name := observation->>'field'; val := observation->'value';
  CASE field_name
    WHEN 'bedrooms' THEN min_value:=0; max_value:=100;
    WHEN 'bathrooms' THEN min_value:=0; max_value:=100;
    WHEN 'finished_sqft' THEN min_value:=1; max_value:=10000000; integral:=true;
    WHEN 'structure_sqft' THEN min_value:=1; max_value:=10000000; integral:=true;
    WHEN 'year_built' THEN min_value:=1600; max_value:=2100; integral:=true;
    WHEN 'lot_sqft' THEN min_value:=1; max_value:=1000000000;
    WHEN 'latitude' THEN min_value:=-90; max_value:=90;
    WHEN 'longitude' THEN min_value:=-180; max_value:=180;
    WHEN 'annual_property_tax' THEN min_value:=0.01; max_value:=1000000000;
    WHEN 'annual_property_tax_year' THEN min_value:=1900; max_value:=2100; integral:=true;
    WHEN 'zestimate' THEN min_value:=1; max_value:=1000000000; integral:=true;
    WHEN 'rent_zestimate' THEN min_value:=1; max_value:=10000000; integral:=true;
    WHEN 'monthly_hoa_fee' THEN min_value:=0; max_value:=10000000;
    WHEN 'stories' THEN min_value:=0.5; max_value:=200;
    WHEN 'unit_count' THEN min_value:=1; max_value:=10000; integral:=true;
    WHEN 'days_on_market' THEN min_value:=0; max_value:=100000; integral:=true;
    WHEN 'published_assessed_value' THEN min_value:=1; max_value:=1000000000;
    WHEN 'published_annual_tax_amount' THEN min_value:=0.01; max_value:=1000000000;
    ELSE NULL;
  END CASE;
  IF field_name='tax_history' THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'object' OR NOT val ?& ARRAY['year','taxPaid'] OR EXISTS (SELECT 1 FROM jsonb_object_keys(val) k WHERE k NOT IN ('year','taxPaid','assessedValue')) OR jsonb_typeof(val->'year') IS DISTINCT FROM 'number' OR jsonb_typeof(val->'taxPaid') IS DISTINCT FROM 'number' OR (val ? 'assessedValue' AND jsonb_typeof(val->'assessedValue') IS DISTINCT FROM 'number') THEN RAISE EXCEPTION 'invalid tax history' USING ERRCODE='22023'; END IF;
    IF (val->>'year')::numeric NOT BETWEEN 1900 AND 2100 OR trunc((val->>'year')::numeric)<>(val->>'year')::numeric OR (val->>'taxPaid')::numeric <= 0 OR (val->>'taxPaid')::numeric>1000000000 OR (val ? 'assessedValue' AND ((val->>'assessedValue')::numeric<=0 OR (val->>'assessedValue')::numeric>1000000000)) THEN RAISE EXCEPTION 'invalid tax history' USING ERRCODE='22023'; END IF;
    tax_year:=(val->>'year')::integer; val:=val->'taxPaid'; field_name:='annual_property_tax'; min_value:=0; max_value:=1000000000;
  END IF;
  IF field_name='annual_property_tax' AND jsonb_typeof(val)='object' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(val))<>2 OR jsonb_typeof(val->'amount') IS DISTINCT FROM 'number' OR jsonb_typeof(val->'year') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid tax' USING ERRCODE='22023'; END IF;
    IF (val->>'year')::numeric NOT BETWEEN 1900 AND 2100 OR trunc((val->>'year')::numeric)<>(val->>'year')::numeric THEN RAISE EXCEPTION 'invalid tax year' USING ERRCODE='22023'; END IF;
    tax_year:=(val->>'year')::integer; val:=val->'amount';
  END IF;
  IF min_value IS NOT NULL THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid value' USING ERRCODE='22023'; END IF;
    IF (val #>> '{}')::numeric NOT BETWEEN min_value AND max_value OR (integral AND trunc((val #>> '{}')::numeric) <> (val #>> '{}')::numeric) THEN RAISE EXCEPTION 'invalid value' USING ERRCODE='22023'; END IF;
  ELSIF field_name = 'listing_history' THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'object' OR NOT val ?& ARRAY['date','event','kind'] OR EXISTS (SELECT 1 FROM jsonb_object_keys(val) k WHERE k NOT IN ('date','event','price','source','mlsNumber','kind')) OR jsonb_typeof(val->'date') IS DISTINCT FROM 'string' OR val->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR jsonb_typeof(val->'event') IS DISTINCT FROM 'string' OR length(btrim(val->>'event'))=0 OR octet_length(val->>'event')>200 OR jsonb_typeof(val->'kind') IS DISTINCT FROM 'string' OR val->>'kind' NOT IN ('sale','rental') OR EXISTS (SELECT 1 FROM jsonb_each(val) WHERE key IN ('source','mlsNumber') AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(btrim(value #>> '{}'))=0 OR octet_length(value #>> '{}')>200)) THEN RAISE EXCEPTION 'invalid history' USING ERRCODE='22023'; END IF;
    IF lower(val->>'event') NOT IN ('pending sale','price change','listed for sale','listing removed','listed for rent','sold','rented','relisted','contingent','listing pending') OR (val ? 'source' AND val->>'source' !~* '^(RMLS( \(OR\))?|Zillow)$') OR (val ? 'mlsNumber' AND val->>'mlsNumber' !~ '^[A-Za-z0-9-]{1,40}$') OR (lower(val->>'event') IN ('listed for rent','rented') AND val->>'kind'<>'rental') OR (lower(val->>'event') IN ('listed for sale','pending sale','sold') AND val->>'kind'<>'sale') THEN RAISE EXCEPTION 'invalid history event' USING ERRCODE='22023'; END IF;
    v_event_date:=(val->>'date')::date;
    IF to_char(v_event_date,'YYYY-MM-DD')<>val->>'date' OR v_event_date>current_date OR v_event_date<'1800-01-01'::date THEN RAISE EXCEPTION 'invalid history date' USING ERRCODE='22023'; END IF;
    IF val ? 'price' THEN
      IF jsonb_typeof(val->'price') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid history price' USING ERRCODE='22023'; END IF;
      IF (val->>'price')::numeric NOT BETWEEN 1 AND 1000000000 OR trunc((val->>'price')::numeric)<>(val->>'price')::numeric THEN RAISE EXCEPTION 'invalid history price' USING ERRCODE='22023'; END IF;
    END IF;
  ELSIF field_name IN ('parcel_id','mls_number') THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'string' OR (val #>> '{}') !~ '^[A-Za-z0-9-]{1,40}$' THEN RAISE EXCEPTION 'invalid parcel' USING ERRCODE='22023'; END IF;
  ELSIF field_name='published_room' THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(val) k WHERE k NOT IN ('roomType','roomLabel','level','widthFt','lengthFt','areaSqft')) OR jsonb_typeof(val->'roomType') IS DISTINCT FROM 'string' OR val->>'roomType' NOT IN ('bedroom','bathroom','kitchen','living_room','dining_room','other') OR NOT (val ?| ARRAY['widthFt','lengthFt','areaSqft','level']) THEN RAISE EXCEPTION 'invalid room' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT jsonb_build_object('key',key,'value',value) FROM jsonb_each(val) WHERE key IN ('widthFt','lengthFt','areaSqft') LOOP
      IF jsonb_typeof(item->'value') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid room dimension' USING ERRCODE='22023'; END IF;
      IF (item->>'value')::numeric <= 0 OR (item->>'value')::numeric > (CASE WHEN item->>'key'='areaSqft' THEN 100000 ELSE 1000 END) THEN RAISE EXCEPTION 'invalid room dimension' USING ERRCODE='22023'; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_each(val) WHERE key IN ('roomLabel','level') AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR length(btrim(value #>> '{}'))=0 OR octet_length(value #>> '{}')>120)) THEN RAISE EXCEPTION 'invalid room metadata' USING ERRCODE='22023'; END IF;
  ELSIF field_name='unit_mix' THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid units' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(val) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'invalid units' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(val) LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid unit' USING ERRCODE='22023'; END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(item))=0 OR EXISTS (SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN ('bedrooms','bathrooms','sqft','occupancy','actualRent','expectedMonthlyRent')) THEN RAISE EXCEPTION 'invalid unit keys' USING ERRCODE='22023'; END IF;
      IF item ? 'occupancy' AND (jsonb_typeof(item->'occupancy') IS DISTINCT FROM 'string' OR item->>'occupancy' NOT IN ('occupied','vacant')) THEN RAISE EXCEPTION 'invalid occupancy' USING ERRCODE='22023'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each(item) WHERE key<>'occupancy' AND jsonb_typeof(value) IS DISTINCT FROM 'number') THEN RAISE EXCEPTION 'invalid unit number' USING ERRCODE='22023'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_each(item) WHERE key<>'occupancy' AND ((value #>> '{}')::numeric<0 OR (value #>> '{}')::numeric>10000000)) THEN RAISE EXCEPTION 'invalid unit number' USING ERRCODE='22023'; END IF;
    END LOOP;
  ELSIF field_name = 'listing' THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'object' OR jsonb_typeof(val->'status') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'invalid listing' USING ERRCODE='22023'; END IF;
    IF val->>'status' IN ('Active','Pending') THEN
      IF (SELECT count(*) FROM jsonb_object_keys(val)) <> 2 OR jsonb_typeof(val->'price') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid listing' USING ERRCODE='22023'; END IF;
      IF (val->>'price')::numeric NOT BETWEEN 1 AND 1000000000 OR trunc((val->>'price')::numeric) <> (val->>'price')::numeric THEN RAISE EXCEPTION 'invalid listing' USING ERRCODE='22023'; END IF;
    ELSIF val->>'status' NOT IN ('Sold','Off market','For rent') OR (SELECT count(*) FROM jsonb_object_keys(val)) <> 1 THEN RAISE EXCEPTION 'invalid listing' USING ERRCODE='22023'; END IF;
  ELSIF field_name IN ('property_type','description','mls_number','basement','laundry','windows','foundation','architectural_style','patio_porch','view','sewer','water','gas','listing_terms','has_hoa','new_construction','has_view','room_types','date_on_market') THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'string' OR length(btrim(val #>> '{}'))=0 OR octet_length(val #>> '{}') > (CASE WHEN field_name='description' THEN 50000 ELSE 500 END) THEN RAISE EXCEPTION 'invalid text' USING ERRCODE='22023'; END IF;
  ELSIF field_name IN ('parking_features','interior_features','exterior_features','appliances','property_subtype','heating','cooling','roof','flooring') THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid array' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(val) NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'invalid array' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(val) LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR length(btrim(item #>> '{}'))=0 OR octet_length(item #>> '{}')>200 THEN RAISE EXCEPTION 'invalid array' USING ERRCODE='22023'; END IF;
    END LOOP;
  ELSIF field_name='photo_url' THEN
    IF jsonb_typeof(val) IS DISTINCT FROM 'string' OR octet_length(val #>> '{}') > 2048 OR (val #>> '{}') !~* '^https://([a-z0-9-]+\.)*zillowstatic\.com/[^[:space:]?#]*$' THEN RAISE EXCEPTION 'invalid photo' USING ERRCODE='22023'; END IF;
  ELSE RAISE EXCEPTION 'invalid field' USING ERRCODE='22023'; END IF;
  capture := (observation->>'captureId')::uuid; captured := (observation->>'observedAt')::timestamptz;
  IF NOT isfinite(captured) OR captured < statement_timestamp()-interval '24 hours' OR captured > statement_timestamp()+interval '5 minutes' THEN RAISE EXCEPTION 'invalid timestamp' USING ERRCODE='22023'; END IF;
  effective := least(captured,statement_timestamp());
  PERFORM pg_advisory_xact_lock(hashtextextended('zillow:' || (observation->>'zpid'),0));
  SELECT h.changed_fields,h.payload INTO prior,prior_payload FROM public.browser_observation_field_history h WHERE h.zpid=observation->>'zpid' AND h.capture_id=capture;
  IF FOUND THEN
    IF prior_payload IS DISTINCT FROM observation THEN RAISE EXCEPTION 'capture conflict' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('matched',true,'zpid',observation->>'zpid','changedFields',prior); END IF;
  tracked := public.resolve_browser_observation_identity(observation);
  IF tracked IS NULL THEN RETURN jsonb_build_object('matched',false,'changedFields',ARRAY[]::text[]); END IF;
  PERFORM 1 FROM public.property_records p WHERE p.id=tracked FOR UPDATE;
  IF field_name='listing_history' THEN
    IF NOT EXISTS (SELECT 1 FROM public.property_listing_events e WHERE e.property_id=tracked AND e.source='zillow-browser' AND e.event_date=v_event_date AND e.raw=val) THEN
      INSERT INTO public.property_listing_events(property_id,event_type,event_date,price,status,source,source_ref,observed_at,raw)
      VALUES (tracked,CASE WHEN val->>'kind'='sale' AND lower(val->>'event')='sold' THEN 'sold' WHEN val->>'kind'='rental' THEN 'browser_rental_history' ELSE 'browser_history' END,v_event_date,
        CASE WHEN val->>'kind'='sale' THEN (val->>'price')::integer ELSE NULL END,
        CASE WHEN val->>'kind'='sale' AND lower(val->>'event')='sold' THEN 'Sold' ELSE NULL END,'zillow-browser',observation->>'url',v_event_date::timestamptz,val) ON CONFLICT DO NOTHING RETURNING id INTO added_id;
      IF added_id IS NOT NULL THEN changes:=array_append(changes,'listing_history'); END IF;
    END IF;
  ELSIF field_name='published_room' THEN
    IF NOT EXISTS (SELECT 1 FROM public.property_rooms r WHERE r.property_id=tracked AND r.source='zillow-browser' AND r.raw=val) THEN
      INSERT INTO public.property_rooms(property_id,room_type,room_label,level,width_ft,length_ft,area_sqft,is_primary,source,source_ref,observed_at,confidence,raw)
      VALUES (tracked,val->>'roomType',val->>'roomLabel',val->>'level',(val->>'widthFt')::numeric,(val->>'lengthFt')::numeric,
        coalesce((val->>'areaSqft')::numeric,(val->>'widthFt')::numeric * (val->>'lengthFt')::numeric),
        NULL,'zillow-browser',(observation->>'url') || '#' || capture::text,effective,0.650,val);
      changes:=array_append(changes,'published_room');
    END IF;
  ELSIF tax_year IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.property_observations o WHERE o.property_id=tracked AND o.field='annual_property_tax' AND o.source='zillow-browser' AND o.value=val AND o.raw->'propertyTaxes' ? tax_year::text) THEN
      INSERT INTO public.property_observations(property_id,field,value,source,source_ref,observed_at,confidence,raw)
      VALUES(tracked,'annual_property_tax',val,'zillow-browser',(observation->>'url') || '#' || capture::text,effective,0.650,
        jsonb_build_object('propertyTaxes',jsonb_build_object(tax_year::text,jsonb_build_object('year',tax_year,'total',val))) || CASE WHEN observation->'value' ? 'assessedValue' THEN jsonb_build_object('assessedValue',observation->'value'->'assessedValue') ELSE '{}'::jsonb END);
      changes:=array_append(changes,observation->>'field');
    END IF;
  ELSIF field_name='listing' THEN
    SELECT latest_price,latest_status INTO old_price,old_status FROM public.property_current WHERE id=tracked;
    IF (old_status IS DISTINCT FROM val->>'status' OR (val ? 'price' AND old_price IS DISTINCT FROM (val->>'price')::integer)) AND NOT EXISTS (SELECT 1 FROM public.property_listing_events e WHERE e.property_id=tracked AND (e.price IS NOT NULL OR e.status IS NOT NULL) AND (CASE WHEN e.event_type='sold' AND e.event_date IS NOT NULL THEN e.event_date::timestamptz ELSE e.observed_at END)>=effective) AND NOT EXISTS (SELECT 1 FROM public.property_listing_events e WHERE e.property_id=tracked AND lower(e.source) LIKE 'rmls%' AND (e.price IS NOT NULL OR e.status IS NOT NULL) AND (CASE WHEN e.event_type='sold' AND e.event_date IS NOT NULL THEN e.event_date::timestamptz ELSE e.observed_at END) >= effective - interval '24 hours') THEN
      INSERT INTO public.property_listing_events(property_id,event_type,price,status,source,source_ref,observed_at) VALUES (tracked,'browser_observation',(val->>'price')::integer,val->>'status','zillow-browser',observation->>'url',effective);
      SELECT latest_price,latest_status INTO new_price,new_status FROM public.property_current WHERE id=tracked;
      IF old_price IS DISTINCT FROM new_price THEN changes:=array_append(changes,'price'); END IF;
      IF old_status IS DISTINCT FROM new_status THEN changes:=array_append(changes,'status'); END IF;
    END IF;
  ELSIF field_name='photo_url' THEN
    IF NOT EXISTS (SELECT 1 FROM public.property_observations o WHERE o.property_id=tracked AND o.field='photo_url' AND o.observed_at>effective) AND NOT EXISTS (SELECT 1 FROM public.property_observations o WHERE o.property_id=tracked AND o.field='photo_url' AND o.value=val) THEN
      INSERT INTO public.property_observations(property_id,field,value,source,source_ref,observed_at,confidence,raw) VALUES (tracked,field_name,val,'zillow-browser',(observation->>'url') || '#' || capture::text,effective,0.650,jsonb_build_object('photoUrl',val));
      changes:=array_append(changes,field_name);
    END IF;
  ELSE
    SELECT o.value INTO previous FROM public.property_observations o WHERE o.property_id=tracked AND o.field=field_name ORDER BY o.confidence DESC,o.observed_at DESC LIMIT 1;
    IF NOT EXISTS (SELECT 1 FROM public.property_observations o WHERE o.property_id=tracked AND o.field=field_name AND o.observed_at>=effective) AND (previous IS DISTINCT FROM val OR NOT EXISTS (SELECT 1 FROM public.property_observations o WHERE o.property_id=tracked AND o.field=field_name AND o.source='zillow-browser' AND o.value=val) OR (tax_year IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.property_observations o WHERE o.property_id=tracked AND o.field=field_name AND o.value=val AND o.raw->'propertyTaxes' ? tax_year::text))) THEN
      INSERT INTO public.property_observations(property_id,field,value,source,source_ref,observed_at,confidence,raw) VALUES (tracked,field_name,val,'zillow-browser',observation->>'url',effective,0.650,CASE WHEN tax_year IS NOT NULL THEN jsonb_build_object('propertyTaxes',jsonb_build_object(tax_year::text,jsonb_build_object('year',tax_year,'total',val))) ELSE NULL END);
      SELECT o.value INTO after_value FROM public.property_observations o WHERE o.property_id=tracked AND o.field=field_name ORDER BY o.confidence DESC,o.observed_at DESC LIMIT 1;
      IF previous IS DISTINCT FROM after_value OR tax_year IS NOT NULL THEN changes:=array_append(changes,CASE WHEN observation->>'field'='tax_history' THEN 'tax_history' ELSE field_name END); END IF;
    END IF;
  END IF;
  IF field_name='mls_number' AND NOT EXISTS (SELECT 1 FROM public.property_identifiers i WHERE i.kind='mls_number' AND i.value=val #>> '{}' AND i.property_id<>tracked) THEN
    INSERT INTO public.property_identifiers(property_id,kind,value,source) VALUES(tracked,'mls_number',val #>> '{}','zillow-browser') ON CONFLICT(kind,value) DO NOTHING;
  END IF;
  INSERT INTO public.browser_observation_field_history(zpid,capture_id,property_id,payload,changed_fields) VALUES (observation->>'zpid',capture,tracked,observation,changes);
  RETURN jsonb_build_object('matched',true,'zpid',observation->>'zpid','changedFields',changes);
END; $$;
REVOKE ALL ON FUNCTION public.save_browser_observation(jsonb) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM browser_observation_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM browser_observation_writer;
REVOKE ALL ON SCHEMA public FROM browser_observation_writer;
GRANT USAGE ON SCHEMA public TO browser_observation_writer;
GRANT EXECUTE ON FUNCTION public.save_browser_observation(jsonb) TO browser_observation_writer;
COMMIT;
