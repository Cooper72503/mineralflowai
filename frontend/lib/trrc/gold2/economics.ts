/** GOLD commodity comparison: one reviewed ownership position and one forecast,
 * changing only the explicitly supplied commodity prices. Reuses existing cash-flow engine. */
import {z} from "zod";
import type {TitleChainAnalysis} from "../title/chain-types";
import {evaluateReviewedRoyaltyScenario,ReviewedDealAssumptionsSchema} from "../decision-layer/reviewed-scenario";
const price=z.object({oilUsdBbl:z.number().finite().nonnegative(),gasUsdMcf:z.number().finite().nonnegative()}).strict();
export const Gold2EconomicsInputSchema=z.object({
 assumptions:ReviewedDealAssumptionsSchema,
 priceDeck:z.object({base:price,downside:price,upside:price}).strict(),
 sensitivity:z.object({oil:z.array(z.number().finite().nonnegative()).min(1).max(15),gas:z.array(z.number().finite().nonnegative()).min(1).max(15)}).strict(),
 underwriteBasis:z.enum(["base","downside"]),
}).strict();
export function evaluateGold2Economics(input:{api:string;title:TitleChainAnalysis|null;position:unknown;partner:unknown;economics:unknown}){
 const settings=Gold2EconomicsInputSchema.parse(input.economics);
 if(new Set(settings.sensitivity.oil).size!==settings.sensitivity.oil.length||new Set(settings.sensitivity.gas).size!==settings.sensitivity.gas.length)throw Error("Duplicate sensitivity price coordinates");
 const calculate=(p:z.infer<typeof price>)=>evaluateReviewedRoyaltyScenario({...input,assumptions:{...settings.assumptions,...p}});
 const scenarios={base:calculate(settings.priceDeck.base),downside:calculate(settings.priceDeck.downside),upside:calculate(settings.priceDeck.upside)};
 const values=Object.fromEntries(Object.entries(scenarios).map(([name,r])=>[name,r.scenario?.presentValueUsd??null])) as Record<"base"|"downside"|"upside",number|null>;
 const sensitivity=settings.sensitivity.oil.flatMap(oil=>settings.sensitivity.gas.map(gas=>{
  const r=calculate({oilUsdBbl:oil,gasUsdMcf:gas});
  return {oilUsdBbl:oil,gasUsdMcf:gas,valueUsd:r.scenario?.presentValueUsd??null,status:r.status,reason:r.reason};
 }));
 const underwrite=values[settings.underwriteBasis],margin=settings.assumptions.minimumValueMarginFraction;
 const maximumBuyPrice=underwrite!==null&&underwrite>0&&margin!==null?underwrite*(1-margin):null;
 return {method:"same_cashflow_engine_fixed_ownership_price_grid_v1",settings,scenarios,values,sensitivity,maximumBuyPrice,
 maximumBuyPriceReason:maximumBuyPrice!==null?null:margin===null?"Buyer minimum-margin criterion was not supplied.":underwrite===null?"Selected underwriting value is unavailable.":"Selected underwriting value is nonpositive.",
 // Evidence-adjusted scenarios are a separate calculation and cannot be silently treated as commodity downside.
 evidenceAdjustedValue:null,riskAdjustedValue:null,measuredExposure:null,
 evidenceAdjustmentReason:"No validated, nonoverlapping measured-exposure schedule is attached to this calculation.",
 disclosures:["Commodity scenarios and grid use the same forecast ID, forecast scenario, model, ownership and non-price assumptions.","Downside/upside are supplied price-deck labels, not probabilistic confidence intervals.","Buyer margin is (underwriting value minus purchase price) divided by underwriting value.","No sensitivity cell overrides independent title or closing blockers."]};
}
