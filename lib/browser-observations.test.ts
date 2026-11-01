import { describe, it, expect } from 'vitest';
import { parseObservation, validToken } from './browser-observations';
const now = Date.now();
const valid = {zpid:'123',captureId:'11111111-1111-4111-8111-111111111111',url:'https://www.zillow.com/homedetails/123_zpid/',observedAt:new Date(now).toISOString(),status:'Active',price:500000};
describe('browser observations', () => {
  it('fails closed and checks bearer tokens', () => { expect(validToken('Bearer abc',undefined)).toBe(false); expect(validToken('Bearer ab','abc')).toBe(false); expect(validToken('Bearer abc','abc')).toBe(true); });
  it('validates identity, timestamps, fields and asking price context', () => {
    expect(parseObservation(valid,now)).not.toBeNull();
    for (const change of [{zpid:'124'}, {price:1.5}, {observedAt:'2026-02-30T00:00:00.000Z'}, {status:'Sold'}, {status:'Off market'}, {price:undefined}, {status:undefined}, {captureId:'bad'}, {observedAt:new Date(now+301000).toISOString()}, {observedAt:new Date(now-90000000).toISOString()}, {propertyId:'private'}, {url:'https://evil.test/123'}]) expect(parseObservation({...valid,...change},now)).toBeNull();
  });
  it('accepts v2 bounded field payloads and rejects misleading or unsafe values', () => {
    const {price,status,...identity}=valid;
    const v2={...identity,field:'listing',value:{status:'Sold'}};
    expect(parseObservation(v2,now)).not.toBeNull();
    for (const bad of [{field:'listing',value:{status:'Sold',price:400000}},{field:'listing',value:{status:'Active'}},{field:'annual_property_tax',value:0},{field:'photo_url',value:'https://evil.test/x.jpg'},{field:'description',value:'x'.repeat(50001)},{field:'annual_property_tax_year',value:1800},{field:'unknown',value:3}]) expect(parseObservation({...v2,...bad},now)).toBeNull();
    expect(parseObservation({...v2,field:'photo_url',value:'https://photos.zillowstatic.com/fp/a.jpg'},now)).not.toBeNull();
    expect(parseObservation({...v2,field:'annual_property_tax_year',value:2025},now)).not.toBeNull();
    expect(parseObservation({...v2,field:'description',value:'x'.repeat(50000)},now)).not.toBeNull();
    expect(parseObservation({...v2,field:'heating',value:Array(30).fill('x'.repeat(200))},now)).not.toBeNull();
    expect(parseObservation({...v2,field:'heating',value:Array(31).fill('x')},now)).toBeNull();
  });
  it('accepts bounded exact evidence while keeping legacy payloads valid', () => {
    const identity={parcelId:'R295041',mlsNumber:'262014608'};
    expect(parseObservation({...valid,identity},now)).not.toBeNull();
    expect(parseObservation(valid,now)).not.toBeNull();
    for (const bad of [null,[],{}, {parcelId:'R295041'}, {...identity,extra:'no'}, {...identity,parcelId:'bad#'}, {...identity,mlsNumber:42}]) expect(parseObservation({...valid,identity:bad},now)).toBeNull();
  });
  it('rejects normalized invalid calendar dates even within the age window', () => { const supplied='2026-02-30T12:00:00.000Z'; expect(parseObservation({...valid,observedAt:supplied}, Date.parse(supplied))).toBeNull(); });
});
