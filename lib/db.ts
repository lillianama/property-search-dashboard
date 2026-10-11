import { Pool, type PoolClient } from "pg";

// Every analytics/read path in this app goes through withReadOnlyClient,
// which pins the session to read-only so an accidental write fails loudly
// instead of mutating the user’s research history. The single, deliberate
// exception is withWriteTransaction below, which exists solely for the two
// narrow write paths: funnel bucket moves in lib/funnel-writes.ts
// (allowlisted property_collections/property_interactions statements) and
// editor-note revisions in lib/editor-writes.ts (append-only INSERTs into
// property_editor_notes). Nothing else may write, and no DDL ever runs
// from this app.

let pool: Pool | undefined;
let poolInitError: string | undefined;

function getPool(): Pool | null {
  if (pool) return pool;
  if (poolInitError) return null;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    poolInitError = "DATABASE_URL is not set";
    return null;
  }

  try {
    const created = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    created.on("error", (err) => {
      // Pool-level errors happen on idle connections and must not crash
      // the Next.js server process.
      console.error("[db] idle pool error:", err instanceof Error ? err.message : err);
    });
    pool = created;
    return pool;
  } catch (err) {
    poolInitError = err instanceof Error ? err.message : "failed to initialize pool";
    return null;
  }
}

export class DatabaseUnavailableError extends Error {
  constructor(reason: string) {
    super(`database unavailable: ${reason}`);
    this.name = "DatabaseUnavailableError";
  }
}

/**
 * Runs `fn` with a client pinned to a read-only transaction mode for the
 * lifetime of the session. Never use this helper to write data.
 */
export async function withReadOnlyClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  if (!p) {
    throw new DatabaseUnavailableError(poolInitError ?? "no connection pool");
  }

  const client = await p.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a single explicit READ WRITE transaction and commits it,
 * rolling back on any error. The READ WRITE mode is scoped to this one
 * transaction (it overrides the read-only session default without ever
 * clearing it), so a connection returned to the pool keeps its read-only
 * guard for every other caller.
 *
 * ONLY lib/funnel-writes.ts and lib/editor-writes.ts may use this. Do not
 * add other writers.
 */
export async function withWriteTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const p = getPool();
  if (!p) {
    throw new DatabaseUnavailableError(poolInitError ?? "no connection pool");
  }

  const client = await p.connect();
  try {
    await client.query("BEGIN TRANSACTION READ WRITE");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

export interface DatabaseHealth {
  ok: boolean;
  checkedAt: string;
}

/**
 * Liveness of the Postgres connection only. Never returns the underlying
 * error message to callers so misconfigured credentials or connection
 * details are never leaked to API responses or logs read by clients.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const checkedAt = new Date().toISOString();
  try {
    await withReadOnlyClient((client) => client.query("SELECT 1"));
    return { ok: true, checkedAt };
  } catch (err) {
    console.error("[db] health check failed:", err instanceof Error ? err.message : err);
    return { ok: false, checkedAt };
  }
}
