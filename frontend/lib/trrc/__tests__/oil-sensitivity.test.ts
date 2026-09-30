import { it, expect } from 'vitest';
import { oilSensitivity, costScenario } from '../deal/oil-sensitivity';
import { defaultAssumptions, evaluatePrototype } from '../economics-provider';
import { entryAnalysis, exitAnalysis } from '../deal/decision-layer';
const oil=Array.from({length:30},(_,i)=>12000*Math.pow(1+.7*.08*i,-1/.7));
const asset={key:'test',name:'fixture',monthlyOilBbl:oil,monthlyGasMcf:oil.map(x=>x*4),lastReportedMonth:'2026-07',producingWells:4,fieldName:'SPRABERRY (TREND AREA)',county:'MIDLAND'};
const a=defaultAssumptions({oilPriceUsdBbl:80,gasPriceUsdMcf:3,priceBasis:'fixture',fieldName:asset.fieldName,county:asset.county,operatorNri:.75,operatorNriBasis:null}).assumptions;
it('prints 13 prices and uses existing entry/exit formulas unchanged',()=>{
 const rows=oilSensitivity(asset,a), e=evaluatePrototype(asset,a), entry=entryAnalysis(e)!;
 expect(rows.map(r=>r.oilPriceUsdBbl)).toEqual([40,45,50,55,60,65,70,75,80,85,90,95,100]);
 expect(rows[8].ceiling).toBe(entry.ceiling);
 expect(rows[8].exitValue).toBe(exitAnalysis(e,entry)!.byScenario.base.exitValue);
 expect(rows[0].ceiling!).toBeLessThan(rows[12].ceiling!);
 expect(a.oilPriceUsdBbl).toBe(80);
});
it('changes working interest values with costs without changing prices or ownership',()=>{
 const w={...a,interestType:'working' as const,workingInterest:1,netRevenueInterest:.75};
 const hi=costScenario(w,1.2),lo=costScenario(w,.8);
 expect(Object.keys(hi).sort()).toEqual(['fixedOpexUsdPerWellMonth','loeUsdPerBoe','workoverUsdPerBoe']);
 expect(oilSensitivity(asset,{...w,...hi})[8].ceiling!).toBeLessThan(oilSensitivity(asset,{...w,...lo})[8].ceiling!);
});
it('explains unavailable forecasts at every price',()=>{
 const rows=oilSensitivity({...asset,monthlyOilBbl:[],monthlyGasMcf:[]},a);
 expect(rows).toHaveLength(13);
 expect(rows.every(r=>r.reason && r.ceiling===null && r.exitValue===null)).toBe(true);
});
