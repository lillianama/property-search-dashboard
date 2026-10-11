// One-shot, idempotent application of scripts/rank-prefs-schema.sql (the
// property_funnel_ranks and property_editor_judgments tables behind global
// manual ranking and quick preference judgments). The web app itself never
// runs DDL; run this explicitly, e.g.:
//
//   docker compose run --rm market-ingest node scripts/apply-rank-prefs-schema.mjs
//
// Re-running is always safe: the schema is CREATE ... IF NOT EXISTS only.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "rank-prefs-schema.sql"), "utf8");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(sql);
  console.log("property_funnel_ranks + property_editor_judgments schema applied (idempotent).");
} finally {
  await client.end();
}
