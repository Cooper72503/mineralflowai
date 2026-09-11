import {it,expect} from "vitest";
import {normalizePartnerInput,payloadHash} from "../decision-layer/partner-input";
import {mapWellMeasurements} from "../gold2/measurements";
import {assembleGold2Draft} from "../gold2/assemble";
const api="4216502733",asOf="2026-09-10T00:00:00Z";
const row=(property:string,value:number|string,unit:string,subject=api)=>({kind:"well_measurement",scope:"subject_well",api:subject,property,value,unit,measuredAt:"2026-09-01T00:00:00Z",referencePoint:"KB",verticalDatum:"MSL"});
function bundle(rows:unknown[]){return {contract:"mineralflow-partner-production-0.1",mode:"synthetic_fixture",sources:[{id:"fixture",provider:"Synthetic test",url:"https://example.invalid/data",retrievedAt:asOf,sha256:payloadHash(rows),data:rows}],observations:rows.map((_,i)=>({sourceId:"fixture",pointer:`/${i}`}))};}
it("maps measurements by API and reuses the existing TVDSS engine",()=>{const r=mapWellMeasurements(bundle([row("tvd",3048,"m"),row("reference_elevation",3000,"ft"),row("porosity",15,"percent"),row("lateral_length",10000,"ft","4243934308")]),api,asOf);expect(r.fields["geology.tvd"].value).toBe(10000);expect(r.fields["geology.tvdss"].value).toBe(7000);expect(r.fields["geology.porosity"].value).toBe(.15);expect(r.fields["geology.lateral_length"]).toBeUndefined();});
it("does not subtract mismatched depth references",()=>{const r=mapWellMeasurements(bundle([row("tvd",10000,"ft"),{...row("reference_elevation",3000,"ft"),referencePoint:"GL"}]),api,asOf);expect(r.fields["geology.tvdss"]).toBeUndefined();expect(r.conflicts[0].reason).toMatch(/references/);});
it("withholds contradictory measurements instead of choosing a source",()=>{const r=mapWellMeasurements(bundle([row("net_pay",100,"ft"),row("net_pay",200,"ft")]),api,asOf);expect(r.fields["geology.net_pay"]).toBeUndefined();expect(r.conflicts).toHaveLength(1);});
it("rejects unsupported units, invalid fractions and altered payloads",()=>{expect(()=>normalizePartnerInput(bundle([row("proppant",12,"m")]))).toThrow(/unit/);expect(()=>normalizePartnerInput(bundle([row("porosity",120,"percent")]))).toThrow(/exceeds one/);const b=bundle([row("tvd",10000,"ft")]);b.sources[0].sha256="0".repeat(64);expect(()=>normalizePartnerInput(b)).toThrow(/hash mismatch/);});
it("carries cited completion data through the actual report builder",()=>{const r=assembleGold2Draft({api,runId:"test",asOf,attempts:[],title:null,position:null,partner:bundle([row("completion_stages",40,"count"),row("proppant",1000000,"lb"),row("fluid",50000,"bbl")]),reconciliationPolicy:null,economics:null});expect(r.fields["geology.completion_stages"].value).toMatchObject({value:40,unit:"count"});expect(r.fields["geology.proppant"].origin?.pointer).toBe("/measurements/fields/geology.proppant");});
it("maps cited formation tops and provider-reported spatial assessments without inferring nearby-well properties",()=>{
 const tops={...row("formation_tops",0,"m"),value:[{formation:"Synthetic bench",top:3048,base:3078.48}]};
 const r=assembleGold2Draft({api,runId:"test",asOf,attempts:[],title:null,position:null,partner:bundle([tops,row("parent_child","child","classification"),row("interference","provider reports possible interference","reported_assessment"),row("wells_per_section",4,"wells/section")]),economics:null,reconciliationPolicy:null});
 expect(r.fields['geology.formation_tops'].value).toMatchObject({value:[{formation:'Synthetic bench',top:expect.closeTo(10000,6),base:expect.closeTo(10100,6)}],unit:'ft'});
 expect(r.fields['geology.parent_child'].value).toMatchObject({value:'child',unit:'classification'});
});
it("rejects reversed formation intervals and missing depth references",()=>{
 expect(()=>normalizePartnerInput(bundle([{...row('formation_tops',0,'ft'),value:[{formation:'Synthetic',top:100,base:50}]}]))).toThrow(/base precedes/);
 expect(()=>normalizePartnerInput(bundle([{...row('formation_tops',0,'ft'),referencePoint:null,value:[{formation:'Synthetic',top:100,base:150}]}]))).toThrow(/reference/);
});
