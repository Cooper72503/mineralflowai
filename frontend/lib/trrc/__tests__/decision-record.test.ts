import { describe,it,expect } from "vitest";
import { buildDecisionRecord,validateDecisionRecord,REQUIRED_DECISION_FIELDS } from "../decision-record";
import type { LiteSourceAttempt } from "../coverage";
const run={id:"test",original_input:"42-165-02733"};
const attempt:LiteSourceAttempt={source_id:"wb-1",source_name:"search_by_api",status:"success",result_count:1,error_message:null,attempted_at:"2026-09-09T00:00:00Z",result_data_json:{found:true,wells:[{api_no:"16502733",county:"GAINES",lease_no:"10289",district:"8A"}]}};
describe("Decision Record evidence contract",()=>{
 it("every field is explicitly represented even during a complete source outage",()=>{
  const record=buildDecisionRecord(run,[]);
  expect(Object.keys(record.fields)).toHaveLength(REQUIRED_DECISION_FIELDS.length);
  expect(validateDecisionRecord(record)).toEqual([]);
  expect(record.fields["decision.posture"].value).toBe("INSUFFICIENT_DATA");
  expect(record.fields["ownership.nri"].value).toBeNull();
  expect(record.fields["economics.base_value"].value).toBeNull();
 });
 it("traces observed facts and recomputes the normalized identity from cited evidence",()=>{
  const record=buildDecisionRecord(run,[attempt]);
  expect(record.fields["identity.api10"].value).toBe("4216502733");
  expect(record.fields["identity.county"].value).toBe("GAINES");
  expect(validateDecisionRecord(record)).toEqual([]);
  record.fields["identity.county"].value="MIDLAND";
  expect(validateDecisionRecord(record)).toContain("Unsubstantiated observation identity.county");
 });
 it("rejects altered evidence, dangling citations, omitted fields and nonfinite numbers",()=>{
  const record=buildDecisionRecord(run,[attempt]);
  record.evidence[0].sha256="tampered";
  record.fields["identity.api10"].citations[0].evidenceId="missing";
  record.fields["identity.county"].value=Infinity;
  delete (record.fields as Partial<typeof record.fields>)["ownership.nri"];
  expect(validateDecisionRecord(record).length).toBeGreaterThanOrEqual(4);
 });
 it("does not use a stale success after a failed refresh or attach another well's identity",()=>{
  const newer={...attempt,source_id:"wb-2",attempted_at:"2026-09-10T00:00:00Z",status:"failed_transient"};
  expect(buildDecisionRecord(run,[attempt,newer]).fields["identity.county"].status).toBe("unavailable");
  expect(buildDecisionRecord({...run,original_input:"4243934308"},[attempt]).fields["identity.api10"].status).toBe("unavailable");
 });
});

it("does not attach production from a different lease association", () => {
  const production={...attempt,source_id:"prod",source_name:"fetch_production",result_data_json:{found:true,lease_number:"OTHER",district:"8A",rows:[{production_month:"2026-01",oil_bbl:100}]}};
  const record=buildDecisionRecord(run,[attempt,production]);
  expect(record.fields["production.lease_monthly"].status).toBe("insufficient_data");
  expect(record.fields["production.lease_monthly"].value).toBeNull();
});
it("rejects an API derivation that matches evidence but differs from the requested well", () => {
  const record=buildDecisionRecord(run,[attempt]);
  record.input="4243934308";
  expect(validateDecisionRecord(record)).toContain("Invalid API derivation identity.api10");
});
