/** Reuses conditional cash-flow engine with recomputed reviewed NRI, never caller-supplied NRI. */
import type {TitleChainAnalysis} from "../title/chain-types";
import {linkReviewedMineralPosition} from "./ownership";
import {DealAssumptionsSchema,evaluateRoyaltyScenario} from "./scenario";
export const ReviewedDealAssumptionsSchema=DealAssumptionsSchema.omit({nri:true,api:true,positionType:true});
export function evaluateReviewedRoyaltyScenario(input:{api:string;title:TitleChainAnalysis|null;position:unknown;partner:unknown;assumptions:unknown}){
 const ownership=linkReviewedMineralPosition(input.api,input.title,input.position);
 if(ownership.status!=="calculated")return {status:"insufficient_data" as const,reason:ownership.reason,ownership,scenario:null};
 const assumptions=ReviewedDealAssumptionsSchema.parse(input.assumptions);
 const scenario=evaluateRoyaltyScenario(input.partner,{...assumptions,api:input.api,positionType:"mineral_royalty",nri:ownership.nri});
 return {status:scenario.status,reason:scenario.reason,ownership,scenario:{...scenario,
  ownershipStatus:"REVIEWED_APPARENT_POSITION",ownershipCalculation:ownership.method,
  limitations:["NRI is recomputed from the selected reviewed title holding and cited acreage/royalty terms; all price, tax, timing, deduction and buyer inputs remain supplied assumptions.","Cash-flow computation does not resolve title exceptions or authorize closing.",...(scenario.status==="calculated"?scenario.limitations.filter(x=>!x.startsWith("Conditional scenario value")):[])],
 }};
}
