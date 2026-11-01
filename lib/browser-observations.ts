import { timingSafeEqual } from 'node:crypto';

export type IdentityEvidence = { parcelId: string; mlsNumber: string; legacyUrl?: string } | { legacyUrl: string; parcelId?: string; mlsNumber?: string };
export type LegacyObservation = { identity?: IdentityEvidence; zpid: string; url: string; captureId: string; observedAt: string; price?: number; status?: 'Active' | 'Pending' };
export type FieldObservation = { identity?: IdentityEvidence; zpid: string; url: string; captureId: string; observedAt: string; field: string; value: unknown };
export type Observation = LegacyObservation | FieldObservation;
const numeric: Record<string, [number, number, boolean]> = {
  bedrooms:[0,100,false], bathrooms:[0,100,false], finished_sqft:[1,10000000,true], structure_sqft:[1,10000000,true], year_built:[1600,2100,true], lot_sqft:[1,1000000000,false], latitude:[-90,90,false], longitude:[-180,180,false], annual_property_tax:[0.01,1000000000,false], annual_property_tax_year:[1900,2100,true], zestimate:[1,1000000000,true], rent_zestimate:[1,10000000,true], monthly_hoa_fee:[0,10000000,false], stories:[0.5,200,false], unit_count:[1,10000,true], days_on_market:[0,100000,true], published_assessed_value:[1,1000000000,false], published_annual_tax_amount:[0.01,1000000000,false],
};
const texts = new Set(['property_type','description','mls_number','basement','laundry','windows','foundation','architectural_style','patio_porch','view','sewer','water','gas','listing_terms','has_hoa','new_construction','has_view','room_types','date_on_market']);
const arrays = new Set(['parking_features','interior_features','exterior_features','appliances','property_subtype','heating','cooling','roof','flooring']);
function validField(field: unknown, value: unknown): boolean {
  if (typeof field !== 'string') return false;
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
  if (field === 'mls_number') return typeof value==='string' && /^[A-Za-z0-9-]{1,40}$/.test(value);
  if (field === 'parcel_id') return typeof value==='string' && /^[A-Za-z0-9-]{1,40}$/.test(value);
  if (field === 'tax_history') return !!obj && Object.keys(obj).every(k=>['year','taxPaid','assessedValue'].includes(k)) && Number.isInteger(obj.year) && (obj.year as number)>=1900 && (obj.year as number)<=2100 && typeof obj.taxPaid==='number' && Number.isFinite(obj.taxPaid) && obj.taxPaid>0 && obj.taxPaid<=1000000000 && (obj.assessedValue===undefined || (typeof obj.assessedValue==='number' && Number.isFinite(obj.assessedValue) && obj.assessedValue>0 && obj.assessedValue<=1000000000));
  if (field === 'listing_history') {
    if (!obj || Object.keys(obj).some(k=>!['date','event','price','source','mlsNumber','kind'].includes(k)) || typeof obj.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(obj.date) || (!Number.isFinite(Date.parse(obj.date)) || new Date(obj.date).toISOString().slice(0,10)!==obj.date) || typeof obj.event !== 'string' || !obj.event.trim() || Buffer.byteLength(obj.event)>200 || !['sale','rental'].includes(obj.kind as string) || ['source','mlsNumber'].some(k=>obj[k]!==undefined && (typeof obj[k]!=='string' || !(obj[k] as string).trim() || Buffer.byteLength(obj[k] as string)>200))) return false;
    if (!/^(?:Pending sale|Price change|Listed for sale|Listing removed|Listed for rent|Sold|Rented|Relisted|Contingent|Listing pending)$/i.test(obj.event as string) || (obj.source !== undefined && !/^(?:RMLS(?: \(OR\))?|Zillow)$/i.test(obj.source as string)) || (obj.mlsNumber !== undefined && !/^[A-Za-z0-9-]{1,40}$/.test(obj.mlsNumber as string))) return false;
    if ((/^(?:Listed for rent|Rented)$/i.test(obj.event as string) && obj.kind !== 'rental') || (/^(?:Listed for sale|Pending sale|Sold)$/i.test(obj.event as string) && obj.kind !== 'sale')) return false;
    return (obj.price===undefined || (Number.isSafeInteger(obj.price) && (obj.price as number)>=1 && (obj.price as number)<=1000000000));
  }
  if (field === 'published_room') {
    if (!obj || Object.keys(obj).some(k=>!['roomType','roomLabel','level','widthFt','lengthFt','areaSqft'].includes(k)) || !['bedroom','bathroom','kitchen','living_room','dining_room','other'].includes(obj.roomType as string)) return false;
    if (!['widthFt','lengthFt','areaSqft','level'].some(k=>obj[k]!==undefined)) return false;
    return ['roomLabel','level'].every(k=>obj[k]===undefined || (typeof obj[k]==='string' && (obj[k] as string).trim().length>0 && Buffer.byteLength(obj[k] as string)<=120)) && ['widthFt','lengthFt','areaSqft'].every(k=>obj[k]===undefined || (typeof obj[k]==='number' && Number.isFinite(obj[k]) && (obj[k] as number)>0 && (obj[k] as number)<=(k==='areaSqft'?100000:1000)));
  }
  if (field === 'unit_mix') return Array.isArray(value) && value.length>=1 && value.length<=20 && value.every(unit=> {
    if (!unit || typeof unit!=='object' || Array.isArray(unit)) return false; const u=unit as Record<string,unknown>;
    return Object.keys(u).length>0 && Object.keys(u).every(k=>['bedrooms','bathrooms','sqft','occupancy','actualRent','expectedMonthlyRent'].includes(k)) && Object.entries(u).every(([k,v])=>k==='occupancy'? v==='occupied'||v==='vacant' : typeof v==='number' && Number.isFinite(v) && v>=0 && v<=10000000);
  });
  if (field === 'listing') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    if (v.status === 'Active' || v.status === 'Pending') return Object.keys(v).length === 2 && Number.isSafeInteger(v.price) && (v.price as number) >= 1 && (v.price as number) <= 1000000000;
    return Object.keys(v).length === 1 && ['Sold','Off market','For rent'].includes(v.status as string);
  }
  if (field === 'annual_property_tax' && value && typeof value === 'object' && !Array.isArray(value)) {
    const v=value as Record<string,unknown>;
    return Object.keys(v).length === 2 && typeof v.amount === 'number' && Number.isFinite(v.amount) && v.amount > 0 && v.amount <= 1000000000 && Number.isInteger(v.year) && (v.year as number) >= 1900 && (v.year as number) <= 2100;
  }
  if (numeric[field]) { const [min,max,integer] = numeric[field]; return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isSafeInteger(value)); }
  if (texts.has(field)) return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= (field === 'description' ? 50000 : 500);
  if (arrays.has(field)) return Array.isArray(value) && value.length > 0 && value.length <= 30 && value.every(v => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= 200);
  if (field === 'photo_url') return typeof value === 'string' && value.length <= 2048 && /^https:\/\/(?:[a-z0-9-]+\.)*zillowstatic\.com\/[^\s?#]*$/i.test(value);
  return false;
}
export function validToken(header: string | null, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function parseObservation(value: unknown, now = Date.now()): Observation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const v2 = Object.hasOwn(o, 'field');
  if (Object.keys(o).some(k => !(v2 ? ['zpid','url','captureId','observedAt','field','value','identity'] : ['zpid','url','captureId','observedAt','price','status','identity']).includes(k)) || Object.keys(o).length !== (Object.hasOwn(o, 'identity') ? 7 : 6)) return null;
  if (Object.hasOwn(o, 'identity')) {
    const e = o.identity as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(k=>!['parcelId','mlsNumber','legacyUrl'].includes(k))) return null;
    if (e.legacyUrl === undefined) {
      if (Object.keys(e).length !== 2) return null;
    } else if (typeof e.legacyUrl !== 'string' || !/^https:\/\/www\.zillow\.com\/homes\/[0-9][A-Za-z0-9-]{4,200}-[A-Z]{2}-[0-9]{5}_rb\/$/.test(e.legacyUrl)) return null;
    if (!['parcelId','mlsNumber'].every(k => (e.legacyUrl !== undefined && e[k] === undefined)
      || (typeof e[k] === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(e[k] as string)))) return null;
  }
  if (typeof o.zpid !== 'string' || !/^[1-9]\d{0,19}$/.test(o.zpid) || typeof o.url !== 'string' || o.url !== `https://www.zillow.com/homedetails/${o.zpid}_zpid/`) return null;
  if (typeof o.captureId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(o.captureId)) return null;
  if (typeof o.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(o.observedAt)) return null;
  const t = Date.parse(o.observedAt); if (!Number.isFinite(t) || new Date(t).toISOString() !== o.observedAt || t > now + 300000 || t < now - 86400000) return null;
  if (v2) return validField(o.field,o.value) ? o as FieldObservation : null;
  if (o.price !== undefined && (!Number.isSafeInteger(o.price) || (o.price as number) < 1 || (o.price as number) > 1000000000)) return null;
  if (o.status !== undefined && !['Active','Pending'].includes(o.status as string)) return null;
  if (o.price === undefined || o.status === undefined) return null;
  // A price is an asking price only on a currently for-sale listing.
  if (o.price !== undefined && o.status !== 'Active' && o.status !== 'Pending') return null;
  return o as LegacyObservation;
}
