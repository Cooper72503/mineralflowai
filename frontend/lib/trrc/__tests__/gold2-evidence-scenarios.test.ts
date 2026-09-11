import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {reviewedPositionFixture} from './fixtures/reviewed-position';
import {payloadHash} from '../decision-layer/partner-input';
import {evaluateEvidenceScenarios} from '../gold2/evidence-scenarios';
function setup(){
 const fixture=JSON.parse(readFileSync(new URL('../../../../benchmarks/partner-fixtures/scenario.json',import.meta.url),'utf8'));
 const {title,position}=reviewedPositionFixture();
 const {nri,api,positionType,...assumptions}=fixture.assumptions;
 const economics={assumptions,priceDeck:{base:{oilUsdBbl:80,gasUsdMcf:0},downside:{oilUsdBbl:60,gasUsdMcf:0},upside:{oilUsdBbl:100,gasUsdMcf:0}},sensitivity:{oil:[80],gas:[0]},underwriteBasis:'base'};
 title.findings.push({findingId:'reviewed-alternative',type:'OVER_CONVEYANCE',severity:'high',title:'Synthetic reviewed alternative',explanation:'Test only',affectedTractId:position.tractId,affectedTractLabel:null,affectedInterestType:'mineral',instrumentIds:['deed'],citations:[],nextAction:'Review'});
 const alt=structuredClone(position);
 Object.assign(alt.sources[0].data,{scenarioId:'case-1',findingIds:['reviewed-alternative'],basis:'reviewed_alternative_position'});
 alt.sources[0].sha256=payloadHash(alt.sources[0].data);
 return {api:'4216502733',title,position,partner:fixture.partner,economics,asOf:'2026-09-10T12:00:00Z',scenarios:[{id:'case-1',findingIds:['reviewed-alternative'],position:alt}]};
}
it('revalues an explicitly reviewed same-position alternative without inventing dilution',()=>{const x=setup();const r=evaluateEvidenceScenarios(x);expect(r.scenarios[0].valueImpactUsd).toBe(0);expect(r.measuredExposure).toBe(0);expect(r.evidenceAdjustedValue).toBe(187.5);});
it('does not accept a naked scenario label without hashed reviewed linkage',()=>{const x=setup();x.scenarios[0].position=x.position;expect(()=>evaluateEvidenceScenarios(x)).toThrow(/hashed reviewed/);});
it('does not sum overlapping or independent alternatives',()=>{const x=setup();const another=structuredClone(x.scenarios[0]);another.id='case-2';Object.assign(another.position.sources[0].data,{scenarioId:'case-2'});another.position.sources[0].sha256=payloadHash(another.position.sources[0].data);x.scenarios.push(another);const r=evaluateEvidenceScenarios(x);expect(r.scenarios).toHaveLength(2);expect(r.measuredExposure).toBeNull();expect(r.reason).toMatch(/not summed/);});
it('withholds exposure when reviewed scenario evidence is absent',()=>{expect(evaluateEvidenceScenarios({...setup(),scenarios:null}).measuredExposure).toBeNull();});
