import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { GET, POST } from '../app/api/editor/[id]/route';
import { fetchHouses } from './queries';
import { saveObservation, closeBrowserObservationPool } from './browser-observation-writes';
import { effectivePurchasePrice } from './purchase-price';
import { computePiti, DEFAULT_PITI_ASSUMPTIONS } from './piti';
const NO_FILTERS = { maxPrice:null, minBedrooms:null, maxYearBuilt:null, dateFrom:null, dateTo:null, statuses:[] }; 

const integration = process.env.PURCHASE_PRICE_PG_TEST === '1' ? describe : describe.skip;
integration('purchase setting with real restricted PostgreSQL and browser ingestion', () => {
  let admin: Pool, server: Server;
  const sockets = new Set<Socket>();
  const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
  beforeAll(async () => {
    // The bridge reaches ONLY this disposable test container, never the user's DB.
    server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const child=spawn('docker',['exec','-i','purchase-price-test-pg','nc','127.0.0.1','5432'],{stdio:['pipe','pipe','ignore']});socket.pipe(child.stdin);child.stdout.pipe(socket);socket.on('close',()=>child.kill());child.on('close',()=>socket.destroy());});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const port=(server.address() as {port:number}).port;
    const url=`postgresql://postgres@127.0.0.1:${port}/postgres`;
    admin=new Pool({connectionString:url});
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC; DROP ROLE IF EXISTS real_estate_dashboard; DROP ROLE IF EXISTS browser_observation_writer');
    await admin.query(readFileSync(new URL('../scripts/schema/property-store-schema.sql',import.meta.url),'utf8'));
    await admin.query("CREATE ROLE real_estate_dashboard LOGIN; CREATE ROLE browser_observation_writer LOGIN");
    for(const file of ['editor-schema.sql','rank-prefs-schema.sql','purchase-price-schema.sql','browser-observation-schema.sql']) await admin.query(readFileSync(new URL('../scripts/'+file,import.meta.url),'utf8'));
    await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO real_estate_dashboard; GRANT INSERT ON property_editor_notes,property_editor_judgments TO real_estate_dashboard; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO real_estate_dashboard; GRANT UPDATE(id) ON property_records TO real_estate_dashboard');
    process.env.DATABASE_URL=url.replace('postgres@','real_estate_dashboard@');
    process.env.BROWSER_OBSERVATION_DATABASE_URL=url.replace('postgres@','browser_observation_writer@');
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,track) VALUES ($1,'Purchase fixture A','purchase fixture a','house'),($2,'Purchase fixture B','purchase fixture b','house')",[a,b]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'zillow_url','https://www.zillow.com/homedetails/123_zpid/')",[a]);
    await admin.query("INSERT INTO property_listing_events(property_id,event_type,event_date,price,status,source) VALUES ($1,'listed',current_date,500000,'Active','fixture'),($2,'listed',current_date,600000,'Active','fixture')",[a,b]);
    // A private raw payload must never appear in the editor JSON.
    await admin.query("INSERT INTO property_source_snapshots(property_id,source,payload) VALUES ($1,'fixture',$2::jsonb)",[a,JSON.stringify({secret:'PRIVATE-RAW-SENTINEL'})]);
  });
  afterAll(async()=>{await closeBrowserObservationPool();await admin?.end();for(const s of sockets)s.destroy();server?.close();});
  async function post(body:unknown,id=a) {
    return POST(new NextRequest(`http://dashboard.test/api/editor/${id}`,{method:'POST',headers:{origin:'http://dashboard.test',host:'dashboard.test','content-type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({id})});
  }
  async function get(id=a) {const res=await GET(new NextRequest(`http://dashboard.test/api/editor/${id}`),{params:Promise.resolve({id})});expect(res.status).toBe(200);return res.json();}
  it('saves, reloads, isolates, accepts concurrent source updates, then clears to the latest market price without invented events',async()=>{
    expect((await post({purchasePriceOverride:-1})).status).toBe(400);
    const count=async()=>Number((await admin.query('SELECT count(*) FROM property_listing_events')).rows[0].count);
    const before=await count();
    expect((await post({purchasePriceOverride:490000})).status).toBe(200);
    expect((await get()).notes).toMatchObject({purchasePriceOverride:490000,marketPrice:500000});
    expect((await get(b)).notes.purchasePriceOverride).toBeNull();
    expect(await count()).toBe(before);
    const [observed,noteSave]=await Promise.all([
      saveObservation({zpid:'123',url:'https://www.zillow.com/homedetails/123_zpid/',captureId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',observedAt:new Date().toISOString(),status:'Active',price:480000}),
      post({remarks:'Separate user note'})
    ]);
    expect(observed.matched).toBe(true);expect(noteSave.status).toBe(200);
    const loaded=await get();expect(loaded.notes).toMatchObject({purchasePriceOverride:490000,marketPrice:480000});
    expect(JSON.stringify(loaded)).not.toContain('PRIVATE-RAW-SENTINEL');
    expect(Object.keys(loaded.notes).sort()).toEqual(['cons','judgments','marketPrice','pros','purchasePriceOverride','remarks']);
    let property=(await fetchHouses(NO_FILTERS)).find(p=>p.id===a)!;
    expect(property.latestPrice).toBe(480000);expect(effectivePurchasePrice(property)).toBe(490000);
    expect(computePiti({price:effectivePurchasePrice(property),actualAnnualTax:3600},DEFAULT_PITI_ASSUMPTIONS)).toMatchObject({downPaymentAmount:24500,loanAmount:465500});
    const marketEvents=await count();expect(marketEvents).toBe(before+1);
    const cleared=await post({purchasePriceOverride:null});expect(cleared.status).toBe(200);
    expect((await cleared.json()).notes).toMatchObject({purchasePriceOverride:null,marketPrice:480000});
    expect(await count()).toBe(marketEvents);
    property=(await fetchHouses(NO_FILTERS)).find(p=>p.id===a)!;
    expect(effectivePurchasePrice(property)).toBe(480000);
    expect((await get(b)).notes.purchasePriceOverride).toBeNull();
    const privileges=(await admin.query("SELECT has_table_privilege('browser_observation_writer','property_purchase_price_settings','SELECT') AS read, has_table_privilege('browser_observation_writer','property_purchase_price_settings','INSERT') AS write, has_table_privilege('real_estate_dashboard','property_purchase_price_settings','UPDATE') AS update, has_table_privilege('real_estate_dashboard','property_purchase_price_settings','DELETE') AS delete")).rows[0];
    expect(privileges).toEqual({read:false,write:false,update:false,delete:false});
  });
});
