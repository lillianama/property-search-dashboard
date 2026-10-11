-- Additive dashboard market-ingestion schema. Safe to re-run; contains no property data.
CREATE TABLE IF NOT EXISTS market_metric_series (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    metric TEXT NOT NULL,
    geo_type TEXT NOT NULL,
    region_id TEXT NOT NULL,
    region_name TEXT NOT NULL,
    city TEXT,
    state TEXT,
    period_end DATE NOT NULL,
    value NUMERIC NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, metric, geo_type, region_id, period_end)
  );
  CREATE INDEX IF NOT EXISTS market_metric_series_lookup_idx
    ON market_metric_series (source, metric, geo_type, region_name, state, period_end);
  CREATE TABLE IF NOT EXISTS market_ingest_runs (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    detail TEXT
  );
