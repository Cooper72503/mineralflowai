import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {payloadHash} from "../decision-layer/partner-input";
import {evaluateRoyaltyScenario} from "../decision-layer/scenario";
function fixture(){
 const f=JSON.parse(readFileSync(new URL("../../../../benchmarks/partner-fixtures/matched.json",import.meta.url),"utf8"));
 for(const month of ["2026-01","2026-02"]){
  f.partner.sources[0].data.push({kind:"well_monthly_forecast",volumeBasis:"gross_well",api:"4216502733",forecastId:"synthetic-model",modelVersion:"test-v1",generatedAt:"2025-12-01T00:00:00Z",scenario:"base",month,oil:{value:100,unit:"bbl"},gas:{value:0,unit:"Mcf"}});
  f.partner.observations.push({sourceId:"fixture",pointer:`/${f.partner.sources[0].data.length-1}`});
 }
 const assumptions={id:"synthetic-deal",basis:"user_assumption",providedBy:"Synthetic test",providedAt:"2026-01-01T00:00:00Z",api:"4216502733",positionType:"mineral_royalty",forecastId:"synthetic-model",scenario:"base",nri:{n:"1",d:"8"},from:"2026-01",horizonMonths:2,oilUsdBbl:80,gasUsdMcf:0,revenueTaxFraction:0,monthlyPositionDeductionsUsd:0,annualDiscountFraction:0,minimumValueMarginFraction:0.2,askingPriceUsd:1500};
 f.partner.sources[0].sha256=payloadHash(f.partner.sources[0].data);
 return {...f,assumptions};
}
function refresh(f:ReturnType<typeof fixture>){f.partner.sources[0].sha256=payloadHash(f.partner.sources[0].data);}
describe("partner forecast → explicit royalty scenario",()=>{
 it("calculates the assumed royalty cashflow without applying working-interest LOE",()=>{const f=fixture(),r=evaluateRoyaltyScenario(f.partner,f.assumptions);expect(r.presentValueUsd).toBe(2000);expect(r.maximumPriceUnderAssumptionsUsd).toBe(1600);expect(r.priceComparison).toBe("WITHIN_ASSUMPTION_LIMIT");expect(r.ownershipStatus).toBe("USER_ASSUMPTION_NOT_VERIFIED");expect(r.closingReadiness).toBe("NOT_EVALUATED");});
 it("shows a decision-relevant price change under the same evidence",()=>{const f=fixture();f.assumptions.oilUsdBbl=60;expect(evaluateRoyaltyScenario(f.partner,f.assumptions).priceComparison).toBe("EXCEEDS_ASSUMPTION_LIMIT");});
 it("uses effective annual discounting at each month end",()=>{const f=fixture();f.assumptions.annualDiscountFraction=0.1;expect(evaluateRoyaltyScenario(f.partner,f.assumptions).presentValueUsd).toBeCloseTo(1000/1.1**(1/12)+1000/1.1**(2/12),8);});
 it("withholds value for missing forecast volumes instead of filling zeros",()=>{const f=fixture();f.partner.sources[0].data[3].gas.value=null;refresh(f);expect(evaluateRoyaltyScenario(f.partner,f.assumptions).presentValueUsd).toBeNull();});
 it("rejects an invalid NRI rather than defaulting ownership",()=>{const f=fixture();f.assumptions.nri.d="0";expect(()=>evaluateRoyaltyScenario(f.partner,f.assumptions)).toThrow(/NRI/);});
 it("does not mix model versions or extrapolate past the supplied horizon",()=>{const f=fixture();f.partner.sources[0].data[4].modelVersion="other";refresh(f);expect(evaluateRoyaltyScenario(f.partner,f.assumptions).reason).toMatch(/mixes model/);const g=fixture();g.assumptions.horizonMonths=3;expect(evaluateRoyaltyScenario(g.partner,g.assumptions).presentValueUsd).toBeNull();});
 it("requires gross-well volume basis to avoid applying NRI twice",()=>{const f=fixture();f.partner.sources[0].data[3].volumeBasis="net_interest";refresh(f);expect(()=>evaluateRoyaltyScenario(f.partner,f.assumptions)).toThrow();});
});
