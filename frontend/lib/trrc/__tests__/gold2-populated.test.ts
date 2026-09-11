import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {reviewedPositionFixture} from './fixtures/reviewed-position';
import {payloadHash} from '../decision-layer/partner-input';
import {assembleGold2Draft,validateGold2Draft} from '../gold2/assemble';
import {chartSeries} from '../gold2/charts';
import {renderGold2Pdf} from '../gold2/pdf';
import {shiftMonth} from '../gold2/production';

it('populates the financial, ownership, subsurface and chart paths from explicitly synthetic evidence',async()=>{
 const f=JSON.parse(readFileSync(new URL('../../../../benchmarks/partner-fixtures/scenario.json',import.meta.url),'utf8'));
 const {title,position}=reviewedPositionFixture();
 const {nri,api,positionType,...assumptions}=f.assumptions;assumptions.from='2026-10';assumptions.horizonMonths=12;
 const economics={assumptions,priceDeck:{base:{oilUsdBbl:80,gasUsdMcf:0},downside:{oilUsdBbl:60,gasUsdMcf:0},upside:{oilUsdBbl:100,gasUsdMcf:0}},sensitivity:{oil:[60,80,100],gas:[0]},underwriteBasis:'base'};
 const data=f.partner.sources[0].data as any[];
 const forecast=data.find(r=>r.kind==='well_monthly_forecast');
 const existing=data.filter(r=>r.kind!=='well_monthly_forecast');
 const rows=[...existing,...Array.from({length:12},(_,i)=>({...forecast,month:shiftMonth('2026-10',i)})),...[
  {property:'formation_tops',value:[{formation:'Synthetic bench',top:10000,base:10100}],unit:'ft'},
  {property:'tvd',value:10050,unit:'ft'},{property:'reference_elevation',value:3000,unit:'ft'},
 ].map(r=>({...r,kind:'well_measurement',api:'4216502733',scope:'subject_well',measuredAt:'2026-09-01T00:00:00Z',referencePoint:'KB',verticalDatum:'MSL'}))];
 f.partner.sources[0].data=rows;f.partner.sources[0].sha256=payloadHash(rows);f.partner.sources[0].retrievedAt='2026-09-10T00:00:00Z';
 f.partner.observations=rows.map((_,i)=>({sourceId:f.partner.sources[0].id,pointer:`/${i}`}));
 title.findings.push({findingId:'alternative',type:'OVER_CONVEYANCE',severity:'high',title:'Synthetic alternative',explanation:'Test only',affectedTractId:position.tractId,affectedTractLabel:null,affectedInterestType:'mineral',instrumentIds:['deed'],citations:[{documentId:'doc-deed',instrumentId:'deed',page:1,excerpt:null,sourceUrl:null,label:'Synthetic'}],nextAction:'Review'});
 const alternative=structuredClone(position);Object.assign(alternative.sources[0].data,{scenarioId:'unchanged',findingIds:['alternative'],basis:'reviewed_alternative_position'});alternative.sources[0].sha256=payloadHash(alternative.sources[0].data);
 const r=assembleGold2Draft({api:'4216502733',runId:'synthetic-populated',asOf:'2026-09-10T12:00:00Z',attempts:f.regulator.attempts,title,position,partner:f.partner,economics,reconciliationPolicy:f.policy,evidenceScenarios:[{id:'unchanged',findingIds:['alternative'],position:alternative}]});
 expect(validateGold2Draft(r)).toEqual([]);
 expect(r.fields['ownership.nri'].value).toEqual({n:'3',d:'256'});
 expect(r.fields['economics.base_value'].value).toBe(1125);
 expect(r.fields['forecast.next12_oil'].value).toMatchObject({value:1200,unit:'bbl'});
 expect(r.fields['geology.tvdss'].value).toMatchObject({value:7050});
 expect(r.fields['economics.measured_exposure'].value).toBe(0);
 expect(r.chartInputs.every(c=>c.status==='ready')).toBe(true);
 for(const chart of r.chartInputs)if(chart.status==='ready')expect(()=>chartSeries(r,chart.id)).not.toThrow();
 const pdf=await renderGold2Pdf(r);expect(pdf.subarray(0,5).toString()).toBe('%PDF-');
 // This fixture verifies populated paths; it never advances the real-API GOLD benchmark count.
},30000);
