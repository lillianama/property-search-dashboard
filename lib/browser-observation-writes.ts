import { Pool } from 'pg';
import { captureFingerprint, fingerprint, type Observation } from './browser-observations';
let pool: Pool | undefined;
export async function saveObservation(o: Observation) {
  if (!process.env.BROWSER_OBSERVATION_DATABASE_URL) throw new Error('unavailable');
  pool ??= new Pool({ connectionString: process.env.BROWSER_OBSERVATION_DATABASE_URL, max: 3 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['zillow:' + o.zpid]);
    const match = await c.query<{property_id:string}>(`SELECT DISTINCT property_id FROM property_identifiers WHERE (kind IN ('zpid','zillow_zpid') AND value = $1) OR (kind = 'zillow_url' AND value ~ $2) LIMIT 2`, [o.zpid, '^https://(www\\.)?zillow\\.com/homedetails/([^/?#]+/)?'+o.zpid+'_zpid/?([?#].*)?$']);
    if (match.rows.length !== 1) { await c.query('COMMIT'); return { matched: false, changedFields: [] }; }
    const id = match.rows[0].property_id;
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['property:' + id]);
    const hash = fingerprint(o);
    const captureHash = captureFingerprint(o);
    const prior = await c.query('SELECT 1 FROM browser_observation_history WHERE property_id=$1 AND capture_hash=$2 UNION ALL SELECT 1 FROM (SELECT content_hash FROM browser_observation_history WHERE property_id=$1 ORDER BY id DESC LIMIT 1) latest WHERE content_hash=$3 LIMIT 1', [id,captureHash,hash]);
    if (prior.rowCount) { await c.query('COMMIT'); return { matched: true, zpid:o.zpid, changedFields: [] }; }
    const current = await c.query<{latest_price:number|null;latest_status:string|null;latest_status_observed_at:Date|null}>('SELECT latest_price, latest_status, latest_status_observed_at FROM property_current WHERE id=$1', [id]);
    const row = current.rows[0];
    await c.query('INSERT INTO browser_observation_history (property_id,zpid,source_url,observed_at,content_hash,capture_hash,price,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id,o.zpid,o.url,o.observedAt,hash,captureHash,o.price ?? null,o.status ?? null]);
    await c.query(`INSERT INTO property_listing_events (property_id,event_type,price,status,source,source_ref,observed_at) VALUES ($1,'browser_observation',$2,$3,'zillow-browser',$4,$5)`, [id,o.price ?? null,o.status ?? null,o.url,o.observedAt]);
    const updated = await c.query<{latest_price:number|null;latest_status:string|null}>('SELECT latest_price, latest_status FROM property_current WHERE id=$1', [id]);
    const changedFields: string[] = [];
    if (row.latest_price !== updated.rows[0].latest_price) changedFields.push('price');
    if (row.latest_status !== updated.rows[0].latest_status) changedFields.push('status');
    await c.query('COMMIT'); return { matched: true, zpid:o.zpid, changedFields };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
