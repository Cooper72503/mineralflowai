/** Revalue explicitly reviewed alternatives with the SAME cashflow engine.
 * Fractions are never extracted from a finding's prose. Joint cases are not summed. */
import {z} from "zod";
import type {TitleChainAnalysis} from "../title/chain-types";
import {evaluateGold2Economics} from "./economics";
import {ReviewedPositionSchema,linkReviewedMineralPosition} from "../decision-layer/ownership";
export const EvidenceScenariosSchema=z.array(z.object({id:z.string().min(1),findingIds:z.array(z.string().min(1)).min(1),position:ReviewedPositionSchema}).strict()).max(25);
export function evaluateEvidenceScenarios(input:{api:string;title:TitleChainAnalysis|null;position:unknown;partner:unknown|null;economics:unknown|null;scenarios:unknown|null;asOf:string}){
 const missing=(reason:string)=>({scenarios:[],measuredExposure:null,evidenceAdjustedValue:null,riskAdjustedValue:null,reason,method:"reviewed_alternative_position_same_cashflows_v1"});
 if(input.scenarios===null||input.scenarios===undefined)return missing("No reviewed alternative position scenarios were supplied; no adverse fraction or exposure is inferred from narrative.");
 const definitions=EvidenceScenariosSchema.parse(input.scenarios);
 if(!definitions.length)return missing("No reviewed alternative position scenarios were supplied.");
 if(new Set(definitions.map(x=>x.id)).size!==definitions.length)throw Error("Duplicate evidence scenario IDs");
 if(!input.title||input.partner===null||input.economics===null)return missing("Reviewed title, subject forecast and explicit economics are required for evidence scenarios.");
 const baseline=linkReviewedMineralPosition(input.api,input.title,input.position);
 if(baseline.status!=="calculated")return missing(baseline.reason);
 const base=evaluateGold2Economics({...input,partner:input.partner,economics:input.economics});
 const findings=new Set(input.title.findings.map(f=>f.findingId));
 const scenarios=definitions.map(def=>{
  if(new Set(def.findingIds).size!==def.findingIds.length||def.findingIds.some(id=>!findings.has(id)))throw Error("Scenario references duplicate or unknown findings");
  if(def.position.tractId!==baseline.position.tractId||def.position.canonicalPartyId!==baseline.position.canonicalPartyId)throw Error("Evidence scenario changes evaluated tract or owner");
  if(Date.parse(def.position.reviewedAt)>Date.parse(input.asOf))throw Error("Evidence scenario review postdates report");
  const scoped=def.position.sources.some(s=>{const d=s.data as Record<string,unknown>;return d&&d.scenarioId===def.id&&Array.isArray(d.findingIds)&&JSON.stringify([...d.findingIds].sort())===JSON.stringify([...def.findingIds].sort())&&d.basis==="reviewed_alternative_position";});
  if(!scoped)throw Error("Scenario needs hashed reviewed evidence explicitly linking alternative position to its findings");
  const alternative=evaluateGold2Economics({...input,position:def.position,partner:input.partner,economics:input.economics});
  const valueImpactUsd=base.values.base!==null&&alternative.values.base!==null?alternative.values.base-base.values.base:null;
  return {id:def.id,findingIds:def.findingIds,position:def.position,ownership:alternative.scenarios.base.ownership,valueUsd:alternative.values.base,valueImpactUsd,reason:alternative.scenarios.base.reason,
   method:"reviewed_alternative_position_same_cashflows_v1",disclosure:"Conditional reviewed position alternative at unchanged commodity inputs; does not establish claim priority or resolve a closing blocker."};
 });
 // One complete joint alternative can measure exposure. Several alternatives are not additive.
 const complete=scenarios.length===1&&scenarios[0].valueImpactUsd!==null;
 const measuredExposure=complete?Math.max(0,-scenarios[0].valueImpactUsd!):null;
 return {scenarios,measuredExposure,evidenceAdjustedValue:measuredExposure!==null&&base.values.base!==null?base.values.base-measuredExposure:null,
  riskAdjustedValue:measuredExposure!==null&&base.values.downside!==null?base.values.downside-measuredExposure:null,
  reason:complete?null:"Multiple independent or overlapping alternatives require an explicitly reviewed joint scenario; impacts are not summed.",method:"reviewed_alternative_position_same_cashflows_v1"};
}
