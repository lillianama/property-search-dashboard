import { describe, it, expect } from 'vitest';
import { parseObservation, validToken, fingerprint } from './browser-observations';
const now = Date.now();
const valid = {zpid:'123',url:'https://www.zillow.com/homedetails/123_zpid/',observedAt:new Date(now).toISOString(),status:'Active',price:500000};
describe('browser observations', () => {
  it('fails closed and checks bearer tokens', () => { expect(validToken('Bearer abc',undefined)).toBe(false); expect(validToken('Bearer ab','abc')).toBe(false); expect(validToken('Bearer abc','abc')).toBe(true); });
  it('validates identity, timestamps, fields and asking price context', () => {
    expect(parseObservation(valid,now)).not.toBeNull();
    for (const change of [{zpid:'124'}, {price:1.5}, {status:'Sold'}, {observedAt:new Date(now-90000000).toISOString()}, {propertyId:'private'}, {url:'https://evil.test/123'}]) expect(parseObservation({...valid,...change},now)).toBeNull();
  });
  it('uses semantic identity independent of capture time', () => { const a=parseObservation(valid,now)!; expect(fingerprint(a)).toBe(fingerprint({...a,observedAt:new Date(now-1000).toISOString()})); expect(fingerprint(a)).not.toBe(fingerprint({...a,price:1})); });
});
