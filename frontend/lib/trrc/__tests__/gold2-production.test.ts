import {it,expect} from "vitest";
import {payloadHash} from "../decision-layer/partner-input";
import {shiftMonth,subjectProductionMetrics,subjectForecastMetrics} from "../gold2/production";
const api="4216502733",asOf="2026-09-10T00:00:00Z";
function bundle(rows:unknown[]){return {contract:"mineralflow-partner-production-0.1",mode:"synthetic_fixture",sources:[{id:"fixture",provider:"Synthetic test",url:"https://example.invalid/data",retrievedAt:asOf,sha256:payloadHash(rows),data:rows}],observations:rows.map((_,i)=>({sourceId:"fixture",pointer:`/${i}`}))};}
function production(){return Array.from({length:24},(_,i)=>({kind:"well_monthly_production",api,lease:"123",district:"8A",month:shiftMonth("2024-09",i),oil:{value:(i<12?100:50) as number|null,unit:"bbl"},gas:{value:0,unit:"Mcf"}}));}
function forecast(){return Array.from({length:12},(_,i)=>({kind:"well_monthly_forecast",volumeBasis:"gross_well",api,forecastId:"test",scenario:"base",modelVersion:"v1",generatedAt:"2026-09-01T00:00:00Z",month:shiftMonth("2026-10",i),oil:{value:100,unit:"bbl"},gas:{value:0,unit:"Mcf"}}));}
const selection={api,forecastId:"test",scenario:"base" as const,from:"2026-10",asOf};
it("uses full calendar years and preserves observed zero gas",()=>{const r=subjectProductionMetrics(bundle(production()),api,asOf);expect(r.oil.value).toBe(600);expect(r.gas.value).toBe(0);expect(r.yoyOilDeclinePct).toBe(50);expect(r.through).toBe("2026-08");});
it("does not fill missing oil from a complete gas history",()=>{const rows=production();rows[20].oil.value=null;const r=subjectProductionMetrics(bundle(rows),api,asOf);expect(r.oil.value).toBeNull();expect(r.gas.value).toBe(0);expect(r.yoyOilDeclinePct).toBeNull();});
it("excludes unfinished current month and other wells",()=>{const rows=production();rows.push({...rows[0],month:"2026-09",oil:{value:999,unit:"bbl"}},{...rows[23],api:"4243934308"});expect(subjectProductionMetrics(bundle(rows),api,asOf).oil.value).toBe(600);});
it("sums cited forecast months without changing the model",()=>{const r=subjectForecastMetrics(bundle(forecast()),selection);expect(r.next12Oil.value).toBe(1200);expect(r.next12Gas.value).toBe(0);expect(r.modelVersion).toBe("v1");});
it("distinguishes a short supplied horizon from a next-12 forecast",()=>{const r=subjectForecastMetrics(bundle(forecast().slice(0,2)),selection);expect(r.remainingOil.value).toBe(200);expect(r.next12Oil.value).toBeNull();});
it("rejects missing internal months and mixed forecast versions",()=>{const rows=forecast();rows.splice(5,1);expect(subjectForecastMetrics(bundle(rows),selection).remainingOil.value).toBeNull();const mixed=forecast();mixed[4].modelVersion="v2";expect(subjectForecastMetrics(bundle(mixed),selection).next12Oil.value).toBeNull();});
it("rejects a forecast generated after the report date",()=>{const rows=forecast();for(const r of rows)r.generatedAt="2026-09-11T00:00:00Z";expect(subjectForecastMetrics(bundle(rows),selection).next12Oil.value).toBeNull();});
