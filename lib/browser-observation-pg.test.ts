import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { saveObservation, closeBrowserObservationPool } from './browser-observation-writes';
import type { Observation } from './browser-observations';

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
  it('rejects unknown and ambiguous identities without creating properties',async()=>{
    const unknown={...base,zpid:'456',url:'https://www.zillow.com/homedetails/456_zpid/'};
    expect((await saveObservation(unknown)).matched).toBe(false);
    await admin.query(`INSERT INTO property_records(id,canonical_address,normalized_address) VALUES ('22222222-2222-4222-8222-222222222222','other','other')`);
    await admin.query(`INSERT INTO property_identifiers(property_id,kind,value) VALUES ('22222222-2222-4222-8222-222222222222','zpid','123')`);
    expect((await saveObservation({...base,captureId:'ffffffff-ffff-4fff-8fff-ffffffffffff'})).matched).toBe(false);
    expect(Number((await admin.query('SELECT count(*) AS n FROM property_records')).rows[0].n)).toBe(3);
    const restricted=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL});
    await expect(restricted.query(`UPDATE property_editor_notes SET value='changed'`)).rejects.toThrow();
    await expect(restricted.query(`INSERT INTO property_listing_events(property_id,event_type,price,status,source) VALUES ($1,'listing',1,'Active','forged')`,[property])).rejects.toThrow(/permission denied/);
    await expect(restricted.query(`INSERT INTO browser_observation_history DEFAULT VALUES`)).rejects.toThrow(/permission denied/);
    await expect(restricted.query('INSERT INTO property_records DEFAULT VALUES')).rejects.toThrow(/permission denied/);
    await expect(restricted.query('CREATE TABLE public.forged (id integer)')).rejects.toThrow(/permission denied/);
    await expect(restricted.query("SELECT nextval('public.property_listing_events_id_seq')")).rejects.toThrow(/permission denied/);
    await expect(restricted.query('SELECT * FROM property_identifiers')).rejects.toThrow(/permission denied/);
    expect((await admin.query("SELECT has_function_privilege('public','public.save_browser_observation(jsonb)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
    await restricted.end();
  });
});
