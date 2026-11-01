import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { saveObservation, closeBrowserObservationPool } from './browser-observation-writes';
import type { Observation } from './browser-observations';
import { fetchActualTaxRows } from './queries';
import { selectActualAnnualTaxes } from './tax';
import { POST } from '../app/api/browser-observations/route';
import { GET as dashboardGET } from '../app/api/dashboard/route';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

// Explicit opt-in: this bridge targets only the dedicated disposable test container.
const integration = process.env.BROWSER_OBSERVATION_PG_TEST === '1' ? describe : describe.skip;
integration('real PostgreSQL observation transaction', () => {
  let server: Server, admin: Pool;
  const sockets = new Set<Socket>();
  const property = '11111111-1111-4111-8111-111111111111';
  const base: Observation = {zpid:'123',url:'https://www.zillow.com/homedetails/123_zpid/',captureId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',observedAt:new Date(Date.now()-10000).toISOString(),status:'Active',price:500000};
  beforeAll(async () => {
    server = createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      const child = spawn('docker',['exec','-i','property-browser-api-test-pg','nc','127.0.0.1','5432'],{stdio:['pipe','pipe','ignore']});
      socket.pipe(child.stdin); child.stdout.pipe(socket); socket.on('close',()=>child.kill()); child.on('close',()=>socket.destroy());
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    const url=`postgresql://postgres@127.0.0.1:${port}/postgres`;
    process.env.DATABASE_URL=url;
    admin = new Pool({connectionString:url});
    process.env.BROWSER_OBSERVATION_DATABASE_URL=`postgresql://browser_observation_writer@127.0.0.1:${port}/postgres`;
    await admin.query(readFileSync(new URL('../../scripts/property-store-schema.sql', import.meta.url),'utf8'));
    await admin.query(readFileSync(new URL('../scripts/editor-schema.sql', import.meta.url),'utf8'));
    await admin.query(readFileSync(new URL('../scripts/rank-prefs-schema.sql', import.meta.url),'utf8'));
    await admin.query(`DO $$ BEGIN CREATE ROLE browser_observation_writer LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await admin.query('DROP FUNCTION IF EXISTS public.save_browser_observation(jsonb)');
    await admin.query('DROP TABLE IF EXISTS public.browser_observation_history');
    await admin.query(readFileSync(new URL('../scripts/browser-observation-schema.sql', import.meta.url),'utf8'));

    await admin.query('DROP TRIGGER IF EXISTS reject_test_event ON property_listing_events');
    await admin.query('DROP FUNCTION IF EXISTS reject_test_event()');
    await admin.query('TRUNCATE property_records CASCADE');
    await admin.query(`INSERT INTO property_records(id,canonical_address,normalized_address) VALUES ($1,'fixture','fixture')`,[property]);
    await admin.query(`INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'zillow_url','https://www.zillow.com/homedetails/example/123_zpid/')`,[property]);
    await admin.query(`INSERT INTO property_listing_events(property_id,event_type,event_date,price,status,source,observed_at) VALUES ($1,'sold',current_date - 100,300000,'Sold','fixture',now())`,[property]);
    await admin.query(`INSERT INTO property_editor_judgments(property_id,field,verdict) VALUES ($1,'drum_space','no')`,[property]);
    await admin.query(`INSERT INTO property_funnel_ranks(property_id,rank_key) VALUES ($1,'b')`,[property]);
    await admin.query(`INSERT INTO property_collections(property_id,collection,track) VALUES ($1,'rejected','house')`,[property]);
    await admin.query(`INSERT INTO property_editor_notes(property_id,field,value) VALUES ($1,'remarks','keep')`,[property]);
  });
  afterAll(async()=>{ await closeBrowserObservationPool(); await admin?.end(); for (const socket of sockets) socket.destroy(); server?.close(); });
  it('binds legacy records only with two agreeing exact anchors and rejects conflicts without writes', async()=>{
    const id=randomUUID(), other=randomUUID();
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address) VALUES ($1,'legacy exact','legacy exact'),($2,'other exact','other exact')",[id,other]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'parcel','R295041'),($1,'mls','262014608'),($1,'zillow_url','https://www.zillow.com/homes/5218-NE-18TH-AVE-Portland-OR_rb/'),($2,'parcel','R999'),($2,'mls','999')",[id,other]);
    const payload={zpid:'53976377',url:'https://www.zillow.com/homedetails/53976377_zpid/',captureId:randomUUID(),observedAt:new Date().toISOString(),field:'bedrooms',value:2};
    const identity={parcelId:'R295041',mlsNumber:'262014608'};
    const unmatched={matched:false,changedFields:[]};
    expect(await saveObservation(payload)).toEqual(unmatched);
    for (const e of [{...identity,mlsNumber:'999'},{...identity,parcelId:'R999'},{...identity,mlsNumber:'unknown'},{parcelId:'absent',mlsNumber:'absent'}]) expect(await saveObservation({...payload,captureId:randomUUID(),identity:e})).toEqual(unmatched);
    // Alias ambiguity and a pre-existing contradictory zpid must never bind.
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'mls_number','262014608')",[other]);
    expect(await saveObservation({...payload,identity})).toEqual(unmatched);
    await admin.query("DELETE FROM property_identifiers WHERE kind='mls_number' AND value='262014608'");
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'zillow_zpid','42')",[id]);
    expect(await saveObservation({...payload,identity})).toEqual(unmatched);
    await admin.query("DELETE FROM property_identifiers WHERE kind='zillow_zpid' AND value='42'");
    const saved=await saveObservation({...payload,identity});
    expect(saved).toEqual({matched:true,zpid:payload.zpid,changedFields:['bedrooms']});
    expect(await saveObservation({...payload,identity})).toEqual(saved);
    expect((await admin.query("SELECT property_id FROM property_identifiers WHERE kind='zpid' AND value='53976377'")).rows).toEqual([{property_id:id}]);
    expect((await saveObservation({...payload,captureId:randomUUID()})).matched).toBe(true);
    expect(await saveObservation({...payload,captureId:randomUUID(),identity:{...identity,parcelId:'R999'}})).toEqual(unmatched);
    const conflict={...payload,zpid:'777777',url:'https://www.zillow.com/homedetails/777777_zpid/',captureId:randomUUID(),identity};
    expect(await saveObservation(conflict)).toEqual(unmatched);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'zillow_zpid','53976377')",[other]);
    expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual(unmatched);
    await admin.query("DELETE FROM property_identifiers WHERE kind='zillow_zpid' AND value='53976377'");
    // v1 uses the same resolver, including legacy alias kinds.
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'parcel_id','R2'),($1,'mls_number','M2')",[other]);
    expect((await saveObservation({...base,zpid:'888888',url:'https://www.zillow.com/homedetails/888888_zpid/',captureId:randomUUID(),identity:{parcelId:'R2',mlsNumber:'M2'}})).matched).toBe(false); // contradictory existing parcel/MLS
    await admin.query("DELETE FROM property_identifiers WHERE property_id=$1 AND kind IN ('parcel','mls')",[other]);
    expect((await saveObservation({...base,zpid:'888888',url:'https://www.zillow.com/homedetails/888888_zpid/',captureId:randomUUID(),identity:{parcelId:'R2',mlsNumber:'M2'}})).matched).toBe(true);
    for (const identity of [null,{}, {parcelId:'R2'}, {parcelId:'R2',mlsNumber:'M2',extra:'x'}]) await expect(saveObservation({...payload,captureId:randomUUID(),identity} as unknown as Observation)).rejects.toThrow('invalid identity');
    expect(Number((await admin.query('SELECT count(*) n FROM property_records')).rows[0].n)).toBe(3);
    expect((await admin.query("SELECT count(*)::int n FROM browser_observation_field_history WHERE zpid='777777'")).rows[0].n).toBe(0);
    await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=ANY($1::uuid[])',[[id,other]]);
    await admin.query('DELETE FROM browser_observation_history WHERE property_id=ANY($1::uuid[])',[[id,other]]);
    await admin.query('DELETE FROM property_records WHERE id=ANY($1::uuid[])',[[id,other]]);
  });
  it('matches 3158 through its stored detail URL with historical MLS aliases and the record parcel', async()=>{
    const id=randomUUID(), other=randomUUID(), zpid='53874198';
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,parcel_id) VALUES($1,'3158 NE 78 Avenue, Portland, OR 97213','3158 NE 78 AVENUE','R173927'),($2,'unrelated','unrelated',NULL)",[id,other]);
    const detail='https://www.zillow.com/homedetails/3158-NE-78th-Ave-Portland-OR-97213/53874198_zpid/';
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2),($1,'mls','577269814'),($1,'mls_number','294356768')",[id,detail]);
    await admin.query("INSERT INTO property_listing_events(property_id,event_type,price,status,source) VALUES($1,'listing',429999,'Active','fixture')",[id]);
    const before=(await admin.query('SELECT * FROM property_identifiers WHERE property_id=$1 ORDER BY kind',[id])).rows;
    const common={zpid,url:`https://www.zillow.com/homedetails/${zpid}_zpid/`,observedAt:new Date().toISOString()};
    const unmatched={matched:false,changedFields:[]};
    for (const identity of [undefined,{parcelId:'R173927',mlsNumber:'577269814'},{parcelId:'R173927',mlsNumber:'294356768'}]) {
      for (const fields of [{price:429999,status:'Active' as const}, {field:'listing',value:{price:429999,status:'Active'}}]) {
        const payload={...common,captureId:randomUUID(),...fields,...(identity?{identity}:{})};
        expect(await saveObservation(payload)).toEqual({matched:true,zpid,changedFields:[]});
      }
    }
    const payload={...common,captureId:randomUUID(),field:'listing',value:{price:429999,status:'Active'}};
    for (const identity of [{parcelId:'WRONG',mlsNumber:'294356768'},{parcelId:'R173927',mlsNumber:'UNKNOWN'}]) expect(await saveObservation({...payload,captureId:randomUUID(),identity})).toEqual(unmatched);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'MLS','294356768')",[other]);
    expect(await saveObservation({...payload,identity:{parcelId:'R173927',mlsNumber:'294356768'}})).toEqual(unmatched);
    await admin.query("DELETE FROM property_identifiers WHERE property_id=$1",[other]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'Listing_URL',$2)",[other,detail+'?alias=ambiguous']);
    expect(await saveObservation(payload)).toEqual(unmatched);
    await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[other]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow','999998')",[id]);
    expect(await saveObservation(payload)).toEqual(unmatched);
    await admin.query("DELETE FROM property_identifiers WHERE property_id=$1 AND kind='zillow'",[id]);
    expect((await admin.query('SELECT * FROM property_identifiers WHERE property_id=$1 ORDER BY kind',[id])).rows).toEqual(before);
    expect((await admin.query('SELECT DISTINCT price,status FROM property_listing_events WHERE property_id=$1',[id])).rows).toEqual([{price:429999,status:'Active'}]);
    await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);
    await admin.query('DELETE FROM browser_observation_history WHERE property_id=$1',[id]);
    await admin.query('DELETE FROM property_records WHERE id=ANY($1::uuid[])',[[id,other]]);
  });
  it('automatically matches legacy sources without relying on address spelling or manual identity repairs',async()=>{
    const id=randomUUID(), zpid='53874199';
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,parcel_id) VALUES($1,'3158 NE 78 AVE','legacy numeric spelling','R-LEGACY')",[id]);
    const payload={zpid,url:`https://www.zillow.com/homedetails/${zpid}_zpid/`,observedAt:new Date().toISOString(),field:'bedrooms',value:2};
    // Exact zpid-bearing source URLs work with no parcel or MLS request evidence.
    for (const kind of ['zillow_url','ZILLOW_URL','listing_url','zillow']) {
      await admin.query('INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,$2,$3)',[id,kind,`https://WWW.ZILLOW.COM/homedetails/3158-NE-78th-Avenue/${zpid}_zpid/?source=stored#details`]);
      expect((await saveObservation({...payload,captureId:randomUUID()})).matched).toBe(true);
      await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[id]);
    }
    for (const kind of ['zpid','ZILLOW_ZPID','zillow']) {
      await admin.query('INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,$2,$3)',[id,kind,zpid]);
      expect((await saveObservation({...payload,captureId:randomUUID()})).matched).toBe(true);
      await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[id]);
    }
    for (const url of [`https://www.zillow.com.evil.test/homedetails/${zpid}_zpid/`,`https://user@www.zillow.com/homedetails/${zpid}_zpid/`,`https://www.zillow.com/homedetails/${zpid}0_zpid/`,`https://www.zillow.com/homes/3158-NE-78TH-AVE_rb/`]) {
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2)",[id,url]);
      expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual({matched:false,changedFields:[]});
      await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[id]);
    }
    // An address-only URL cannot identify a zpid. Two independent exact stored
    // anchors can bind it automatically, including the schema's record parcel.
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url','https://www.zillow.com/homes/3158-NE-78TH-AVE_rb/'),($1,'MLS','M-LEGACY')",[id]);
    expect(await saveObservation({...payload,captureId:randomUUID(),identity:{parcelId:'R-LEGACY',mlsNumber:'M-LEGACY'}})).toMatchObject({matched:true,zpid});
    expect((await admin.query("SELECT property_id FROM property_identifiers WHERE kind='zpid' AND value=$1",[zpid])).rows).toEqual([{property_id:id}]);
    await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);
    await admin.query('DELETE FROM property_records WHERE id=$1',[id]);
  });
  it('projects current facts; retries, concurrent writes, stale evidence and rollback preserve invariants',async()=>{
    const a = await saveObservation(base);
    expect(a).toEqual({matched:true,zpid:'123',changedFields:['price','status']});
    expect(await saveObservation(base)).toEqual(a);
    const b={...base,captureId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',observedAt:new Date(Date.now()-5000).toISOString(),price:510000,status:'Pending' as const};
    expect((await saveObservation(b)).changedFields).toEqual(['price','status']);
    expect(await saveObservation({...base,observedAt:new Date().toISOString()})).toEqual(a);
    const stale={...base,captureId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',observedAt:new Date(Date.now()-20000).toISOString(),price:400000};
    expect((await saveObservation(stale)).changedFields).toEqual([]);
    const concurrent={...b,captureId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',observedAt:new Date().toISOString(),price:520000};
    const results=await Promise.all([saveObservation(concurrent),saveObservation(concurrent)]);
    expect(results).toEqual([{matched:true,zpid:'123',changedFields:['price']},{matched:true,zpid:'123',changedFields:['price']}]);
    expect(Number((await admin.query('SELECT count(*) AS n FROM browser_observation_history WHERE capture_id=$1',[concurrent.captureId])).rows[0].n)).toBe(1);
    const current=await admin.query('SELECT latest_price,latest_status FROM property_current WHERE id=$1',[property]);
    expect(current.rows[0]).toEqual({latest_price:520000,latest_status:'Pending'});
    expect((await admin.query('SELECT value FROM property_editor_notes WHERE property_id=$1',[property])).rows).toEqual([{value:'keep'}]);
    expect((await admin.query('SELECT field,verdict FROM property_editor_judgments WHERE property_id=$1',[property])).rows).toEqual([{field:'drum_space',verdict:'no'}]);
    expect((await admin.query('SELECT rank_key FROM property_funnel_ranks WHERE property_id=$1',[property])).rows).toEqual([{rank_key:'b'}]);
    expect((await admin.query('SELECT collection FROM property_collections WHERE property_id=$1',[property])).rows).toEqual([{collection:'rejected'}]);
    const future={...concurrent,captureId:'99999999-9999-4999-8999-999999999999',observedAt:new Date(Date.now()+240000).toISOString(),price:530000};
    expect((await saveObservation(future)).changedFields).toEqual(['price']);
    expect((await admin.query("SELECT observed_at <= now() AS safe FROM property_listing_events WHERE price=530000")).rows[0].safe).toBe(true);
    await admin.query('SELECT pg_sleep(0.01)');
    const newer={...concurrent,captureId:'88888888-8888-4888-8888-888888888888',observedAt:new Date().toISOString(),price:540000};
    expect((await saveObservation(newer)).changedFields).toEqual(['price']);
    await admin.query("INSERT INTO property_listing_events(property_id,event_type,price,status,source,observed_at) VALUES ($1,'listing',550000,'Active','other',now())",[property]);
    const late={...stale,captureId:'77777777-7777-4777-8777-777777777777',price:410000};
    expect((await saveObservation(late)).changedFields).toEqual([]);
    expect((await admin.query('SELECT latest_price,latest_status FROM property_current WHERE id=$1',[property])).rows[0]).toEqual({latest_price:550000,latest_status:'Active'});
    // Same browser content following another source must project again, even
    // though the last browser capture had identical facts.
    await admin.query('SELECT pg_sleep(0.01)');
    const fresh={...late,captureId:'66666666-6666-4666-8666-666666666666',observedAt:new Date().toISOString()};
    expect((await saveObservation(fresh)).changedFields).toEqual(['price']);
    await admin.query("INSERT INTO property_listing_events(property_id,event_type,price,status,source,observed_at) VALUES ($1,'listing',560000,'Pending','other',now())",[property]);
    await admin.query('SELECT pg_sleep(0.01)');
    const same={...fresh,captureId:'55555555-5555-4555-8555-555555555555',observedAt:new Date().toISOString()};
    expect((await saveObservation(same)).changedFields).toEqual(['price','status']);
    expect((await admin.query('SELECT latest_price,latest_status FROM property_current WHERE id=$1',[property])).rows[0]).toEqual({latest_price:410000,latest_status:'Active'});
    expect((await admin.query('SELECT changed_fields FROM browser_observation_history WHERE capture_id=$1',[late.captureId])).rows[0].changed_fields).toEqual([]);
    const countBefore=Number((await admin.query('SELECT count(*) AS n FROM browser_observation_history')).rows[0].n);
    await admin.query(`CREATE FUNCTION reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.price=999999 THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER reject_test_event BEFORE INSERT ON property_listing_events FOR EACH ROW EXECUTE FUNCTION reject_test_event()');
    await expect(saveObservation({...concurrent,captureId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',price:999999,observedAt:new Date(Date.now()+1000).toISOString()})).rejects.toThrow();
    expect(Number((await admin.query('SELECT count(*) AS n FROM browser_observation_history')).rows[0].n)).toBe(countBefore);
  });
  it('serializes distinct captures, replays each result and rolls back an event when auditing fails',async()=>{
    const id='33333333-3333-4333-8333-333333333333';
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address) VALUES ($1,'concurrent','concurrent')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'zpid','789'),($1,'zillow_zpid','789')",[id]);
    const older={...base,zpid:'789',url:'https://www.zillow.com/homedetails/789_zpid/',captureId:'11111111-1111-4111-8111-111111111111',observedAt:new Date(Date.now()-2000).toISOString(),price:600000};
    const newer={...older,captureId:'22222222-2222-4222-8222-222222222222',observedAt:new Date(Date.now()-1000).toISOString(),price:610000,status:'Pending' as const};
    const results=await Promise.all([saveObservation(newer),saveObservation(older)]);
    expect(await saveObservation(newer)).toEqual(results[0]);
    expect(await saveObservation(older)).toEqual(results[1]);
    expect((await admin.query('SELECT latest_price,latest_status FROM property_current WHERE id=$1',[id])).rows[0]).toEqual({latest_price:610000,latest_status:'Pending'});
    expect(Number((await admin.query('SELECT count(*) AS n FROM browser_observation_history WHERE property_id=$1',[id])).rows[0].n)).toBe(2);
    await admin.query(`CREATE OR REPLACE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit rollback'; END $$`);
    await admin.query('CREATE TRIGGER reject_test_audit BEFORE INSERT ON browser_observation_history FOR EACH ROW EXECUTE FUNCTION reject_test_audit()');
    const failed={...newer,captureId:'33333333-3333-4333-8333-333333333333',price:620000,observedAt:new Date().toISOString()};
    try { await expect(saveObservation(failed)).rejects.toThrow('test audit rollback'); }
    finally { await admin.query('DROP TRIGGER reject_test_audit ON browser_observation_history'); await admin.query('DROP FUNCTION reject_test_audit()'); }
    expect(Number((await admin.query('SELECT count(*) AS n FROM property_listing_events WHERE property_id=$1 AND price=620000',[id])).rows[0].n)).toBe(0);
    expect((await saveObservation(failed)).changedFields).toEqual(['price']);
  });
  it('validates at the privilege boundary and prevents caller-controlled provenance',async()=>{
    const restricted=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL});
    try {
      for (const change of [{price:0},{price:1.5},{price:1000000001},{price:null},{status:'Sold'}, {zpid:'123|456'}, {url:'https://evil.test/'}, {captureId:'bad'}, {observedAt:'2026-02-30T12:00:00.000Z'}, {observedAt:new Date(Date.now()-90000000).toISOString()}, {observedAt:new Date(Date.now()+301000).toISOString()}, {source:'forged'}, {status:null}, {observedAt:null}, {captureId:null}, {zpid:null}, {url:null}, {price:'500000'}]) {
        await expect(restricted.query('SELECT public.save_browser_observation($1::jsonb)',[JSON.stringify({...base,...change})])).rejects.toThrow();
      }
      expect((await admin.query("SELECT DISTINCT source,event_type,source_ref FROM property_listing_events WHERE source='zillow-browser' AND property_id=$1",[property])).rows).toEqual([{source:'zillow-browser',event_type:'browser_observation',source_ref:base.url}]);
      await admin.query(`DO $$ BEGIN CREATE ROLE browser_observation_unprivileged LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      const unprivileged=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL!.replace('browser_observation_writer@','browser_observation_unprivileged@')});
      try { await expect(unprivileged.query('SELECT public.save_browser_observation($1::jsonb)',[JSON.stringify(base)])).rejects.toThrow(/permission denied/); }
      finally { await unprivileged.end(); }
    } finally { await restricted.end(); }
  });
  it('validates v2 at SQL boundary, respects source precedence and preserves multiple photos', async()=>{
    const id='44444444-4444-4444-8444-444444444444';
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,track) VALUES ($1,'v2','v2','house')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES ($1,'zpid','987')",[id]);
    const base2={zpid:'987',url:'https://www.zillow.com/homedetails/987_zpid/',observedAt:new Date(Date.now()-1000).toISOString(),captureId:'12345678-1111-4111-8111-111111111111',field:'bedrooms',value:3};
    const a=await saveObservation(base2); expect(a.changedFields).toEqual(['bedrooms']);
    expect(await saveObservation(base2)).toEqual(a);
    await expect(saveObservation({...base2,value:4})).rejects.toThrow('capture conflict');
    await admin.query("INSERT INTO property_observations(property_id,field,value,source,observed_at,confidence) VALUES ($1,'bedrooms','4','rmls',now()-interval '10 seconds',0.9)",[id]);
    const high={...base2,captureId:'12345678-2222-4222-8222-222222222222',value:5};
    expect((await saveObservation(high)).changedFields).toEqual([]);
    const p1={...base2,field:'photo_url',value:'https://photos.zillowstatic.com/fp/a.jpg',captureId:'12345678-3333-4333-8333-333333333333'};
    const p2={...p1,value:'https://photos.zillowstatic.com/fp/b.jpg',captureId:'12345678-4444-4444-8444-444444444444'};
    expect((await saveObservation(p1)).changedFields).toEqual(['photo_url']);
    expect((await saveObservation(p2)).changedFields).toEqual(['photo_url']);
    expect((await admin.query("SELECT raw->>'photoUrl' AS photo FROM property_observations WHERE property_id=$1 AND field='photo_url' ORDER BY photo",[id])).rows).toEqual([{photo:p1.value},{photo:p2.value}]);
    const sold={...base2,captureId:'12345678-5555-4555-8555-555555555555',field:'listing',value:{status:'Sold'}};
    expect((await saveObservation(sold)).changedFields).toEqual(['status']);
    expect((await admin.query("SELECT price,status FROM property_listing_events WHERE property_id=$1",[id])).rows).toEqual([{price:null,status:'Sold'}]);
    for (const bad of [{field:'annual_property_tax',value:0},{field:'listing',value:{status:'Sold',price:1}},{field:'photo_url',value:'https://evil.test/a.jpg'},{field:'owner',value:'private'},{field:'annual_property_tax_year',value:1800}]) {
      await expect(saveObservation({...base2,captureId:'12345678-6666-4666-8666-666666666666',...bad})).rejects.toThrow();
    }
    const t={...base2,field:'tax_history',value:{taxPaid:2200,year:2024,assessedValue:300000},captureId:'22345678-1111-4111-8111-111111111111'};
    expect((await saveObservation(t)).changedFields).toEqual(['tax_history']);
    const olderTax={...t,value:{taxPaid:9000,year:2023},captureId:'22345678-9999-4999-8999-999999999999'};
    expect((await saveObservation(olderTax)).changedFields).toEqual(['tax_history']);
    const selected=selectActualAnnualTaxes(await fetchActualTaxRows([id])).get(id);
    expect(selected?.amount).toBe(2200);expect(selected?.taxYear).toBe(2024);
    expect((await admin.query("SELECT raw->'propertyTaxes' AS taxes FROM property_observations WHERE property_id=$1 AND field='annual_property_tax'",[id])).rows[0].taxes).toEqual({'2024':{year:2024,total:2200}});
    const room={...base2,field:'published_room',value:{roomType:'bedroom',roomLabel:'Bedroom 2',widthFt:9,lengthFt:10,areaSqft:90},captureId:'22345678-2222-4222-8222-222222222222'};
    expect((await saveObservation(room)).changedFields).toEqual(['published_room']);
    const dimensionOnly={...room,captureId:'22345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa',value:{roomType:'bedroom',roomLabel:'Bedroom 3',widthFt:8,lengthFt:11}};
    expect((await saveObservation(dimensionOnly)).changedFields).toEqual(['published_room']);
    expect(Number((await admin.query("SELECT area_sqft FROM property_rooms WHERE property_id=$1 AND room_label='Bedroom 3'",[id])).rows[0].area_sqft)).toBe(88);
    expect((await admin.query('SELECT width_ft::numeric,length_ft::numeric,area_sqft::numeric FROM property_rooms WHERE property_id=$1',[id])).rows).toHaveLength(2);
    const history={...base2,field:'listing_history',value:{date:'2020-01-01',event:'Listed for rent',kind:'rental',price:2000},captureId:'22345678-3333-4333-8333-333333333333'};
    expect((await saveObservation(history)).changedFields).toEqual(['listing_history']);
    for (const value of [{...history.value,event:'arbitrary'}, {...history.value,kind:'sale'}, {...history.value,source:'Private contact'}, {...history.value,mlsNumber:'bad#'}]) await expect(saveObservation({...history,captureId:randomUUID(),value})).rejects.toThrow();
    expect((await admin.query("SELECT price,status FROM property_listing_events WHERE property_id=$1 AND event_type='browser_rental_history'",[id])).rows).toEqual([{price:null,status:null}]);
    const description={...base2,field:'description',value:'long public description '.repeat(1500),captureId:'22345678-5555-4555-8555-555555555555'};
    expect((await saveObservation(description)).changedFields).toEqual(['description']);
    expect((await saveObservation(description)).changedFields).toEqual(['description']);
    const units={...base2,field:'unit_mix',value:[{bedrooms:2,bathrooms:1}],captureId:'22345678-7777-4777-8777-777777777777'};
    expect((await saveObservation(units)).changedFields).toEqual(['unit_mix']);
    expect((await admin.query("SELECT value,source FROM property_observations WHERE property_id=$1 AND field='unit_mix'",[id])).rows).toEqual([{value:units.value,source:'zillow-browser'}]);
    for (const value of [[{bedrooms:2,privateName:'no'}],[{occupancy:'unknown'}],Array(21).fill({bedrooms:1})]) await expect(saveObservation({...units,captureId:randomUUID(),value})).rejects.toThrow();
    const longArray={...base2,field:'heating',value:Array(30).fill('x'.repeat(200)),captureId:randomUUID()};
    expect((await saveObservation(longArray)).changedFields).toEqual(['heating']);
    expect((await admin.query("SELECT value FROM property_observations WHERE property_id=$1 AND field='heating'",[id])).rows[0].value).toEqual(longArray.value);
    await expect(saveObservation({...longArray,captureId:randomUUID(),value:Array(31).fill('x')})).rejects.toThrow();
    await expect(saveObservation({...description,captureId:randomUUID(),value:'x'.repeat(50001)})).rejects.toThrow();
    const later={...base2,observedAt:new Date().toISOString(),field:'listing',value:{status:'Pending',price:600000},captureId:'32345678-1111-4111-8111-111111111111'};
    await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'watchlist','house')",[id]);
    await admin.query("INSERT INTO property_funnel_ranks(property_id,rank_key) VALUES($1,'a')",[id]);
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';
    process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const submit=async (v:unknown)=>(await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:{origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop',authorization:'Bearer test-token','content-type':'application/json'},body:JSON.stringify(v)}))).json();
    expect((await submit(later)).changedFields).toEqual(['price','status']);
    const dashboard = async (view:string) => (await (await dashboardGET(new NextRequest(`https://dashboard.test/api/dashboard?track=house&lifecycle=${view}`))).json());
    const pendingDashboard=await dashboard('pending');
    expect(pendingDashboard.meta.dbAvailable).toBe(true);
    expect(pendingDashboard.properties.find((p:{id:string})=>p.id===id)?.displayStatus).toBe('Pending');
    expect((await dashboard('search')).properties.some((p:{id:string})=>p.id===id)).toBe(false);

    await admin.query('SELECT pg_sleep(0.01)');
    const active={...later,observedAt:new Date().toISOString(),value:{status:'Active',price:600000},captureId:'32345678-2222-4222-8222-222222222222'};
    expect((await submit(active)).changedFields).toEqual(['status']);
    const restored=(await dashboard('search')).properties.find((p:{id:string})=>p.id===id);
    expect(restored).toMatchObject({displayStatus:'Active',funnelBucket:'watchlist',rankKey:'a'});
    expect((await dashboard('pending')).properties.some((p:{id:string})=>p.id===id)).toBe(false);

    const before=Number((await admin.query('SELECT count(*) AS n FROM property_listing_events WHERE property_id=$1',[id])).rows[0].n);
    await admin.query('SELECT pg_sleep(0.01)');
    expect((await saveObservation({...active,observedAt:new Date().toISOString(),captureId:'32345678-3333-4333-8333-333333333333'})).changedFields).toEqual([]);
    expect(Number((await admin.query('SELECT count(*) AS n FROM property_listing_events WHERE property_id=$1',[id])).rows[0].n)).toBe(before);
    expect((await admin.query('SELECT latest_status FROM property_current WHERE id=$1',[id])).rows[0].latest_status).toBe('Active');
    expect((await admin.query('SELECT collection FROM property_collections WHERE property_id=$1',[id])).rows).toEqual([{collection:'watchlist'}]);
    expect((await admin.query('SELECT rank_key FROM property_funnel_ranks WHERE property_id=$1',[id])).rows).toEqual([{rank_key:'a'}]);
    await admin.query("INSERT INTO property_listing_events(property_id,event_type,price,status,source,observed_at) VALUES($1,'listing',700000,'Pending','rmls',now())",[id]);
    await admin.query('SELECT pg_sleep(0.01)');
    const conflicting={...active,observedAt:new Date().toISOString(),value:{status:'Active',price:500000},captureId:'32345678-4444-4444-8444-444444444444'};
    expect((await saveObservation(conflicting)).changedFields).toEqual([]);
    expect((await admin.query('SELECT latest_price,latest_status FROM property_current WHERE id=$1',[id])).rows[0]).toEqual({latest_price:700000,latest_status:'Pending'});
    expect((await admin.query('SELECT payload FROM browser_observation_field_history WHERE capture_id=$1',[conflicting.captureId])).rows[0].payload).toEqual(conflicting);
    await admin.query(readFileSync(new URL('../scripts/browser-observation-schema.sql', import.meta.url),'utf8'));
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';
    process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const httpObserved=new Date().toISOString();
    const req=(auth:string)=>new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:{origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop',authorization:auth,'content-type':'application/json'},body:JSON.stringify({...base2,observedAt:httpObserved,field:'annual_property_tax',value:2345,captureId:'12345678-7777-4777-8777-777777777777'})});
    expect((await POST(req('Bearer wrong'))).status).toBe(401);
    const response=await POST(req('Bearer test-token')); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({matched:true,zpid:'987',changedFields:['annual_property_tax']});
    expect((await (await POST(req('Bearer test-token'))).json()).changedFields).toEqual(['annual_property_tax']);
    expect((await admin.query("SELECT value,source FROM property_observations WHERE property_id=$1 AND field='annual_property_tax' ORDER BY id DESC LIMIT 1",[id])).rows).toEqual([{value:2345,source:'zillow-browser'}]);
  });
  it('rejects unknown and ambiguous identities without creating properties',async()=>{
    const unknown={...base,zpid:'456',url:'https://www.zillow.com/homedetails/456_zpid/'};
    expect((await saveObservation(unknown)).matched).toBe(false);
    await admin.query(`INSERT INTO property_records(id,canonical_address,normalized_address) VALUES ('22222222-2222-4222-8222-222222222222','other','other')`);
    await admin.query(`INSERT INTO property_identifiers(property_id,kind,value) VALUES ('22222222-2222-4222-8222-222222222222','zpid','123')`);
    expect((await saveObservation({...base,captureId:'ffffffff-ffff-4fff-8fff-ffffffffffff'})).matched).toBe(false);
    expect(Number((await admin.query('SELECT count(*) AS n FROM property_records')).rows[0].n)).toBe(4);
    const restricted=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL});
    await expect(restricted.query(`UPDATE property_editor_notes SET value='changed'`)).rejects.toThrow();
    await expect(restricted.query('SELECT public.resolve_browser_observation_identity($1::jsonb)',[JSON.stringify(base)])).rejects.toThrow(/permission denied/);
    await expect(restricted.query(`INSERT INTO property_listing_events(property_id,event_type,price,status,source) VALUES ($1,'listing',1,'Active','forged')`,[property])).rejects.toThrow(/permission denied/);
    await expect(restricted.query(`INSERT INTO browser_observation_history DEFAULT VALUES`)).rejects.toThrow(/permission denied/);
    await expect(restricted.query('INSERT INTO property_records DEFAULT VALUES')).rejects.toThrow(/permission denied/);
    await expect(restricted.query('CREATE TABLE public.forged (id integer)')).rejects.toThrow(/permission denied/);
    await expect(restricted.query("SELECT nextval('public.property_listing_events_id_seq')")).rejects.toThrow(/permission denied/);
    await expect(restricted.query('SELECT * FROM property_identifiers')).rejects.toThrow(/permission denied/);
    expect((await admin.query("SELECT has_function_privilege('public','public.save_browser_observation(jsonb)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
    await restricted.end();
  });
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO).each(['legacy','3158'])('sends actual extension builder and worker payload through HTTP into restricted SQL for %s',async(scenario)=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!;
    const require=createRequire(import.meta.url);
    const builder=require(resolve(root,'capture-requests.js'));
    const extractor=require(resolve(root,'extract.js'));
    const id=randomUUID(),zpid=scenario==='legacy'?'53976377':'53874198',url=`https://www.zillow.com/homedetails/${zpid}_zpid/`;
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address) VALUES($1,'worker legacy','worker legacy')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'parcel','R295041'),($1,'mls','262014608'),($1,'zillow_url','https://www.zillow.com/homes/5218-NE-18TH-AVE-Portland-OR_rb/')",[id]);
    if (scenario==='3158') {
      await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[id]);
      await admin.query("UPDATE property_records SET canonical_address='3158 NE 78 AVE',parcel_id='R173927' WHERE id=$1",[id]);
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url','https://www.zillow.com/homedetails/3158-NE-78th-Ave-Portland-OR-97213/53874198_zpid/'),($1,'mls','577269814'),($1,'mls_number','294356768')",[id]);
    }
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    let requests=0;
    const http=createHttpServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req) chunks.push(Buffer.from(chunk));
      const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers: req.headers as Record<string,string>,body:Buffer.concat(chunks)}));
      requests++;res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());
    });
    await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
    const port=(http.address() as {port:number}).port;
    let listener: (m:unknown,s:unknown,r:(value:any)=>void)=>void;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(f:typeof listener)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_url:string,init:RequestInit)=>fetch(`http://127.0.0.1:${port}/api/browser-observations`,{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}})});
    try {
      const observation={zpid,url,observedAt:new Date().toISOString(),status:'Active',price:399000,fields:{parcel_id:scenario==='legacy'?'R295041':'R173927',mls_number:scenario==='legacy'?'262014608':'294356768',bedrooms:2}};
      const captures=builder.build(observation,randomUUID);
      const sender={id:'extension',frameId:0,tab:{id:1,url},url};
      const send=()=>new Promise<any>(r=>listener({type:'observe',observation:{...observation,captures}},sender,r));
      const result=await send();expect(result.ok).toBe(true);expect(requests).toBe(captures.length);
      expect((await send()).changedFields).toEqual(result.changedFields);
      expect((await admin.query("SELECT public.resolve_browser_observation_identity($1) AS property_id",[JSON.stringify({zpid})])).rows).toEqual([{property_id:id}]);
      expect((await admin.query('SELECT count(*)::int n FROM browser_observation_field_history WHERE property_id=$1',[id])).rows[0].n).toBe(captures.length);
      expect(JSON.stringify(result)).not.toContain('test-token');
    } finally {
      await new Promise<void>(r=>http.close(()=>r()));
      await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);
      await admin.query('DELETE FROM property_records WHERE id=$1',[id]);
    }
  });
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO).each([true,false])('collects literal Sold label through worker and API without an asking price (dated history=%s)',async(history)=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!, require=createRequire(import.meta.url);
    const extractor=require(resolve(root,'extract.js')), builder=require(resolve(root,'capture-requests.js'));
    (globalThis as any).ZillowDomFields=require(resolve(root,'dom-fields.js'));
    const f=require(resolve(root,'test/sold-fixture.cjs'))('Sold for $439,000',history);
    const observation=extractor.collect(f.document,f.url,f.style);
    expect(observation.status).toBe('Sold');expect(observation.price).toBeUndefined();
    const id=randomUUID(),url=f.url;
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address) VALUES($1,'sold fixture','sold fixture')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zpid','53836087')",[id]);
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const bodies:any[]=[];
    let listener:any;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(f:any)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_url:string,init:RequestInit)=>{
      bodies.push(JSON.parse(init.body as string));
      return POST(new Request('https://dashboard.test/api/browser-observations',{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}}));
    }});
    try {
      const captures=builder.build(observation,randomUUID);
      const result=await new Promise<any>(r=>listener({type:'observe',observation:{...observation,captures}},{id:'extension',frameId:0,tab:{id:1,url},url},r));
      expect(result.ok).toBe(true);expect(bodies).toEqual(captures);
      expect(bodies[0].value).toEqual({status:'Sold'});
      expect(bodies.some(b=>b.field==='price')).toBe(false);
      const events=(await admin.query('SELECT event_type,event_date::text,price,status,raw FROM property_listing_events WHERE property_id=$1 ORDER BY event_type',[id])).rows;
      expect(events.find(e=>e.event_type==='browser_observation')).toMatchObject({price:null,status:'Sold',event_date:null});
      expect((await admin.query('SELECT latest_status,latest_sale_price FROM property_current WHERE id=$1',[id])).rows[0]).toEqual({latest_status:'Sold',latest_sale_price:history?439000:null});
      if(history) expect(events.find(e=>e.event_type==='sold')).toMatchObject({price:439000,event_date:'2026-10-15',raw:{date:'2026-10-15',event:'Sold',price:439000,kind:'sale'}});
      else expect(events).toHaveLength(1);
      expect(events.some(e=>e.price===492700)).toBe(false);
      expect(Number((await admin.query('SELECT count(*) n FROM browser_observation_field_history WHERE property_id=$1',[id])).rows[0].n)).toBe(captures.length);
    } finally {
      delete (globalThis as any).ZillowDomFields;
      await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);
      await admin.query('DELETE FROM property_records WHERE id=$1',[id]);
    }
  });
  it.runIf(!!process.env.BROWSER_OFFLINE_HTML)('renders the private saved page through production worker and authenticated HTTP into PostgreSQL',async()=>{
    const id='66666666-6666-4666-8666-666666666666';
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,track) VALUES($1,'offline fixture','offline fixture','house')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zpid','53973028')",[id]);
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop'; process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    let requests=0, safeHeaders=true;
    const http=createHttpServer(async(req,res)=>{try {
      const chunks:Buffer[]=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk)); const body=Buffer.concat(chunks);
      safeHeaders &&= req.method==='POST' && req.url==='/api/browser-observations' && req.headers.origin==='chrome-extension://abcdefghijklmnopabcdefghijklmnop' && req.headers.authorization==='Bearer test-token' && body.length<=256000;
      requests++;
      const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:{origin:String(req.headers.origin),authorization:String(req.headers.authorization),'content-type':String(req.headers['content-type'])},body}));
      res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());
    } catch { res.writeHead(500);res.end('{}'); }});
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    const port=(http.address() as {port:number}).port;
    try {
      const result=await new Promise<{code:number|null,stdout:string,stderr:string}>((resolve,reject)=>{
        const child=spawn('node',['test/offline-render-harness.cjs',process.env.BROWSER_OFFLINE_HTML!,`http://127.0.0.1:${port}/api/browser-observations`,process.env.BROWSER_OFFLINE_SCREENSHOTS || '/tmp'],{cwd:'/home/node/.openclaw/workspace/property-search-browser-extension',stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
      });
      expect(result.code, result.stderr).toBe(0);const summary=JSON.parse(result.stdout);expect(summary).toMatchObject({partialFailed:true,finalSaved:true});expect(summary.unique).toBeGreaterThan(30);expect(safeHeaders).toBe(true);expect(requests).toBeGreaterThan(summary.unique);
      expect((await admin.query('SELECT count(*)::int AS n FROM browser_observation_field_history WHERE property_id=$1',[id])).rows[0].n).toBe(summary.unique);
      const facts=await admin.query("SELECT field,value FROM property_observations WHERE property_id=$1 AND field IN ('parcel_id','basement','published_annual_tax_amount','description','photo_url','annual_property_tax')",[id]);
      expect(facts.rows.find(x=>x.field==='parcel_id')?.value).toBe('R291279');expect(facts.rows.find(x=>x.field==='basement')?.value).toBe('Finished');
      expect(facts.rows.find(x=>x.field==='published_annual_tax_amount')?.value).toBe(8473);expect(facts.rows.some(x=>x.field==='description' && typeof x.value==='string' && x.value.length>20)).toBe(true);expect(facts.rows.filter(x=>x.field==='photo_url').length).toBeGreaterThan(1);
      const tax=await admin.query("SELECT raw->'propertyTaxes' AS taxes FROM property_observations WHERE property_id=$1 AND field='annual_property_tax'",[id]);expect(tax.rows.some(x=>x.taxes?.['2025']?.total===8474)).toBe(true);
      const rental=await admin.query("SELECT price,status,raw FROM property_listing_events WHERE property_id=$1 AND event_type='browser_rental_history' AND raw->>'event'='Listed for rent'",[id]);expect(rental.rows).toHaveLength(1);expect(rental.rows[0]).toMatchObject({price:null,status:null,raw:{kind:'rental',price:2200}});
      const ledger=await admin.query('SELECT payload FROM browser_observation_field_history WHERE property_id=$1',[id]);
      expect(ledger.rows.every(({payload})=>Object.keys(payload).sort().join(',')==='captureId,field,observedAt,url,value,zpid')).toBe(true);
      expect(ledger.rows.some(({payload})=>/mortgage|agentEmail|adTargets/i.test(JSON.stringify(payload)))).toBe(false);
    } finally {await new Promise<void>(resolve=>http.close(()=>resolve()))}
  },120000);

});
