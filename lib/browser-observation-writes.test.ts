import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({query: vi.fn(), config: {} as Record<string,unknown>, onError: undefined as ((error: Error) => void) | undefined}));
vi.mock('pg', () => ({Pool: class {
  constructor(config: Record<string,unknown>) { state.config=config; }
  on(_event: string, cb: (error: Error) => void) { state.onError=cb; }
  query = state.query;
}}));
import { saveObservation, lookupTracking } from './browser-observation-writes';
const observation={zpid:'123',captureId:'11111111-1111-4111-8111-111111111111',url:'https://www.zillow.com/homedetails/123_zpid/',observedAt:new Date().toISOString(),price:500000,status:'Active' as const};
beforeEach(()=>{process.env.BROWSER_OBSERVATION_DATABASE_URL='postgres://unused';state.query.mockReset();});
describe('observation function wrapper',()=>{
 it('delegates one parameterized call and preserves the original retry result',async()=>{
   const result={matched:true,zpid:'123',changedFields:['price']};
   state.query.mockResolvedValue({rows:[{result}]});
   expect(await saveObservation(observation)).toEqual(result);
   expect(await saveObservation(observation)).toEqual(result);
   expect(state.query).toHaveBeenCalledWith('SELECT public.save_browser_observation($1::jsonb) AS result',[JSON.stringify(observation)]);
 });
 it('returns unmatched and propagates transaction failure',async()=>{
   state.query.mockResolvedValueOnce({rows:[{result:{matched:false,changedFields:[]}}]}).mockRejectedValueOnce(new Error('rollback'));
   expect(await saveObservation(observation)).toEqual({matched:false,changedFields:[]});
   await expect(saveObservation(observation)).rejects.toThrow('rollback');
 });
 it('limits connection time and logs idle errors without details',async()=>{
   state.query.mockResolvedValue({rows:[{result:{matched:false,changedFields:[]}}]});
   await saveObservation(observation);
   expect(state.config).toMatchObject({connectionTimeoutMillis:5000,statement_timeout:10000,idleTimeoutMillis:30000});
   const log=vi.spyOn(console,'error').mockImplementation(()=>{});
   state.onError?.(new Error('secret connection detail'));
   expect(log).toHaveBeenCalledWith('[browser-observations] idle database connection error');
   expect(JSON.stringify(log.mock.calls)).not.toContain('secret');log.mockRestore();
 });
});

it('tracking delegates only to SELECT resolver and projects safe boolean',async()=>{
 const body={action:'tracking-lookup' as const,scope:'apartment-range' as const,zpid:'53891611',url:'https://www.zillow.com/homedetails/53891611_zpid/',legacyUrl:'https://www.zillow.com/homes/1630-1632-NE-81st-Ave-Portland-OR-97213_rb/',identity:{}};
 state.query.mockResolvedValue({rows:[{result:{tracked:true,propertyId:'private'}}]});
 expect(await lookupTracking(body)).toEqual({tracked:true});expect(state.query).toHaveBeenCalledWith('SELECT public.lookup_browser_tracking($1::jsonb) AS result',[JSON.stringify(body)]);
 state.query.mockResolvedValue({rows:[{result:{tracked:'yes'}}]});await expect(lookupTracking(body)).rejects.toThrow('unavailable');
});
