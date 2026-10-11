// Explicit additive market tables; never run by web.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "market-schema.sql"), "utf8");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const client = new pg.Client({ connectionString });
try {
  await client.connect();
  await client.query(sql);
  console.log("Additive market schema applied (idempotent). No market data was inserted.");
} finally {
  await client.end();
}
