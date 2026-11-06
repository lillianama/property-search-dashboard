import { describe, expect, it } from 'vitest';
import { effectivePurchasePrice } from './purchase-price';
import { applyEditorSaveToHouses, parseEditorSaveRequest } from './editor';
import { UNKNOWN_JUDGMENTS } from './types';
import { computePiti, DEFAULT_PITI_ASSUMPTIONS, parseStoredAssumptions, serializeAssumptions } from './piti';

describe('shared purchase price', () => {
  it.each([0,-1,Infinity,NaN,'490000',true,{},1.234,1_000_000_001])('rejects invalid override %s', value => {
    expect(parseEditorSaveRequest({purchasePriceOverride:value}).ok).toBe(false);
  });
  it.each([null,490000,490000.25])('accepts an explicit setting without notes: %s', value => {
    expect(parseEditorSaveRequest({purchasePriceOverride:value})).toEqual({ok:true,request:{fields:{},judgments:{},purchasePriceOverride:value}});
  });
  it('keeps incoming market updates independent and clears immediately to the server-confirmed latest price', () => {
    const other = {id:'b',latestPrice:600000,judgments:UNKNOWN_JUDGMENTS};
    const initial = [{id:'a',latestPrice:500000,judgments:UNKNOWN_JUDGMENTS},other];
    const notes = {remarks:null,pros:null,cons:null,judgments:UNKNOWN_JUDGMENTS};
    const saved = applyEditorSaveToHouses(initial,'a',{...notes,purchasePriceOverride:490000,marketPrice:500000});
    const incoming = [{...saved[0],latestPrice:480000},other];
    expect(effectivePurchasePrice(incoming[0])).toBe(490000);
    expect(incoming[0].latestPrice).toBe(480000);
    const cleared = applyEditorSaveToHouses(incoming,'a',{...notes,purchasePriceOverride:null,marketPrice:475000});
    expect(effectivePurchasePrice(cleared[0])).toBe(475000);
    expect(cleared[1]).toBe(other);
    const piti = computePiti({price:effectivePurchasePrice(cleared[0]),actualAnnualTax:3600},DEFAULT_PITI_ASSUMPTIONS)!;
    expect(piti.downPaymentAmount).toBe(23750);
    expect(piti.loanAmount).toBe(451250);
  });
  it('migrates the previous default only, preserving customized rates and other fields', () => {
    expect(DEFAULT_PITI_ASSUMPTIONS.interestRatePct).toBe(7);
    expect(parseStoredAssumptions(JSON.stringify({version:3,interestRatePct:7.25,downPaymentPct:12}))).toMatchObject({interestRatePct:7,downPaymentPct:12});
    for (const interestRatePct of [6.5,6.875,7.125,8]) expect(parseStoredAssumptions(JSON.stringify({version:3,interestRatePct})).interestRatePct).toBe(interestRatePct);
    expect(parseStoredAssumptions(serializeAssumptions({...DEFAULT_PITI_ASSUMPTIONS,interestRatePct:7.25})).interestRatePct).toBe(7.25);
  });
});
