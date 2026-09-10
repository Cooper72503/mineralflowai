import {readFileSync} from "node:fs";
import {it,expect} from "vitest";
import {buildDecisionRecord} from "../decision-record";
import {retainedWellContext} from "../gold2/well-context";
const capture=JSON.parse(readFileSync(new URL("../../../../benchmarks/latest-retrieval.json",import.meta.url),"utf8"));
function fixture(api:string){const c=structuredClone(capture.cases.find((x:any)=>x.case.api10===api));return {c,build:()=>buildDecisionRecord({id:c.case.id,original_input:api},c.attempts,"2026-09-10T23:00:00Z")};}
it("recovers Gaines formation, current well number and reported depth from existing retrieval",()=>{const f=fixture("4216502733"),r=retainedWellContext(f.build());expect(r.formation?.value).toBe("DEVONIAN");expect(r.wellNumber.value).toBe("1D");expect(r.reportedDepth?.value).toBe(12040);expect(r.reportedDepth?.basis).toBe("RRC_API_DEPTH_REFERENCE_UNSPECIFIED");});
it("uses the same mapping for Barnett and does not mistake well number for well name",()=>{const f=fixture("4243934308"),r=retainedWellContext(f.build());expect(r.formation?.value).toBe("BARNETT SHALE");expect(r.designation?.label).toBe("WHIZ-Q EAST UNIT #10H");expect(r.designation?.basis).toBe("RRC_LEASE_AND_WELL_NUMBER");});
it("withholds conflicting historical fields instead of selecting the first row",()=>{const f=fixture("4232900028"),r=retainedWellContext(f.build());expect(r.fieldName.value).toBeNull();expect(r.formation).toBeNull();});
it("never fills TVD from an unspecified API depth",()=>{const f=fixture("4216502733"),record=f.build();retainedWellContext(record);expect(record.fields["geology.tvd"].value).toBeNull();});
it("withholds unrecognized formation rather than inventing a match",()=>{const f=fixture("4225500009");expect(retainedWellContext(f.build()).formation).toBeNull();});

it("does not select the first conflicting current field even when lease identifiers match",()=>{const f=fixture("4243934308");const a=f.c.attempts.find((x:any)=>x.source_name==="search_by_api");a.result_data_json.wells.push({...a.result_data_json.wells[0],field_name:"DIFFERENT FIELD"});const r=f.build();expect(r.fields["identity.field"].value).toBeNull();expect(retainedWellContext(r).formation).toBeNull();});
