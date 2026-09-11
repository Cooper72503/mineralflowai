import {describe,it,expect} from "vitest";
import {gold2Acceptance,GOLD2_FIELDS,GOLD2_CHARTS,type Gold2AcceptanceCandidate} from "../gold2/contract";
import {evaluateGold2Rules,type Gold2RuleInput} from "../gold2/rules";
const input=():Gold2RuleInput=>({identityResolved:true,positionIdentified:true,nriComputable:true,baseValue:47679,askingPrice:null,measuredExposure:5298,exceptions:[{id:"E-02",closingBlocker:true,resolved:false,measuredImpact:null,decisionMaterial:true}],productionReconciled:false,reviewItemsOpen:0,titleEvidenceSufficient:true,confidenceDomains:[{domain:"title",level:"LOW",decisionMaterial:true,reason:"Unread instruments"},{domain:"forecast",level:"MEDIUM",decisionMaterial:true,reason:"Cited vendor model"}]});
describe("GOLD2 rules and acceptance",()=>{
 it("reproduces the sample R-07 hold, independent C-02 not-ready and lowest material confidence",()=>{const r=evaluateGold2Rules(input());expect(r.matchedRule).toBe("R-07");expect(r.closing).toEqual({rule:"C-02",state:"NOT_READY"});expect(r.confidence).toBe("LOW");expect(r.trace.find(t=>t.id==="R-08")!.outcome).toBe("NOT_REACHED");});
 it("does not let price classification erase closing blockers",()=>{const i=input();i.askingPrice=50000;const r=evaluateGold2Rules(i);expect(r.posture).toBe("PASS");expect(r.closing.state).toBe("NOT_READY");});
 it("withholds posture when NRI is not computable",()=>{const i=input();i.nriComputable=false;expect(evaluateGold2Rules(i).matchedRule).toBe("R-03");});
 it("does not allow an immaterial low-confidence domain to cap the result",()=>{const i=input();i.confidenceDomains[0].decisionMaterial=false;expect(evaluateGold2Rules(i).confidence).toBe("MEDIUM");});
 it("routes an otherwise supported case to production reconciliation review",()=>{const i=input();i.exceptions=[];expect(evaluateGold2Rules(i).matchedRule).toBe("R-11");});
 it("rejects a legacy render even when every legacy test passed",()=>{
  const c:Gold2AcceptanceCandidate={schemaVersion:"1.0.0",rulesetVersion:"1.0.0",api:"4216502733",fields:{},charts:[],sections:[],audit:{evidenceValid:true,calculationsRecomputed:false,rulesRecomputed:false,renderInspected:true,engineHandoffsComplete:false}};
  const errors=gold2Acceptance(c);expect(errors).toContain("GOLD2 version contract not satisfied");expect(errors).toContain("GOLD2 audit gate failed: engineHandoffsComplete");expect(errors.some(e=>e.includes("ownership.nri"))).toBe(true);
 });
 it("requires declared reasons and rejects unconnected engines as unavailable-data explanations",()=>{
  const c:Gold2AcceptanceCandidate={schemaVersion:"2.0.0",rulesetVersion:"2.0.0",api:"4216502733",fields:Object.fromEntries(GOLD2_FIELDS.map(k=>[k,{status:"unavailable",value:null,reason:"Adapter not built",reasonCode:"engine_not_connected",validated:true}])),charts:GOLD2_CHARTS.map(c=>({id:c.id,status:"unavailable",inputFields:[...c.fields],reason:"No data",validated:true})),sections:[...Array.from({length:15},(_,i)=>String(i+1).padStart(2,"0")),"A","A1","A2"],audit:{evidenceValid:true,calculationsRecomputed:true,rulesRecomputed:true,renderInspected:true,engineHandoffsComplete:false}};
  expect(gold2Acceptance(c).filter(e=>e.startsWith("Unjustified unavailable field"))).toHaveLength(GOLD2_FIELDS.length);
 });
});
it("does not advance an otherwise supported case beyond a missing or breached buyer limit",()=>{
 const i=input();i.exceptions=[];i.productionReconciled=true;
 expect(evaluateGold2Rules(i).matchedRule).toBe('R-12');
 i.maximumBuyPrice=30000;i.askingPrice=35000;
 expect(evaluateGold2Rules(i).posture).toBe('CONDITIONAL_REVIEW');
 expect(evaluateGold2Rules(i).closing.state).toBe('READY_FOR_PROFESSIONAL_REVIEW');
});
