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
    await admin.query(readFileSync(process.env.BROWSER_OBSERVATION_BASELINE_SCHEMA || new URL('../scripts/browser-observation-schema.sql', import.meta.url),'utf8'));

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
  it('resolves percent-encoded condo aliases exactly and preserves decisions', async () => {
    const examples = [
      ['922 Nw 11th Ave, Apt 307, Portland, OR 97209','63298034','647118193'],
      ['920 Nw Naito Pkwy, Apt J25, Portland, OR 97209','62966567','519250596'],
      ['851 Sw Broadway Dr, Apt 52, Portland, OR 97201','53829995','385175817'],
    ];
    for (const [address,zpid,mls] of examples) {
      const id=randomUUID();
      const encoded=`https://www.zillow.com/homes/${encodeURIComponent(address).replace(/%20/g,'%20')}_rb/`;
      const alias=`https://www.zillow.com/homes/${address.replace(/[, ]+/g,'-')}_rb/`;
      await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,track) VALUES($1,$2,$3,'house')",[id,address,randomUUID()]);
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2),($1,'mls',$3)",[id,encoded,mls]);
      await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'watchlist','house'),($1,'rejected','house')",[id]);
      const body={zpid,url:`https://www.zillow.com/homedetails/${zpid}_zpid/`,captureId:randomUUID(),observedAt:new Date().toISOString(),field:'bedrooms',value:2,identity:{legacyUrl:alias,mlsNumber:mls}};
      if (zpid==='62966567') for (const unit of ['J2','J250','25','']) {
        const wrong=alias.replace('Apt-J25-',unit ? `Apt-${unit}-` : '');
        expect((await saveObservation({...body,captureId:randomUUID(),identity:{legacyUrl:wrong}})).matched).toBe(false);
      }
      expect((await saveObservation(body)).matched).toBe(true);
      expect((await admin.query('SELECT collection FROM property_collections WHERE property_id=$1 ORDER BY collection',[id])).rows.map(x=>x.collection)).toEqual(['rejected','watchlist']);
      await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);
      await admin.query('DELETE FROM property_records WHERE id=$1',[id]);
    }
  });
  it('rejected intake rolls back identity binding and later observation stays unmatched', async () => {
    const id=randomUUID(),zpid='998881';
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,parcel_id) VALUES($1,'123 Correct Ave','123 CORRECT AVE','R998881')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'mls_number','MLS998881')",[id]);
    const writer=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL});
    const body={action:'watchlist-intake',zpid,url:`https://www.zillow.com/homedetails/${zpid}_zpid/`,legacyUrl:'https://www.zillow.com/homes/999-Wrong-Ave-Portland-OR-97209_rb/',captureId:randomUUID(),observedAt:new Date().toISOString(),track:'plex',identity:{parcelId:'R998881',mlsNumber:'MLS998881'},listing:{status:'Active',price:500000}};
    const snapshot=async()=> (await admin.query("SELECT row_to_json(p) record,(SELECT jsonb_agg(i ORDER BY i.kind,i.value) FROM property_identifiers i WHERE i.property_id=p.id) identifiers FROM property_records p WHERE id=$1",[id])).rows;
    try {
      const before=await snapshot();
      for(let retry=0;retry<2;retry++) expect((await writer.query('SELECT public.save_browser_watchlist_intake($1::jsonb) result',[JSON.stringify(body)])).rows[0].result).toEqual({status:'conflict',zpid});
      expect(await snapshot()).toEqual(before);
      expect((await admin.query("SELECT count(*)::int n FROM property_identifiers WHERE value=$1",[zpid])).rows[0].n).toBe(0);
      expect((await saveObservation({zpid,url:body.url,captureId:randomUUID(),observedAt:body.observedAt,status:'Active',price:999999})).matched).toBe(false);
      expect(await snapshot()).toEqual(before);
    } finally {await writer.end();await admin.query('DELETE FROM browser_watchlist_intake_ledger WHERE capture_id=$1',[body.captureId]);await admin.query('DELETE FROM property_records WHERE id=$1',[id]);}
  });
  it('watchlist intake serializes retries and preserves existing decisions', async () => {
    const writer=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL});
    const body={action:'watchlist-intake',zpid:'998877',url:'https://www.zillow.com/homedetails/998877_zpid/',legacyUrl:'https://www.zillow.com/homes/111-Example-Ave-Apt-J25-Portland-OR-97209_rb/',captureId:randomUUID(),observedAt:new Date().toISOString(),track:'house',identity:{},listing:{status:'Active',price:500000}};
    const save=(o:unknown)=>writer.query('SELECT public.save_browser_watchlist_intake($1::jsonb) AS result',[JSON.stringify(o)]).then(x=>x.rows[0].result);
    try {
      const responses=await Promise.all([save(body),save(body)]);
      expect(responses).toEqual([{status:'created',zpid:body.zpid},{status:'created',zpid:body.zpid}]);
      await expect(save({...body,track:'plex'})).rejects.toThrow();
      await expect(save({...body,captureId:randomUUID(),collection:'rejected'})).rejects.toThrow();
      await expect(save({...body,captureId:randomUUID(),listing:{status:'Active',price:-1}})).rejects.toThrow();
      for(const invalid of [{listing:{status:null}},{listing:{foo:'bar'}},{listing:{status:'Active'}},{listing:null},{identity:null},{track:null},{zpid:null}]) await expect(save({...body,...invalid,captureId:randomUUID()})).rejects.toThrow();
      const same=await Promise.all([save({...body,captureId:randomUUID()}),save({...body,captureId:randomUUID()})]);
      expect(same.every(x=>x.status==='existing')).toBe(true);
      const row=(await admin.query("SELECT p.id,p.track FROM property_records p JOIN property_identifiers i ON i.property_id=p.id WHERE i.kind='zpid' AND i.value=$1",[body.zpid])).rows[0];
      expect(row.track).toBe('house');
      await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'rejected','house')",[row.id]);
      expect(await save({...body,captureId:randomUUID(),track:'plex'})).toEqual({status:'existing',zpid:body.zpid});
      expect(await save({...body,captureId:randomUUID(),legacyUrl:body.legacyUrl.replace('J25','J2')})).toEqual({status:'conflict',zpid:body.zpid});
      const other=randomUUID(); await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address) VALUES($1,'unrelated intake','unrelated intake')",[other]);
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'mls','OTHER999')",[other]);
      expect(await save({...body,captureId:randomUUID(),identity:{mlsNumber:'OTHER999'}})).toEqual({status:'conflict',zpid:body.zpid});
      await admin.query('DELETE FROM property_records WHERE id=$1',[other]);
      expect((await admin.query('SELECT collection,track FROM property_collections WHERE property_id=$1 ORDER BY collection',[row.id])).rows).toEqual([{collection:'rejected',track:'house'},{collection:'watchlist',track:'house'}]);
      await expect(writer.query("INSERT INTO public.property_collections(property_id,collection) VALUES($1,'watchlist')",[row.id])).rejects.toThrow();
      await expect(writer.query('SELECT * FROM public.browser_watchlist_intake_ledger')).rejects.toThrow();
      await expect(writer.query('SELECT public.resolve_browser_observation_identity($1::jsonb)',[JSON.stringify({zpid:body.zpid})])).rejects.toThrow();
      expect((await admin.query("SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.save_browser_watchlist_intake(jsonb)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
      await admin.query('CREATE ROLE nest_intake_unprivileged LOGIN');const outsider=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL!.replace('browser_observation_writer@','nest_intake_unprivileged@')});try{await expect(outsider.query('SELECT public.save_browser_watchlist_intake($1::jsonb)',[JSON.stringify(body)])).rejects.toThrow()}finally{await outsider.end();await admin.query('DROP ROLE nest_intake_unprivileged')}
      const concurrent={...body,zpid:'998880',url:'https://www.zillow.com/homedetails/998880_zpid/',legacyUrl:body.legacyUrl.replace('111-Example','112-Example')};
      const two=await Promise.all([save({...concurrent,captureId:randomUUID()}),save({...concurrent,captureId:randomUUID()})]);expect(two.map(x=>x.status).sort()).toEqual(['created','existing']);expect((await admin.query("SELECT count(*)::int n FROM property_identifiers WHERE kind='zpid' AND value='998880'")).rows[0].n).toBe(1);

      expect(await save({...body,zpid:'998878',url:'https://www.zillow.com/homedetails/998878_zpid/',captureId:randomUUID()})).toEqual({status:'conflict',zpid:'998878'});
      expect(await save({...body,zpid:'998879',url:'https://www.zillow.com/homedetails/998879_zpid/',legacyUrl:body.legacyUrl.replace('J25','J2'),captureId:randomUUID(),track:'plex'})).toEqual({status:'created',zpid:'998879'});
    } finally {
      await admin.query("DELETE FROM public.browser_watchlist_intake_ledger WHERE payload->>'zpid' IN ('998877','998878','998879','998880')");
      await admin.query("DELETE FROM public.property_records WHERE id IN (SELECT property_id FROM public.property_identifiers WHERE kind='zpid' AND value IN ('998877','998879','998880'))");
      await writer.end();
    }
  });
  it('watchlist intake flows through the production worker and authenticated route', async () => {
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!; const require=createRequire(import.meta.url);const extract=require(resolve(root,'extract.js'));
    const zpid='887766', tab=`https://www.zillow.com/homedetails/example/${zpid}_zpid/`, canonical=`https://www.zillow.com/homedetails/${zpid}_zpid/`, legacyUrl='https://www.zillow.com/homes/777-Unique-Ave-Apt-J25-Portland-OR-97209_rb/';
    let listener: any, loss=true, bodies:string[]=[];
    const chrome={runtime:{id:'ext',onMessage:{addListener:(f:unknown)=>{listener=f}}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url:tab})},permissions:{contains:async()=>true}};
    const transport=async (_:string,init:any)=>{bodies.push(init.body);const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:{...init.headers,origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'},body:init.body}));if(JSON.parse(init.body).action && loss){loss=false;await response.arrayBuffer();throw Error('lost response')}return response};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extract,fetch:transport});
    const sender={id:'ext',frameId:0,tab:{id:1,url:tab},url:tab};
    const send=(message:unknown)=>new Promise<any>(r=>listener(message,sender,r));
    const listing={status:'Active',price:500000}; const observed={zpid,url:canonical,legacyUrl,...listing,observedAt:new Date().toISOString()};
    expect(await send({type:'observe',observation:{...observed,captures:[{zpid,url:canonical,observedAt:observed.observedAt,captureId:randomUUID(),field:'listing',value:listing,identity:{legacyUrl}}]}})).toMatchObject({ok:false,reason:'not-tracked'});
    expect((await admin.query("SELECT count(*)::int n FROM property_identifiers WHERE value=$1",[zpid])).rows[0].n).toBe(0);
    const intake={action:'watchlist-intake',zpid,url:canonical,legacyUrl,captureId:randomUUID(),observedAt:observed.observedAt,track:'house',identity:{},listing};
    expect(await send({type:'watchlist-intake',observation:observed,intake})).toMatchObject({ok:true,status:'created'});
    expect(bodies.at(-1)).toBe(bodies.at(-2));
    const rows=await admin.query("SELECT p.track,c.collection,e.price,e.status FROM property_records p JOIN property_identifiers i ON i.property_id=p.id JOIN property_collections c ON c.property_id=p.id JOIN property_listing_events e ON e.property_id=p.id WHERE i.kind='zpid' AND i.value=$1",[zpid]);
    expect(rows.rows).toEqual([{track:'house',collection:'watchlist',price:500000,status:'Active'}]);
    await admin.query("DELETE FROM public.browser_watchlist_intake_ledger WHERE payload->>'zpid'=$1",[zpid]);
    await admin.query("DELETE FROM public.property_records WHERE id IN (SELECT property_id FROM public.property_identifiers WHERE kind='zpid' AND value=$1)",[zpid]);
  });
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO).each([0,1,2])('collects encoded condo fixture %i through worker, HTTP and SQL',async(index)=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!, require=createRequire(import.meta.url);
    const extractor=require(resolve(root,'extract.js')),builder=require(resolve(root,'capture-requests.js')),fixtures=require(resolve(root,'test/condo-fixture.cjs'));
    const c=fixtures.cases[index], f=fixtures.fixture(c), o=extractor.collect(f.document,f.url,f.style), id=randomUUID(), other=randomUUID();
    expect(o?.legacyUrl).toBeTruthy();expect(o?.fields?.mls_number).toBe(c.mls);
    const alias=`https://www.zillow.com/homes/${encodeURIComponent(c.street+', Portland, OR '+c.zip)}_rb/`;
    await admin.query('INSERT INTO property_records(id,canonical_address,normalized_address) VALUES($1::uuid,($1::uuid)::text,($1::uuid)::text),($2::uuid,($2::uuid)::text,($2::uuid)::text)',[id,other]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2),($1,'mls',$3)",[id,alias,c.mls]);
    await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'watchlist','house'),($1,'rejected','house')",[id]);
    const payload=builder.build(o,randomUUID)[0];
    if(index===1){
      const heading=f.document.querySelector('h1'),original=heading.textContent;for(const unit of ['J2','J250','25','']){heading.textContent=original.replace('Apt J25',unit?`Apt ${unit}`:'');expect(extractor.collect(f.document,f.url,f.style)).toBeNull()}heading.textContent=original;
      for(const unit of ['J2','J250','25','']) {const bad=payload.identity.legacyUrl.replace('Apt-J25-',unit?`Apt-${unit}-`:'');expect(await saveObservation({...payload,captureId:randomUUID(),identity:{legacyUrl:bad}})).toEqual({matched:false,changedFields:[]});}
      expect(await saveObservation({...payload,captureId:randomUUID(),identity:{...payload.identity,legacyUrl:payload.identity.legacyUrl.replace('97209','97201')}})).toEqual({matched:false,changedFields:[]});
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'listing_url',$2)",[other,alias]);
      expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual({matched:false,changedFields:[]});
      await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[other]);
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zpid',$2)",[other,o.zpid]);
      expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual({matched:false,changedFields:[]});
      await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[other]);
    }
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const http=createHttpServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text())});
    await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;let listener:any;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(f:any)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url:f.url})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_:string,init:RequestInit)=>fetch(`http://127.0.0.1:${port}/api/browser-observations`,{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}})});
    try {const captures=builder.build(o,randomUUID);const result=await new Promise<any>(r=>listener({type:'observe',observation:{...o,captures}},{id:'extension',frameId:0,tab:{id:1,url:f.url},url:f.url},r));expect(result.ok).toBe(true);if(index===1){
      expect(await saveObservation({...payload,captureId:randomUUID(),identity:{...payload.identity,legacyUrl:payload.identity.legacyUrl.replace('97209','97201')}})).toEqual({matched:false,changedFields:[]});
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'listing_url',$2)",[id,alias.replace('97209','97201')]);
      expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual({matched:false,changedFields:[]});
      await admin.query("DELETE FROM property_identifiers WHERE property_id=$1 AND kind='listing_url'",[id]);
    }expect((await admin.query('SELECT count(*)::int n FROM browser_observation_field_history WHERE property_id=$1',[id])).rows[0].n).toBe(captures.length);expect((await admin.query('SELECT collection FROM property_collections WHERE property_id=$1 ORDER BY collection',[id])).rows.map(x=>x.collection)).toEqual(['rejected','watchlist']);}
    finally {await new Promise<void>(r=>http.close(()=>r()));await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);await admin.query('DELETE FROM property_records WHERE id=ANY($1::uuid[])',[[id,other]])}
  });
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO)('existing 4105 To Tour lookup and intake preserves collection, rank, track and retry',async()=>{
    const id=randomUUID(), zpid='53826416', url='https://www.zillow.com/homedetails/53826416_zpid/',legacyUrl='https://www.zillow.com/homes/4105-SE-14th-Ave-Portland-OR-97202_rb/';
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,parcel_id,track) VALUES($1,'4105 SE 14th Ave, Portland, OR 97202','4105 SE 14TH AVE','R117872','house')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url','https://www.zillow.com/homedetails/4105-SE-14th-Ave-Portland-OR-97202/53826416_zpid/'),($1,'mls','293612480')",[id]);
    await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'tour-shortlist','house')",[id]);await admin.query("INSERT INTO property_funnel_ranks(property_id,rank_key) VALUES($1,'ab')",[id]);
    const body={action:'watchlist-intake',zpid,url,legacyUrl,identity:{parcelId:'R117872',mlsNumber:'293612480'},captureId:randomUUID(),observedAt:new Date().toISOString(),track:'plex',listing:{status:'Active',price:465000}};
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!,require=createRequire(import.meta.url),f=require(resolve(root,'test/condo-fixture.cjs')).fixture({street:'4105 SE 14th Ave',zip:'97202',zpid,mls:'293612480'}),extractor=require(resolve(root,'extract.js')),builder=require(resolve(root,'capture-requests.js'));
    expect((await saveObservation(builder.build(extractor.collect(f.document,f.url,f.style),randomUUID)[0])).matched).toBe(true);
    const writer=new Pool({connectionString:process.env.BROWSER_OBSERVATION_DATABASE_URL});try{for(let i=0;i<2;i++)expect((await writer.query('SELECT public.save_browser_watchlist_intake($1::jsonb) result',[JSON.stringify(body)])).rows[0].result).toEqual({status:'existing',zpid});expect((await admin.query('SELECT collection,track FROM property_collections WHERE property_id=$1',[id])).rows).toEqual([{collection:'tour-shortlist',track:'house'}]);expect((await admin.query('SELECT rank_key FROM property_funnel_ranks WHERE property_id=$1',[id])).rows).toEqual([{rank_key:'ab'}]);expect((await admin.query('SELECT track FROM property_records WHERE id=$1',[id])).rows[0].track).toBe('house');}finally{await writer.end();await admin.query('DELETE FROM browser_watchlist_intake_ledger WHERE capture_id=$1',[body.captureId]);await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);await admin.query('DELETE FROM property_records WHERE id=$1',[id])}
  });
  it.runIf(!!process.env.BROWSER_CHROMIUM_TEST && !!process.env.BROWSER_OBSERVATION_EXTENSION_REPO)('trusted Chromium click collects and saves the captured batch through real HTTP and restricted SQL',async()=>{
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    let viewOnlyChecked=false;const http=createHttpServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:req.headers as Record<string,string>,body}));if(!viewOnlyChecked && !JSON.parse(body.toString()).action){viewOnlyChecked=(await admin.query("SELECT count(*)::int n FROM property_identifiers WHERE value='889977'")).rows[0].n===0}res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text())});
    await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;
    try{
      const result=await new Promise<{code:number|null,stdout:string,stderr:string}>((done,reject)=>{const child=spawn('node',['test/intake-chromium-harness.cjs',`http://127.0.0.1:${port}/api/browser-observations`],{cwd:process.env.BROWSER_OBSERVATION_EXTENSION_REPO!,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}))});
      expect(result.code,result.stderr).toBe(0);expect(viewOnlyChecked).toBe(true);expect(JSON.parse(result.stdout)).toMatchObject({syntheticRejected:true,identicalCapture:true});
      const q=await admin.query("SELECT p.id,c.collection,c.track FROM property_records p JOIN property_identifiers i ON i.property_id=p.id JOIN property_collections c ON c.property_id=p.id WHERE i.kind='zpid' AND i.value='889977'");expect(q.rows).toHaveLength(1);expect(q.rows[0]).toMatchObject({collection:'watchlist',track:'house'});expect((await admin.query("SELECT value FROM property_observations WHERE property_id=$1 AND field='bedrooms'",[q.rows[0].id])).rows[0].value).toBe(2);
    }finally{await new Promise<void>(r=>http.close(()=>r()));await admin.query("DELETE FROM browser_watchlist_intake_ledger WHERE payload->>'zpid'='889977'");await admin.query("DELETE FROM browser_observation_field_history WHERE zpid='889977'");await admin.query("DELETE FROM property_records WHERE id IN (SELECT property_id FROM property_identifiers WHERE kind='zpid' AND value='889977')")}
  },30000);
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO)('2227 plex To Tour resolves through collector, worker, HTTP and restricted SQL without moving or duplicating',async()=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!,require=createRequire(import.meta.url);require(resolve(root,'dom-fields.js'));
    const extractor=require(resolve(root,'extract.js')),builder=require(resolve(root,'capture-requests.js')), fixture=require(resolve(root,'test/condo-fixture.cjs')).fixture;
    const source={street:'2227 SE 70th Ave',zip:'97215',zpid:'462545908',mls:'700560280',parcel:'R148447'},f=fixture(source),o=extractor.collect(f.document,f.url,f.style),id=randomUUID();
    expect(o.fields).toMatchObject({mls_number:source.mls,parcel_id:source.parcel});
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,parcel_id,track) VALUES($1,'2227 SE 70TH AVE, Portland, OR','2227 SE 70TH AVE','R148447','plex')",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url','https://www.zillow.com/homes/2227-SE-70TH-AVE-Portland-OR-97215_rb/'),($1,'mls','700560280')",[id]);
    await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'tour-shortlist','plex')",[id]);await admin.query("INSERT INTO property_funnel_ranks(property_id,rank_key) VALUES($1,'p123')",[id]);
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const http=createHttpServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text())});await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;let listener:any;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(x:any)=>listener=x}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url:f.url})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_:string,init:RequestInit)=>fetch(`http://127.0.0.1:${port}/api/browser-observations`,{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}})});
    try{const captures=builder.build(o,randomUUID);expect(captures[0].identity).toMatchObject({parcelId:'R148447',mlsNumber:'700560280'});const result=await new Promise<any>(r=>listener({type:'observe',observation:{...o,captures}},{id:'extension',frameId:0,tab:{id:1,url:f.url},url:f.url},r));expect(result.ok).toBe(true);expect((await admin.query('SELECT track FROM property_records WHERE id=$1',[id])).rows).toEqual([{track:'plex'}]);expect((await admin.query('SELECT collection,track FROM property_collections WHERE property_id=$1',[id])).rows).toEqual([{collection:'tour-shortlist',track:'plex'}]);expect((await admin.query('SELECT rank_key FROM property_funnel_ranks WHERE property_id=$1',[id])).rows).toEqual([{rank_key:'p123'}]);expect((await admin.query("SELECT count(*)::int n FROM property_identifiers WHERE kind='zpid' AND value=$1 AND property_id=$2",[source.zpid,id])).rows[0].n).toBe(1)}finally{await new Promise<void>(r=>http.close(()=>r()));await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);await admin.query('DELETE FROM property_records WHERE id=$1',[id])}
  });
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO).each([
    {name:'weidler',zpid:'300094907',street:'8513-NE-WEIDLER-ST',zip:'97220',old:'668250654',current:'364369812',parcel:'R251424',status:'Active',price:549000},
    {name:'42nd',zpid:'53907083',street:'1911-SE-42ND-AVE',zip:'97215',old:'797248037',current:'284419862',parcel:'R211913',status:'Sold',price:undefined}
  ])('real offline $name collector payload handles a new MLS and rejects cross-record collisions',async(c)=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!,require=createRequire(import.meta.url),extractor=require(resolve(root,'extract.js'));
    let o:any,captures:any[];
    if(process.env.NOVA_MLS_CAPTURE_DIR) ({o,captures}=JSON.parse(readFileSync(resolve(process.env.NOVA_MLS_CAPTURE_DIR,`${c.name}-collected.json`),'utf8')));
    else {const fixture=require(resolve(root,'test/condo-fixture.cjs')).fixture({street:c.street.replaceAll('-',' '),zip:c.zip,zpid:c.zpid,mls:c.current,status:c.status==='Active'?'For sale':'Sold',price:c.price});o=extractor.collect(fixture.document,fixture.url,fixture.style);captures=require(resolve(root,'capture-requests.js')).build(o,randomUUID)}
    expect(o).toMatchObject({zpid:c.zpid,status:c.status,fields:{mls_number:c.current}});expect(o.price).toBe(c.price);expect(captures[0].identity.mlsNumber).toBe(c.current);
    const id=randomUUID(),other=randomUUID(),alias=`https://www.zillow.com/homes/${c.street}-Portland-OR-${c.zip}_rb/`;
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,parcel_id,track) VALUES($1::uuid,($1::uuid)::text,($1::uuid)::text,$3,'plex'),($2::uuid,($2::uuid)::text,($2::uuid)::text,'OTHERPARCEL','house')",[id,other,c.parcel]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2),($1,'mls',$3)",[id,alias,c.old]);await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'tour-shortlist','plex')",[id]);await admin.query("INSERT INTO property_funnel_ranks(property_id,rank_key) VALUES($1,'p234')",[id]);
    const schema=readFileSync(new URL('../scripts/browser-observation-schema.sql',import.meta.url),'utf8');const start=schema.indexOf('CREATE OR REPLACE FUNCTION public.resolve_browser_observation_identity'),end=schema.indexOf('END; $$;',start)+8;
    const marker="(evidence ? 'parcelId' AND lower(i.kind) IN ('parcel','parcel_id') AND i.value<>evidence->>'parcelId')))";
    const oldClause="(evidence ? 'parcelId' AND lower(i.kind) IN ('parcel','parcel_id') AND i.value<>evidence->>'parcelId') OR (evidence ? 'mlsNumber' AND lower(i.kind) IN ('mls','mls_number') AND NOT EXISTS (SELECT 1 FROM public.property_identifiers m WHERE m.property_id=tracked AND lower(m.kind) IN ('mls','mls_number') AND m.value=evidence->>'mlsNumber'))))";
    expect(schema.slice(start,end)).toContain(marker);const old=schema.slice(start,end).replace('public.resolve_browser_observation_identity','pg_temp.old_nova_resolver').replace(marker,oldClause);const conn=await admin.connect();
    try{await conn.query('BEGIN');await conn.query(old);expect((await conn.query('SELECT pg_temp.old_nova_resolver($1::jsonb) id',[JSON.stringify(captures[0])])).rows[0].id).toBeNull();await conn.query('ROLLBACK')}finally{conn.release()}
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'mls',$2)",[other,c.current]);expect(await saveObservation({...captures[0],captureId:randomUUID()})).toEqual({matched:false,changedFields:[]});await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[other]);
    expect(await saveObservation({...captures[0],captureId:randomUUID(),identity:{...captures[0].identity,parcelId:'OTHERPARCEL'}})).toEqual({matched:false,changedFields:[]});
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';const tab=`https://www.zillow.com/homedetails/${c.street}-Portland-OR-${c.zip}/${c.zpid}_zpid/`;
    const http=createHttpServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text())});await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;let listener:any;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(f:any)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url:tab})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_:string,init:RequestInit)=>fetch(`http://127.0.0.1:${port}/api/browser-observations`,{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}})});
    try{const result=await new Promise<any>(r=>listener({type:'observe',observation:{...o,captures}},{id:'extension',frameId:0,tab:{id:1,url:tab},url:tab},r));expect(result.ok).toBe(true);expect((await admin.query('SELECT track FROM property_records WHERE id=$1',[id])).rows).toEqual([{track:'plex'}]);expect((await admin.query('SELECT collection,track FROM property_collections WHERE property_id=$1',[id])).rows).toEqual([{collection:'tour-shortlist',track:'plex'}]);expect((await admin.query('SELECT rank_key FROM property_funnel_ranks WHERE property_id=$1',[id])).rows).toEqual([{rank_key:'p234'}]);expect((await admin.query('SELECT count(*)::int n FROM browser_observation_field_history WHERE property_id=$1',[id])).rows[0].n).toBe(captures.length)}finally{await new Promise<void>(r=>http.close(()=>r()));await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=$1',[id]);await admin.query('DELETE FROM property_records WHERE id=ANY($1::uuid[])',[[id,other]])}
  },30000);
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
    expect(await saveObservation({...payload,captureId:randomUUID(),identity:{parcelId:'WRONG',mlsNumber:'294356768'}})).toEqual(unmatched);
    expect(await saveObservation({...payload,captureId:randomUUID(),identity:{parcelId:'R173927',mlsNumber:'UNKNOWN'}})).toEqual({matched:true,zpid,changedFields:[]});
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
    await admin.query(readFileSync(process.env.BROWSER_OBSERVATION_BASELINE_SCHEMA || new URL('../scripts/browser-observation-schema.sql', import.meta.url),'utf8'));
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
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO).each(['direct','anchors','conflict','unknown'])('keeps established identity authoritative with optional absent legacy alias through worker and SQL (%s)',async(scenario)=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!,require=createRequire(import.meta.url);
    const extractor=require(resolve(root,'extract.js')),builder=require(resolve(root,'capture-requests.js'));
    const f=require(resolve(root,'test/legacy-fixture.cjs')).fixture('davis'),observation=extractor.collect(f.document,f.url,f.style);
    const id=randomUUID(),other=randomUUID(),zpid=observation.zpid;
    await admin.query('INSERT INTO property_records(id,canonical_address,normalized_address) VALUES($1::uuid,($1::uuid)::text,($1::uuid)::text),($2::uuid,($2::uuid)::text,($2::uuid)::text)',[id,other]);
    if(scenario==='direct'||scenario==='conflict') await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2)",[id,observation.url]);
    if(scenario==='anchors') {await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'parcel','R-ABSENT'),($1,'mls','M-ABSENT')",[id]);observation.fields={parcel_id:'R-ABSENT',mls_number:'M-ABSENT'};}
    if(scenario==='conflict') await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2)",[other,observation.legacyUrl]);
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const http=createHttpServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text())});
    await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;
    let listener:(m:unknown,s:unknown,r:(v:any)=>void)=>void;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(f:typeof listener)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url:f.url})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_url:string,init:RequestInit)=>fetch(`http://127.0.0.1:${port}/api/browser-observations`,{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}})});
    try{
      const captures=builder.build(observation,randomUUID);expect(captures[0].identity.legacyUrl).toBe(observation.legacyUrl);
      const result=await new Promise<any>(r=>listener({type:'observe',observation:{...observation,captures}},{id:'extension',frameId:0,tab:{id:1,url:f.url},url:f.url},r));
      if(scenario==='direct'||scenario==='anchors') {expect(result.ok).toBe(true);expect((await admin.query('SELECT latest_status FROM property_current WHERE id=$1',[id])).rows[0].latest_status).toBe('Off market');}
      else {expect(result).toMatchObject({ok:false,reason:'not-tracked'});expect((await admin.query('SELECT count(*)::int n FROM browser_observation_field_history WHERE property_id=ANY($1::uuid[])',[[id,other]])).rows[0].n).toBe(0);}
    }finally{await new Promise<void>(r=>http.close(()=>r()));await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=ANY($1::uuid[])',[[id,other]]);await admin.query('DELETE FROM property_records WHERE id=ANY($1::uuid[])',[[id,other]])}
  });
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO).each(['exact','unknown','ambiguous','stable-conflict','listing-conflict','unit','range-endpoint','single-endpoint','duplicate-305'])('range collector → builder → worker → authenticated handler → restricted SQL (%s)',async(scenario)=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!,require=createRequire(import.meta.url);
    const extractor=require(resolve(root,'extract.js')),builder=require(resolve(root,'capture-requests.js'));
    const zpid=String(800000000+['exact','unknown','ambiguous','stable-conflict','listing-conflict','unit','range-endpoint','single-endpoint','duplicate-305'].indexOf(scenario));
    const f=require(resolve(root,'test/range-fixture.cjs'))({zpid,...(scenario==='duplicate-305'?{street:'305 NE 26th Ave'}:{})}),observation=extractor.collect(f.document,f.url,f.style);
    expect(observation?.legacyUrl).toBe(scenario==='duplicate-305'?'https://www.zillow.com/homes/305-NE-26th-Ave-Portland-OR-97213_rb/':'https://www.zillow.com/homes/1630-1632-NE-81st-Ave-Portland-OR-97213_rb/');
    const id=randomUUID(),other=randomUUID();
    await admin.query("INSERT INTO property_records(id,canonical_address,normalized_address,track) VALUES($1::uuid,'1630 1632 NE 81ST AVE',($1::uuid)::text,'plex'),($2::uuid,'other',($2::uuid)::text,'plex')",[id,other]);
    let source=observation.legacyUrl;
    if(scenario==='unit') source=source.replace('-Portland','-Apt-J25-Portland');
    if(scenario==='range-endpoint') source=source.replace('1630-1632','1630-1633');
    if(scenario==='single-endpoint') source=source.replace('1630-1632','1630');
    if(scenario!=='unknown') await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2)",[id,source]);
    if(scenario==='ambiguous') await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'listing_url',$2)",[other,source]);
    if(scenario==='duplicate-305') {
      observation.fields.mls_number='691040154';
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'mls','691040154'),($2,'mls','722421254'),($2,'zillow_zpid',$3)",[id,other,zpid]);
    }
    if(scenario==='stable-conflict') await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zpid',$2)",[other,zpid]);
    if(scenario==='listing-conflict') {
      observation.fields.mls_number='MLS-RANGE';
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'mls','MLS-RANGE')",[other]);
    }
    await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'watchlist','plex')",[id]);
    await admin.query("INSERT INTO property_funnel_ranks(property_id,rank_key) VALUES($1,'zzzy')",[id]);
    await admin.query("INSERT INTO property_editor_notes(property_id,field,value) VALUES($1,'remarks','preserve')",[id]);
    await admin.query("INSERT INTO property_editor_judgments(property_id,field,verdict) VALUES($1,'drum_space','no')",[id]);
    const snapshot=async()=>{
      const result:Record<string,unknown>={};
      for(const table of ['property_records','property_collections','property_funnel_ranks','property_editor_notes','property_editor_judgments']) result[table]=(await admin.query(`SELECT row_to_json(t) r FROM ${table} t WHERE ${table==='property_records'?'id':'property_id'}=ANY($1::uuid[]) ORDER BY row_to_json(t)::text`,[[id,other]])).rows;
      return result;
    };
    const before=await snapshot(),identifiers=(await admin.query('SELECT * FROM property_identifiers WHERE property_id=ANY($1::uuid[]) ORDER BY kind,value',[[id,other]])).rows;
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    let requests=0;
    const http=createHttpServer(async(req,res)=>{requests++;const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text())});
    await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;
    let listener:(m:unknown,s:unknown,r:(v:any)=>void)=>void;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(f:typeof listener)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url:f.url})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_url:string,init:RequestInit)=>fetch(`http://127.0.0.1:${port}/api/browser-observations`,{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}})});
    try {
      const captures=builder.build(observation,randomUUID);expect(captures.every((p:any)=>p.identity.legacyUrl===source)).toBe(!['unit','range-endpoint','single-endpoint'].includes(scenario));
      const result=await new Promise<any>(r=>listener({type:'observe',observation:{...observation,captures}},{id:'extension',frameId:0,tab:{id:1,url:f.url},url:f.url},r));
      expect(requests).toBeGreaterThan(0);
      if(scenario==='exact') {
        expect(result).toMatchObject({ok:true});
        expect((await admin.query("SELECT value FROM property_identifiers WHERE property_id=$1 AND kind='zpid'",[id])).rows).toEqual([{value:zpid}]);
      } else {
        expect(result).toEqual({ok:false,reason:'not-tracked'});
        expect((await admin.query('SELECT * FROM property_identifiers WHERE property_id=ANY($1::uuid[]) ORDER BY kind,value',[[id,other]])).rows).toEqual(identifiers);
        expect((await admin.query('SELECT * FROM browser_observation_field_history WHERE property_id=ANY($1::uuid[])',[[id,other]])).rows).toEqual([]);
      }
      expect(await snapshot()).toEqual(before);
    } finally {await new Promise<void>(r=>http.close(()=>r()));await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=ANY($1::uuid[])',[[id,other]]);await admin.query('DELETE FROM property_records WHERE id=ANY($1::uuid[])',[[id,other]])}
  });
  it.runIf(!!process.env.BROWSER_OBSERVATION_EXTENSION_REPO).each(['davis','alberta','prescott','showcase'])('collects %s through actual builder, worker, HTTP handler and restricted SQL without manual binding',async(name)=>{
    const root=process.env.BROWSER_OBSERVATION_EXTENSION_REPO!,require=createRequire(import.meta.url);
    const extractor=require(resolve(root,'extract.js')),builder=require(resolve(root,'capture-requests.js'));
    const cases=require(resolve(root,'test/legacy-fixture.cjs')).cases;
    const f=name==='showcase'?require(resolve(root,'test/showcase-fixture.cjs'))():require(resolve(root,'test/legacy-fixture.cjs')).fixture(name);
    const observation=process.env.BROWSER_OBSERVATION_CAPTURE_DIR ? JSON.parse(readFileSync(resolve(process.env.BROWSER_OBSERVATION_CAPTURE_DIR,`nest-${name==='showcase'?'terwilliger':name}-collected.json`),'utf8')).o : extractor.collect(f.document,f.url,f.style);expect(observation).not.toBeNull();
    const id=randomUUID(),other=randomUUID(),zpid=observation.zpid;
    const source=name==='showcase'?'https://www.zillow.com/homes/9314-SW-Terwilliger-Blvd-Portland-OR-97219_rb/':cases[name].legacy;
    const canonical=name==='showcase'?'9314 SW TERWILLIGER BLVD':cases[name].street.toUpperCase();
    await admin.query('INSERT INTO property_records(id,canonical_address,normalized_address) VALUES($1,$2,$2),($3::uuid,($3::uuid)::text,($3::uuid)::text)',[id,canonical,other]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url',$2)",[id,source]);
    await admin.query("INSERT INTO property_collections(property_id,collection,track) VALUES($1,'watchlist','house')",[id]);
    await admin.query("INSERT INTO property_funnel_ranks(property_id,rank_key) VALUES($1,'zzzzz')",[id]);
    const saved=await admin.query('SELECT row_to_json(t) r FROM property_collections t WHERE property_id=$1',[id]);
    if(observation.fields?.mls_number) await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'mls',$2)",[id,observation.fields.mls_number]);
    const payload=builder.build(observation,randomUUID)[0],unmatched={matched:false,changedFields:[]};
    // Neither canonical suffixes nor zip-less aliases are repaired by fixtures.
    // The baseline writer fails this first positive assertion.
    expect((await saveObservation(payload)).matched).toBe(true);
    // Remove the automatically learned zpid to repeat cold-start ambiguity tests.
    await admin.query("DELETE FROM property_identifiers WHERE property_id=$1 AND kind='zpid'",[id]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'listing_url',$2)",[other,source]);
    expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual(unmatched);
    await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[other]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zpid',$2)",[other,zpid]);
    expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual(unmatched);
    await admin.query('DELETE FROM property_identifiers WHERE property_id=$1',[other]);
    await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'parcel','OTHER'),($1,'mls','OTHER')",[other]);
    for(const identity of [{...payload.identity,parcelId:'OTHER'},{...payload.identity,mlsNumber:'OTHER'}, {...payload.identity,legacyUrl:payload.identity.legacyUrl.replace('-OR-','-WA-')}, {...payload.identity,legacyUrl:payload.identity.legacyUrl.replace('97217','99999').replace('97232','99999').replace('97219','99999')}]){
      // A zip-less stored URL explicitly lacks ZIP evidence; only a different
      // known ZIP is a conflict. State/street and cross-record IDs always reject.
      if(identity.legacyUrl.includes('99999') && !/-\d{5}_rb/.test(source)) continue;
      expect(await saveObservation({...payload,captureId:randomUUID(),identity})).toEqual(unmatched);
    }
    if(name==='davis'){
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'listing_url','https://www.zillow.com/homes/2124-NE-Davis-St-Portland-OR-99999_rb/')",[id]);
      expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual(unmatched);
      await admin.query("DELETE FROM property_identifiers WHERE property_id=$1 AND kind='listing_url'",[id]);
      await admin.query("INSERT INTO property_identifiers(property_id,kind,value) VALUES($1,'zillow_url','https://www.zillow.com/homedetails/999_zpid/')",[id]);
      expect(await saveObservation({...payload,captureId:randomUUID()})).toEqual(unmatched);
      await admin.query("DELETE FROM property_identifiers WHERE property_id=$1 AND value LIKE '%999_zpid/'",[id]);
    }
    process.env.BROWSER_OBSERVATION_EXTENSION_ID='abcdefghijklmnopabcdefghijklmnop';process.env.BROWSER_OBSERVATION_TOKEN='test-token';
    const http=createHttpServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const response=await POST(new Request('https://dashboard.test/api/browser-observations',{method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)}));res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text())});
    await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const port=(http.address() as {port:number}).port;
    let listener:(m:unknown,s:unknown,r:(v:any)=>void)=>void;
    const chrome={runtime:{id:'extension',onMessage:{addListener:(f:typeof listener)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>({origin:'https://dashboard.test',token:'test-token'})}},tabs:{get:async()=>({url:f.url})},permissions:{contains:async()=>true}};
    runInNewContext(readFileSync(resolve(root,'worker.js'),'utf8'),{chrome,URL,AbortSignal,TextEncoder,importScripts:()=>{},ZillowExtract:extractor,fetch:async(_url:string,init:RequestInit)=>fetch(`http://127.0.0.1:${port}/api/browser-observations`,{...init,headers:{...init.headers,Origin:'chrome-extension://abcdefghijklmnopabcdefghijklmnop'}})});
    try{
      const captures=builder.build(observation,randomUUID),sender={id:'extension',frameId:0,tab:{id:1,url:f.url},url:f.url};
      const send=(o=observation,cs=captures)=>new Promise<any>(r=>listener({type:'observe',observation:{...o,captures:cs}},sender,r));
      expect((await send()).ok).toBe(true);expect((await send()).ok).toBe(true);
      expect((await saveObservation({...payload,captureId:randomUUID(),identity:{legacyUrl:payload.identity.legacyUrl.replace('-OR-','-WA-')}})).matched).toBe(true); // known zpid remains authoritative when no alternate alias matches
      expect((await send({...observation,legacyUrl:'https://www.zillow.com/homes/999-Other-St-Portland-OR-97217_rb/'})).ok).toBe(false);
      expect((await admin.query('SELECT latest_status,latest_price FROM property_current WHERE id=$1',[id])).rows[0]).toMatchObject({latest_status:observation.status,...(name==='showcase'?{latest_price:450000}:{})});
      expect((await admin.query('SELECT row_to_json(t) r FROM property_collections t WHERE property_id=$1',[id])).rows).toEqual(saved.rows);
      expect((await admin.query('SELECT rank_key FROM property_funnel_ranks WHERE property_id=$1',[id])).rows[0].rank_key).toBe('zzzzz');
      expect((await admin.query("SELECT value FROM property_identifiers WHERE property_id=$1 AND kind='zpid'",[id])).rows[0].value).toBe(zpid);
    }finally{await new Promise<void>(r=>http.close(()=>r()));await admin.query('DELETE FROM browser_observation_field_history WHERE property_id=ANY($1::uuid[])',[[id,other]]);await admin.query('DELETE FROM property_records WHERE id=ANY($1::uuid[])',[[id,other]])}
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
