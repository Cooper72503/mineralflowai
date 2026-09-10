import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {assembleGoldRecord,validateGoldRecord} from "../gold/assemble";
import {GOLD_SECTIONS} from "../gold/sections";
import {REQUIRED_DECISION_FIELDS} from "../decision-record";
import {renderGoldPdf} from "../gold/pdf";
import type {LiteSourceAttempt} from "../coverage";
const captured=JSON.parse(readFileSync(new URL("../../../../benchmarks/latest-retrieval.json",import.meta.url),"utf8")) as {cases:{case:{id:string;api10:string};attempts:LiteSourceAttempt[]}[]};
const build=(c= captured.cases[0])=>assembleGoldRecord({id:c.case.id,original_input:c.case.api10},c.attempts,"2026-09-10T00:00:00Z");
describe("GOLD report contract",()=>{
 it("maps every required field into the eighteen sections",()=>{
  expect(GOLD_SECTIONS).toHaveLength(18);
  expect(new Set(GOLD_SECTIONS.map(s=>s.id)).size).toBe(18);
  expect([...new Set(GOLD_SECTIONS.flatMap(s=>s.fields))].sort()).toEqual([...REQUIRED_DECISION_FIELDS].sort());
 });
 it.each(captured.cases)("$case.id validates and renders the same GOLD evidence record",async c=>{
  const gold=build(c);
  expect(validateGoldRecord(gold)).toEqual([]);
  const pdf=await renderGoldPdf(gold);
  expect(pdf.subarray(0,5).toString()).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(20000);
  expect(gold.record.fields["production.subject_monthly"].value).toBeNull();
  expect(gold.record.fields["economics.base_value"].value).toBeNull();
 },30000);
 it("exercises the actual existing decline engine on observed lease data",()=>{
  const records=captured.cases.map(build);
  // The retained oil history does not support a fit; do not force one.
  expect(records.find(r=>r.record.run_id==="gaines-oil")!.screening.oil.status).toBe("insufficient_data");
  expect(records.some(r=>r.screening.gas.status==="calculated")).toBe(true);
  for(const record of records)for(const stream of Object.values(record.screening)){
   expect(stream.scope).toBe("lease");
   if(stream.status==="calculated"){
    expect(stream.citations.length).toBeGreaterThan(0);
    expect(stream.next12).toBeGreaterThanOrEqual(0);
    expect(stream.forecastRemaining).toBeGreaterThanOrEqual(stream.next12!);
   }
  }
 });
 it("hands complete oil history to the existing engine and rejects an internal gap",()=>{
  // Deliberately synthetic engine fixture, separate from real API benchmarks.
  const c=structuredClone(captured.cases.find(c=>c.case.id==="gaines-oil")!);
  const production=c.attempts.find(a=>a.source_name==="fetch_production")!;
  const rows=Array.from({length:18},(_,i)=>({production_month:new Date(Date.UTC(2024,i,1)).toISOString().slice(0,7),oil_bbl:10000*Math.exp(-0.03*i),gas_mcf:null,casinghead_gas_mcf:null,condensate_bbl:null,water_bbl:null}));
  production.result_data_json!.rows=rows;
  const gold=build(c);
  expect(gold.screening.oil.status).toBe("calculated");
  expect(gold.screening.oil.next12).toBeGreaterThan(0);
  expect(validateGoldRecord(gold)).toEqual([]);
  production.result_data_json!.rows=rows.filter((_,i)=>i!==5);
  expect(build(c).screening.oil.reason).toMatch(/internal reporting months/);
 });
 it("rejects tampered gate outcomes, coverage, assumptions and forecasts",()=>{
  const section=build();section.sections[0].fields=[];
  expect(validateGoldRecord(section)).toContain("GOLD section contract mismatch");
  expect(build().sections[0].fields.length).toBeGreaterThan(0);
  const gate=build();gate.rules[0].outcome=gate.rules[0].outcome==="available"?"missing_input":"available";
  expect(validateGoldRecord(gate)).toContain("Invalid GOLD decision gate derivation");
  const coverage=build();coverage.coverage[0].records_found+=1;
  expect(validateGoldRecord(coverage)).toContain("Invalid GOLD coverage derivation");
  const assumptions=build();assumptions.limitations=[];
  expect(validateGoldRecord(assumptions)).toContain("GOLD limitations mismatch");
  const forecast=build();forecast.screening.oil.next12=1234567;
  expect(validateGoldRecord(forecast)).toContain("Invalid oil lease-screening derivation");
 });
 it("discloses all unqueried sources and produces no invented values for empty retrieval",()=>{
  const gold=assembleGoldRecord({id:"empty",original_input:"4216502733"},[],"2026-09-10T00:00:00Z");
  expect(validateGoldRecord(gold)).toEqual([]);
  expect(gold.coverage.every(c=>c.status==="not_checked")).toBe(true);
  expect(gold.rules.every(r=>r.outcome==="missing_input")).toBe(true);
  expect(Object.values(gold.record.fields).filter(f=>f.status==="observed")).toHaveLength(0);
 });
});
