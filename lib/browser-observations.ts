import { timingSafeEqual } from 'node:crypto';

export type Observation = { zpid: string; url: string; captureId: string; observedAt: string; price?: number; status?: 'Active' | 'Pending' };
export function validToken(header: string | null, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function parseObservation(value: unknown, now = Date.now()): Observation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some(k => !['zpid','url','captureId','observedAt','price','status'].includes(k))) return null;
  if (typeof o.zpid !== 'string' || !/^[1-9]\d{0,19}$/.test(o.zpid) || typeof o.url !== 'string' || o.url !== `https://www.zillow.com/homedetails/${o.zpid}_zpid/`) return null;
  if (typeof o.captureId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(o.captureId)) return null;
  if (typeof o.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.observedAt)) return null;
  const t = Date.parse(o.observedAt); if (!Number.isFinite(t) || new Date(t).toISOString() !== o.observedAt || t > now + 300000 || t < now - 86400000) return null;
  if (o.price !== undefined && (!Number.isSafeInteger(o.price) || (o.price as number) < 1 || (o.price as number) > 1000000000)) return null;
  if (o.status !== undefined && !['Active','Pending'].includes(o.status as string)) return null;
  if (o.price === undefined || o.status === undefined) return null;
  // A price is an asking price only on a currently for-sale listing.
  if (o.price !== undefined && o.status !== 'Active' && o.status !== 'Pending') return null;
  return o as Observation;
}
