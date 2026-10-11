#!/usr/bin/env node
// On-demand ingestion of official free Zillow Research monthly CSVs into
// Postgres for the Portland Market view.
//
// Loads:
//   - City-level Portland, OR single-family metrics: active inventory,
//     new listings, median list price, median sale price.
//   - Neighborhood-level SFR ZHVI for Portland, OR neighborhoods. ZHVI is
//     Zillow's smoothed, seasonally adjusted *typical* home value, not an
//     average/list/sale price.
//
// Apply scripts/market-schema.sql separately with a schema-capable role.
// Ingestion needs only reads/writes on those market tables, never DDL.
// Rows are upserted on (source, metric, geo_type, region_id, period_end), so
// re-running refreshes revised values without duplicating or destroying
// history. It never touches the property-store tables.
//
// Usage (inside Docker via the market-ingest compose service, or locally):
//   DATABASE_URL=postgres://... node scripts/ingest-zillow.mjs

import { Client } from "pg";
import { buildColumnIndex, metaField, parseCsvLine, rowToRecords } from "./zillow-csv.mjs";

const SOURCE = "zillow_research";
const BASE = "https://files.zillowstatic.com/research/public_csvs";

const CITY_DATASETS = [
  {
    metric: "inventory_sfr",
    url: `${BASE}/invt_fs/City_invt_fs_uc_sfr_sm_month.csv`,
  },
  {
    metric: "new_listings_sfr",
    url: `${BASE}/new_listings/City_new_listings_uc_sfr_sm_month.csv`,
  },
  {
    metric: "median_list_price_sfr",
    url: `${BASE}/mlp/City_mlp_uc_sfr_sm_month.csv`,
  },
  {
    metric: "median_sale_price_sfr",
    url: `${BASE}/median_sale_price/City_median_sale_price_uc_sfr_sm_month.csv`,
  },
];

const NEIGHBORHOOD_ZHVI = {
  metric: "zhvi_sfr",
  url: `${BASE}/zhvi/Neighborhood_zhvi_uc_sfr_tier_0.33_0.67_sm_sa_month.csv`,
};


async function fetchCsvLines(url) {
  const res = await fetch(url, { headers: { "user-agent": "property-market-ingest/1.0" } });
  if (!res.ok) {
    throw new Error(`GET ${url} failed with status ${res.status}`);
  }
  const body = await res.text();
  return body.split(/\r?\n/);
}

/** Upserts unpivoted records in batches. Returns the number of rows sent. */
async function upsertRecords(client, rows) {
  const BATCH = 500;
  let sent = 0;
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    const values = [];
    const params = [];
    for (const row of batch) {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`);
      params.push(
        SOURCE,
        row.metric,
        row.geoType,
        row.regionId,
        row.regionName,
        row.city,
        row.state,
        row.periodEnd,
        row.value,
      );
    }
    await client.query(
      `
        INSERT INTO market_metric_series
          (source, metric, geo_type, region_id, region_name, city, state, period_end, value)
        VALUES ${values.join(", ")}
        ON CONFLICT (source, metric, geo_type, region_id, period_end)
        DO UPDATE SET value = EXCLUDED.value, region_name = EXCLUDED.region_name,
          city = EXCLUDED.city, state = EXCLUDED.state, ingested_at = now()
      `,
      params,
    );
    sent += batch.length;
  }
  return sent;
}

async function ingestCityDataset(client, dataset) {
  const lines = await fetchCsvLines(dataset.url);
  const header = parseCsvLine(lines[0] ?? "");
  const { meta, dateColumns } = buildColumnIndex(header);

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const fields = parseCsvLine(lines[i]);
    if (metaField(fields, meta, "RegionName") !== "Portland") continue;
    if (metaField(fields, meta, "State") !== "OR") continue;
    if (metaField(fields, meta, "RegionType") !== "city") continue;
    const regionId = metaField(fields, meta, "RegionID");
    for (const record of rowToRecords(fields, dateColumns)) {
      rows.push({
        metric: dataset.metric,
        geoType: "city",
        regionId,
        regionName: "Portland",
        city: "Portland",
        state: "OR",
        periodEnd: record.month,
        value: record.value,
      });
    }
  }
  const count = await upsertRecords(client, rows);
  console.log(`[ingest] ${dataset.metric}: upserted ${count} Portland city rows`);
  return count;
}

async function ingestNeighborhoodZhvi(client) {
  const lines = await fetchCsvLines(NEIGHBORHOOD_ZHVI.url);
  const header = parseCsvLine(lines[0] ?? "");
  const { meta, dateColumns } = buildColumnIndex(header);

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const fields = parseCsvLine(lines[i]);
    if (metaField(fields, meta, "City") !== "Portland") continue;
    if (metaField(fields, meta, "State") !== "OR") continue;
    const regionId = metaField(fields, meta, "RegionID");
    const regionName = metaField(fields, meta, "RegionName");
    for (const record of rowToRecords(fields, dateColumns)) {
      rows.push({
        metric: NEIGHBORHOOD_ZHVI.metric,
        geoType: "neighborhood",
        regionId,
        regionName,
        city: "Portland",
        state: "OR",
        periodEnd: record.month,
        value: record.value,
      });
    }
  }
  const count = await upsertRecords(client, rows);
  console.log(`[ingest] ${NEIGHBORHOOD_ZHVI.metric}: upserted ${count} Portland neighborhood rows`);
  return count;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let runId;
  try {
    await client.query("SELECT 1 FROM market_metric_series LIMIT 0");
    await client.query("SELECT 1 FROM market_ingest_runs LIMIT 0");
    const run = await client.query(
      "INSERT INTO market_ingest_runs (source, status) VALUES ($1, 'running') RETURNING id",
      [SOURCE],
    );
    runId = run.rows[0].id;

    let total = 0;
    for (const dataset of CITY_DATASETS) {
      total += await ingestCityDataset(client, dataset);
    }
    total += await ingestNeighborhoodZhvi(client);

    await client.query(
      "UPDATE market_ingest_runs SET finished_at = now(), status = 'succeeded', detail = $2 WHERE id = $1",
      [runId, `upserted ${total} rows`],
    );
    console.log(`[ingest] done: ${total} rows upserted`);
  } catch (err) {
    console.error("[ingest] failed:", err instanceof Error ? err.message : err);
    if (runId !== undefined) {
      await client
        .query(
          "UPDATE market_ingest_runs SET finished_at = now(), status = 'failed', detail = $2 WHERE id = $1",
          [runId, err instanceof Error ? err.message : String(err)],
        )
        .catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
