/** Explicit implementation predicates. Sample-defined R-03/R-07/R-11 and C-02
 * semantics are retained. Other predicates below are implementation definitions,
 * not an assertion that undisclosed sample source code has been recovered. */
export interface Gold2RuleInput {
 identityResolved:boolean;positionIdentified:boolean;nriComputable:boolean;
 baseValue:number|null;askingPrice:number|null;measuredExposure:number|null;
 exceptions:{id:string;closingBlocker:boolean;resolved:boolean;measuredImpact:number|null;decisionMaterial:boolean}[];
 productionReconciled:boolean|null;reviewItemsOpen:number;titleEvidenceSufficient:boolean;
 confidenceDomains:{domain:string;level:"INSUFFICIENT_DATA"|"LOW"|"MEDIUM"|"HIGH";decisionMaterial:boolean;reason:string}[];
}
export function evaluateGold2Rules(input:Gold2RuleInput){
 for(const v of [input.baseValue,input.askingPrice,input.measuredExposure,...input.exceptions.map(e=>e.measuredImpact)])if(v!==null&&!Number.isFinite(v))throw Error("Nonfinite rule input");
 if(!Number.isInteger(input.reviewItemsOpen)||input.reviewItemsOpen<0)throw Error("Invalid review count");
 const blockers=input.exceptions.filter(e=>e.closingBlocker&&!e.resolved);
 const unpriced=blockers.filter(e=>e.measuredImpact===null);
 const definitions=[
  {id:"R-01",match:!input.identityResolved,posture:"INSUFFICIENT_DATA",reason:"Subject identity is unresolved."},
  {id:"R-02",match:!input.positionIdentified,posture:"INSUFFICIENT_DATA",reason:"Evaluated position is not identified."},
  {id:"R-03",match:!input.nriComputable,posture:"INSUFFICIENT_DATA",reason:"Evidenced NRI is not computable."},
  {id:"R-04",match:input.baseValue===null,posture:"INSUFFICIENT_DATA",reason:"Position value cannot be computed."},
  {id:"R-05",match:input.baseValue!==null&&input.baseValue<=0,posture:"PASS",reason:"Modeled position value is nonpositive."},
  {id:"R-06",match:input.askingPrice!==null&&input.baseValue!==null&&input.askingPrice>=input.baseValue,posture:"PASS",reason:"Asking price leaves no margin at base value."},
  {id:"R-07",match:unpriced.length>0,posture:"HOLD_FOR_DILIGENCE",reason:"An unresolved closing blocker has no measured impact."},
  {id:"R-08",match:blockers.length>0,posture:"HOLD_FOR_DILIGENCE",reason:"Measured closing blockers still require resolution; price does not cure them."},
  {id:"R-09",match:!input.titleEvidenceSufficient,posture:"HOLD_FOR_DILIGENCE",reason:"Reviewed title evidence is insufficient."},
  {id:"R-10",match:input.reviewItemsOpen>0,posture:"HOLD_FOR_DILIGENCE",reason:"Open review items require diligence."},
  {id:"R-11",match:input.productionReconciled!==true,posture:"HOLD_FOR_DILIGENCE",reason:"Production reconciliation is unresolved or exceeds its supplied threshold."},
  {id:"R-12",match:true,posture:"PURSUE_REVIEW",reason:"Evaluated prerequisites support continued acquisition review; no closing authorization is issued."},
 ];
 const first=definitions.findIndex(r=>r.match);
 const trace=definitions.map((r,i)=>({id:r.id,outcome:i>first?"NOT_REACHED":r.match?"MATCH":"NO_MATCH",reason:r.reason}));
 const closing=!input.positionIdentified||!input.titleEvidenceSufficient?{rule:"C-01",state:"INSUFFICIENT_DATA"}:unpriced.length?{rule:"C-02",state:"NOT_READY"}:blockers.length?{rule:"C-03",state:"NOT_READY"}:input.reviewItemsOpen?{rule:"C-04",state:"NOT_READY"}:{rule:"C-05",state:"READY_FOR_PROFESSIONAL_REVIEW"};
 const levels=["INSUFFICIENT_DATA","LOW","MEDIUM","HIGH"];
 const material=input.confidenceDomains.filter(d=>d.decisionMaterial);
 const rank=material.length?Math.min(...material.map(d=>levels.indexOf(d.level))):0;
 if(rank<0||input.confidenceDomains.some(d=>!d.reason.trim()))throw Error("Invalid confidence domain evidence");
 return {rulesetVersion:"2.0.0",posture:definitions[first].posture,matchedRule:definitions[first].id,trace,closing,confidence:levels[rank],confidenceCaps:material.filter(d=>d.level===levels[rank]).map(d=>d.domain)};
}
