-- Shared purchase-price setting revisions; NULL explicitly restores market pricing.
-- Source observations and listing events are never changed by this setting.
CREATE TABLE IF NOT EXISTS public.property_purchase_price_settings (
  id BIGSERIAL PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES public.property_records(id) ON DELETE CASCADE,
  purchase_price NUMERIC(12,2) CHECK (purchase_price > 0 AND purchase_price <= 1000000000),
  saved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  source TEXT NOT NULL DEFAULT 'dashboard-editor'
);
CREATE INDEX IF NOT EXISTS property_purchase_price_settings_current_idx
  ON public.property_purchase_price_settings(property_id, saved_at DESC, id DESC);
REVOKE ALL ON public.property_purchase_price_settings FROM PUBLIC;
GRANT SELECT, INSERT ON public.property_purchase_price_settings TO real_estate_dashboard;
GRANT USAGE ON SEQUENCE public.property_purchase_price_settings_id_seq TO real_estate_dashboard;
