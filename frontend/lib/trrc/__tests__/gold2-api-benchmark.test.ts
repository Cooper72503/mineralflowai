import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {assembleGold2Draft,validateGold2Draft} from '../gold2/assemble';
import {GOLD2_FIELDS,GOLD2_CHARTS,LEGITIMATE_UNAVAILABLE_REASONS} from '../gold2/contract';
import type {LiteSourceAttempt} from '../coverage';
import {chartSeries} from '../gold2/charts';
const cases:Array<{case:{id:string;api10:string};attempts:LiteSourceAttempt[]}>=JSON.parse(readFileSync(new URL('../../../../benchmarks/latest-retrieval.json',import.meta.url),'utf8')).cases;
it.each(cases)('delivers complete evidence fields and chart inputs for $case.id',({case:c,attempts})=>{
 const asOf=new Date(Math.max(...attempts.map((a:any)=>Date.parse(a.attempted_at)))+1000).toISOString();
 const input={api:c.api10,runId:c.id,asOf,attempts,title:null,position:null,partner:null,economics:null,reconciliationPolicy:null};
 const r=assembleGold2Draft(input);
 expect(validateGold2Draft(r)).toEqual([]);expect(Object.keys(r.fields)).toHaveLength(GOLD2_FIELDS.length);expect(r.implementationGaps).toEqual([]);
 for(const f of Object.values(r.fields))if(f.value===null){expect(LEGITIMATE_UNAVAILABLE_REASONS).toContain(f.reasonCode);expect(f.reason?.length).toBeGreaterThan(0);}else expect(f.origin).not.toBeNull();
 expect(r.chartInputs.map(c=>c.id)).toEqual(GOLD2_CHARTS.map(c=>c.id));
 for(const c of r.chartInputs)if(c.status==='ready')expect(()=>chartSeries(r,c.id)).not.toThrow();
 const formatted=`${c.api10.slice(0,2)}-${c.api10.slice(2,5)}-${c.api10.slice(5)}`;
 expect(assembleGold2Draft({...input,api:formatted}).regulator.fields).toEqual(r.regulator.fields);
});
