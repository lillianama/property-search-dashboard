import { Pool } from 'pg';
import type { Observation } from './browser-observations';
let pool: Pool | undefined;
export async function closeBrowserObservationPool() { const active = pool; pool = undefined; await active?.end(); }
export async function saveObservation(o: Observation) {
  if (!process.env.BROWSER_OBSERVATION_DATABASE_URL) throw new Error('unavailable');
  if (!pool) {
    pool = new Pool({ connectionString: process.env.BROWSER_OBSERVATION_DATABASE_URL, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000, idleTimeoutMillis: 30000 });
    pool.on('error', () => { console.error('[browser-observations] idle database connection error'); });
  }
  const result = await pool.query<{ result: { matched: boolean; zpid?: string; changedFields: string[] } }>(
    'SELECT public.save_browser_observation($1::jsonb) AS result', [JSON.stringify(o)]);
  return result.rows[0].result;
}
