// Explicit one-time initialization for an empty standalone dashboard database.
// This applies schema only (tables, indexes, views, extension); never run by web.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "schema/property-store-schema.sql"), "utf8");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(sql);
  console.log("Base property-store schema applied; no records were inserted.");
} finally {
  await client.end();
}
