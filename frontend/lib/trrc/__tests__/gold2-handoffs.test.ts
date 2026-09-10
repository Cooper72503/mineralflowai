import {readFileSync} from "node:fs";
import {payloadHash} from "../decision-layer/partner-input";
import {it,expect} from "vitest";
import {reviewedPositionFixture} from "./fixtures/reviewed-position";
import {evaluateGold2Economics} from "../gold2/economics";
import {assembleGold2Draft,validateGold2Draft,type Gold2Input} from "../gold2/assemble";
function fixture(){
 const f=JSON.parse(readFileSync(new URL("../../../../benchmarks/partner-fixtures/scenario.json",import.meta.url),"utf8"));
 for(const source of f.partner.sources){
  for(const row of source.data)if(row.kind==="well_monthly_forecast")row.month=row.month==="2026-01"?"2026-10":"2026-11";
  source.sha256=payloadHash(source.data);
 }
 f.assumptions.from="2026-10";
 const {title,position}=reviewedPositionFixture();
 const {nri,api,positionType,...assumptions}=f.assumptions;
 const economics={assumptions,priceDeck:{base:{oilUsdBbl:80,gasUsdMcf:0},downside:{oilUsdBbl:60,gasUsdMcf:0},upside:{oilUsdBbl:100,gasUsdMcf:0}},sensitivity:{oil:[60,80,100],gas:[0]},underwriteBasis:"base"};
 return {f,title,position,economics};
}
it("connects reviewed NRI to the existing forecast cashflow engine and fixed-ownership grid",()=>{
 const x=fixture();const r=evaluateGold2Economics({api:"4216502733",...x,partner:x.f.partner});
 // Two months, 100 bbl each, NRI 3/256, zero discount/tax/deductions.
 expect(r.values.base).toBe(187.5);expect(r.values.downside).toBe(140.625);expect(r.values.upside).toBe(234.375);
 expect(r.maximumBuyPrice).toBe(150);expect(r.sensitivity.map(c=>c.valueUsd)).toEqual([140.625,187.5,234.375]);
 expect(r.scenarios.base.scenario?.ownershipStatus).toBe("REVIEWED_APPARENT_POSITION");
});
it("does not permit supplied NRI to overwrite the reviewed title result",()=>{
 const x=fixture();expect(()=>evaluateGold2Economics({api:"4216502733",...x,partner:x.f.partner,economics:{...x.economics,assumptions:{...x.economics.assumptions,nri:{n:"1",d:"1"}}}})).toThrow();
});
it("integrates source, ownership, reconciliation, economics and rules, while retaining draft status",()=>{
 const x=fixture();const input:Gold2Input={api:"4216502733",asOf:"2026-09-10T12:00:00Z",runId:"test",attempts:x.f.regulator.attempts,title:x.title,position:x.position,partner:x.f.partner,reconciliationPolicy:x.f.policy,economics:x.economics};
 const r=assembleGold2Draft(input);expect(r.state).toBe("draft_not_validated");expect(r.fields["ownership.nri"].value).toEqual({n:"3",d:"256"});expect(r.fields["economics.base_value"].value).toBe(187.5);expect(validateGold2Draft(r)).toEqual([]);
 r.fields["economics.base_value"].value=99999;expect(validateGold2Draft(r)).not.toEqual([]);
});

it("rejects an old valuation start instead of presenting its value as current",()=>{const x=fixture();x.economics.assumptions.from="2026-01";expect(()=>assembleGold2Draft({api:"4216502733",asOf:"2026-09-10T12:00:00Z",runId:"test",attempts:x.f.regulator.attempts,title:x.title,position:x.position,partner:x.f.partner,reconciliationPolicy:x.f.policy,economics:x.economics})).toThrow(/Valuation start precedes/);});
