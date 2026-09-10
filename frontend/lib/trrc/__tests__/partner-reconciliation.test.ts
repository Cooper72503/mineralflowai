import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {buildDecisionRecord} from "../decision-record";
import {normalizePartnerInput,payloadHash} from "../decision-layer/partner-input";
import {reconcilePartnerProduction} from "../decision-layer/reconcile";
const fixture=()=>JSON.parse(readFileSync(new URL("../../../../benchmarks/partner-fixtures/matched.json",import.meta.url),"utf8"));
function run(f=fixture()){
 const record=buildDecisionRecord({id:"synthetic",original_input:f.regulator.case.api10},f.regulator.attempts);
 return reconcilePartnerProduction(record,f.partner,f.policy);
}
function change(f:ReturnType<typeof fixture>,fn:(rows:any[])=>void){fn(f.partner.sources[0].data);f.partner.sources[0].sha256=payloadHash(f.partner.sources[0].data);}
describe("partner → MineralFlow reconciliation contract",()=>{
 it("converts units and compares complete lease populations",()=>{const r=run();expect(r.oil.vendorTotal).toBe(200);expect(r.gas.vendorTotal).toBe(400);expect(r.decisionEffect).toBe("RECONCILIATION_PASSED");expect(r.acquisitionDecision).toBe("NOT_EVALUATED");expect(r.mode).toBe("synthetic_fixture");expect(r.oil.partnerCitations).toHaveLength(3);});
 it("flags contradictory volumes without pricing the discrepancy",()=>{const f=fixture();change(f,d=>{d[1].oil.value=0.3;});expect(run(f).oil.variancePercent).toBe(100);expect(run(f).decisionEffect).toBe("REVIEW_SOURCE_CONTRADICTION");});
 it.each(["partial","unknown"])("withholds comparison for %s membership",completeness=>{const f=fixture();change(f,d=>{d[0].completeness=completeness;});expect(run(f).oil.status).toBe("insufficient_data");});
 it("does not substitute zero for missing gas or block complete oil",()=>{const f=fixture();change(f,d=>{d[1].gas.value=null;});expect(run(f).gas.vendorTotal).toBeNull();expect(run(f).oil.status).toBe("matched");});
 it("rejects duplicate well months and unsupported units",()=>{const f=fixture();f.partner.observations.push(f.partner.observations[1]);expect(()=>normalizePartnerInput(f.partner)).toThrow(/Duplicate/);const g=fixture();change(g,d=>{d[1].oil.unit="tons";});expect(()=>normalizePartnerInput(g.partner)).toThrow();});
 it("rejects tampered source snapshots and dangling citations",()=>{const f=fixture();f.partner.sources[0].sha256="0".repeat(64);expect(()=>normalizePartnerInput(f.partner)).toThrow(/hash mismatch/);const g=fixture();g.partner.observations[1].pointer="/missing";expect(()=>normalizePartnerInput(g.partner)).toThrow();});
 it("requires all lease members for every reporting month",()=>{const f=fixture();f.partner.observations.pop();expect(run(f).oil.reason).toMatch(/Missing oil observation/);});
 it("does not choose the first overlapping membership assertion",()=>{const f=fixture();f.partner.observations.push(f.partner.observations[0]);expect(run(f).oil.status).toBe("insufficient_data");});
 it("handles zero denominators without infinite or fabricated percentages",()=>{const f=fixture();f.regulator.attempts[1].result_data_json.rows[0].oil_bbl=0;change(f,d=>{d[1].oil.value=0;d[2].oil.value=0;});expect(run(f).oil.variancePercent).toBe(0);change(f,d=>{d[1].oil.value=0.1;});expect(run(f).oil.variancePercent).toBeNull();expect(run(f).oil.status).toBe("contradiction");});
});
