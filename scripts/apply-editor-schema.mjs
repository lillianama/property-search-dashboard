// One-shot, idempotent application of scripts/editor-schema.sql (the
// property_editor_notes table behind the dashboard's property editor).
// The web app itself never runs DDL; run this explicitly, e.g.:
//
//   docker compose run --rm market-ingest node scripts/apply-editor-schema.mjs
//
// Re-running is always safe: the schema is CREATE ... IF NOT EXISTS only.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "editor-schema.sql"), "utf8");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(sql);
  console.log("property_editor_notes schema applied (idempotent).");
} finally {
  await client.end();
}
