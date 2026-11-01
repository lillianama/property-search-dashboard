import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./browser-observation-writes', () => ({saveObservation:vi.fn(async () => ({matched:true,zpid:'123',changedFields:['status']}))}));
import { POST, OPTIONS } from '../app/api/browser-observations/route';
const id='abcdefghijklmnopabcdefghijklmnop';
const origin=`chrome-extension://${id}`;
const body=()=>JSON.stringify({zpid:'123',captureId:'11111111-1111-4111-8111-111111111111',url:'https://www.zillow.com/homedetails/123_zpid/',observedAt:new Date().toISOString(),status:'Active',price:500000});
function req(auth='Bearer secret', o=origin, payload=body()) { return new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:{origin:o,authorization:auth,'content-type':'application/json'},body:payload}); }
beforeEach(()=>{process.env.BROWSER_OBSERVATION_EXTENSION_ID=id;process.env.BROWSER_OBSERVATION_TOKEN='secret';});
describe('browser endpoint',()=>{
 it('requires both configured origin and bearer token',async()=>{expect((await POST(req('Bearer nope'))).status).toBe(401);expect((await POST(req('Bearer secret','https://evil.test'))).status).toBe(403);delete process.env.BROWSER_OBSERVATION_TOKEN;expect((await POST(req())).status).toBe(401);});
 it('rejects oversized and unknown fields, returns only acknowledgement',async()=>{expect((await POST(req('Bearer secret',origin,' '.repeat(256001)))).status).toBe(400);expect((await POST(req('Bearer secret',origin,JSON.stringify({...JSON.parse(body()),propertyId:'x'})))).status).toBe(400); const r=await POST(req());expect(await r.json()).toEqual({matched:true,zpid:'123',changedFields:['status']});});
 it('accepts the exact streaming cap and rejects one additional byte',async()=>{const {price,status,...identity}=JSON.parse(body());const payload=JSON.stringify({...identity,field:'description',value:'🔥'});const padded=payload+' '.repeat(256000-Buffer.byteLength(payload,'utf8'));expect(Buffer.byteLength(padded,'utf8')).toBe(256000);expect((await POST(req('Bearer secret',origin,padded))).status).toBe(200);expect(Buffer.byteLength(padded+' ','utf8')).toBe(256001);expect((await POST(req('Bearer secret',origin,padded+' '))).status).toBe(400);});
 it('only grants CORS to configured extension',async()=>{const r=await OPTIONS(new Request('https://dashboard.test',{headers:{origin}}));expect(r.headers.get('access-control-allow-origin')).toBe(origin);expect((await OPTIONS(new Request('https://dashboard.test',{headers:{origin:'https://evil.test'}}))).status).toBe(403);});
});
