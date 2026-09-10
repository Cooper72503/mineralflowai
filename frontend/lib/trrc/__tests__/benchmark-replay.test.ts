import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildDecisionRecord, validateDecisionRecord, REQUIRED_DECISION_FIELDS } from "../decision-record";
import { normalizeApiNumber } from "../normalization";
import type { LiteSourceAttempt } from "../coverage";
const captured = JSON.parse(readFileSync(new URL("../../../../benchmarks/latest-retrieval.json", import.meta.url), "utf8")) as {
 cases: {case:{id:string;api10:string};attempts:LiteSourceAttempt[]}[];
};
describe("real Texas API benchmark — captured responses, no live network",()=>{
 it("contains ten distinct, structurally valid real RRC identifiers",()=>{
  expect(captured.cases).toHaveLength(10);
  // The fixture must exercise observed facts, not just validate empty records.
  expect(captured.cases.filter(c=>c.attempts.some(a=>a.source_name==="fetch_gis_plat" && a.status==="success"))).toHaveLength(9);
  expect(new Set(captured.cases.map(c=>c.case.api10)).size).toBe(10);
  for(const c of captured.cases)expect(normalizeApiNumber(c.case.api10)?.api10).toBe(c.case.api10);
 });
 it.each(captured.cases)("$case.id produces all fields with valid provenance or explicit gaps",c=>{
  const record=buildDecisionRecord({id:c.case.id,original_input:c.case.api10},c.attempts,new Date(Math.max(...c.attempts.map(a=>Date.parse(a.attempted_at)))+1000).toISOString());
  expect(validateDecisionRecord(record)).toEqual([]);
  expect(Object.keys(record.fields)).toHaveLength(REQUIRED_DECISION_FIELDS.length);
  const gis=c.attempts.find(a=>a.source_name==="fetch_gis_plat")!;
  const gisStatus=gis.status==="success" && gis.result_data_json?.found ? "observed" : "unavailable";
  expect(record.fields["geology.latitude"].status).toBe(gisStatus);
  expect(record.fields["geology.longitude"].status).toBe(gisStatus);
  expect(record.fields["geology.map_symbol"].status).toBe(gisStatus);
  const production=c.attempts.find(a=>a.source_name==="fetch_production")!;
  const scopeMatches=record.fields["identity.lease"].value===production.result_data_json?.lease_number && record.fields["identity.district"].value===production.result_data_json?.district;
  expect(record.fields["production.lease_monthly"].status).toBe(production.status!=="success"?"unavailable":scopeMatches?"observed":"insufficient_data");
  expect(record.fields["production.subject_monthly"].value).toBeNull();
  expect(record.fields["ownership.nri"].value).toBeNull();
  expect(record.fields["decision.posture"].value).toBe("INSUFFICIENT_DATA");
  if(process.env.MINERALFLOW_EXPORT_BENCHMARK==="1"){
    const directory=new URL("../../../../benchmarks/decision-records/",import.meta.url);
    mkdirSync(directory,{recursive:true});writeFileSync(new URL(`${c.case.id}.json`,directory),JSON.stringify(record,null,2)+"\n");
  }
 });
});

it("recovers the permit-symbol case using its current gas association without overwriting the outage capture", () => {
 const recovery=JSON.parse(readFileSync(new URL("../../../../benchmarks/recheck-permit-only.json",import.meta.url),"utf8")).cases[0] as typeof captured.cases[number];
 const record=buildDecisionRecord({id:"permit-recheck",original_input:recovery.case.api10},recovery.attempts);
 expect(validateDecisionRecord(record)).toEqual([]);
 expect(record.fields["identity.lease"].value).toBe("131160");
 expect(record.fields["production.lease_monthly"].status).toBe("observed");
 expect(captured.cases.find(c=>c.case.id==="permit-only")!.attempts.find(a=>a.source_name==="fetch_gis_plat")!.status).toBe("failed_transient");
});
