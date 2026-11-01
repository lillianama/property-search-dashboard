import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({queries: [] as string[], match: 1, duplicate: false, currentCalls: 0}));
vi.mock('pg', () => ({Pool: class { async connect() { return {release(){}, async query(sql:string) {
 state.queries.push(sql);
 if (sql.includes('SELECT DISTINCT property_id')) return {rows: state.match ? [{property_id:'uuid'}] : [],rowCount:state.match};
 if (sql.includes('SELECT 1 FROM browser_observation_history WHERE')) return {rows:[],rowCount:state.duplicate ? 1 : 0};
 if (sql.includes('FROM property_current WHERE')) { state.currentCalls++; return {rows:[state.currentCalls===1 ? {latest_price:400000,latest_status:'Active'} : {latest_price:500000,latest_status:'Active'}]}; }
 return {rows:[],rowCount:1};
 }}; }}}));
import { saveObservation } from './browser-observation-writes';
const observation={zpid:'123',url:'https://www.zillow.com/homedetails/123_zpid/',observedAt:new Date().toISOString(),price:500000,status:'Active' as const};
beforeEach(()=>{process.env.BROWSER_OBSERVATION_DATABASE_URL='postgres://unused';state.queries=[];state.match=1;state.duplicate=false;state.currentCalls=0;});
describe('observation transaction',()=>{
 it('locks, matches existing identity, appends history and projects before acknowledging',async()=>{expect(await saveObservation(observation)).toEqual({matched:true,zpid:'123',changedFields:['price']}); const q=state.queries.join('\n'); expect(q).toContain('pg_advisory_xact_lock');expect(q).toContain('INSERT INTO browser_observation_history');expect(q).toContain('INSERT INTO property_listing_events');expect(q).toContain('COMMIT');expect(q).not.toMatch(/UPDATE |DELETE /);});
 it('does not insert for a duplicate or unmatched identity',async()=>{state.duplicate=true;expect((await saveObservation(observation)).changedFields).toEqual([]);expect(state.queries.join('\n')).not.toContain('INSERT INTO');state.queries=[];state.match=0;expect((await saveObservation(observation)).matched).toBe(false);expect(state.queries.join('\n')).not.toContain('INSERT INTO');});
});
