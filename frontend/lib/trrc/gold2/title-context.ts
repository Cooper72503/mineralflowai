/** Connect the supplied exception engine to the selected, retained title scope. */
import type {TitleChainAnalysis} from "../title/chain-types";
import {buildExceptionImpacts,type Quantifier} from "../title/exception-impact";
import {normalizeApiNumber} from "../normalization";
export function titleDecisionContext(title:TitleChainAnalysis|null,api:string,tractId:string|null,quantifiers:Record<string,Quantifier>={}){
 if(!title)return {exceptions:null,uncitedFindings:[],evidenceSufficient:false,reviewItemsOpen:0,reason:"No published title analysis accompanies this API.",actions:["Obtain and review tract-specific instruments and select the offered ownership position."],scope:null};
 const wells=title.wells.filter(w=>normalizeApiNumber(w.api14??w.formatted??w.originalInput)?.api10===api);
 const linked=new Set(wells.flatMap(w=>w.associations.filter(a=>a.reviewStatus==="confirmed").map(a=>a.tractId)));
 if(tractId&&!linked.has(tractId))throw Error("Decision tract is outside the confirmed API/title association");
 const selected=tractId?[tractId]:[...linked];
 const findings=title.findings.filter(f=>f.affectedTractId===null||selected.includes(f.affectedTractId));
 const documents=new Map(title.sourceInventory.map(d=>[d.documentId,d]));
 const cited=(citations:typeof title.findings[number]["citations"])=>citations.length>0&&citations.every(c=>{
  const d=c.documentId?documents.get(c.documentId):undefined;
  return d&&/^[a-f0-9]{64}$/.test(d.contentHash??"")&&c.page!==null&&Number.isInteger(c.page)&&c.page>0&&(d.pageCount===null||c.page<=d.pageCount)&&(c.instrumentId===null||d.instrumentIds.includes(c.instrumentId));
 });
 const uncitedFindings=findings.filter(f=>!cited(f.citations)).map(f=>({id:f.findingId,reason:"Finding lacks a resolvable retained document hash and page citation; its substantive conclusion is withheld."}));
 const exceptions=buildExceptionImpacts(findings.filter(f=>cited(f.citations)),quantifiers);
 const verified=title.branches.filter(b=>selected.includes(b.tractId)).flatMap(b=>b.events).filter(e=>e.contentVerified&&cited(e.citations));
 const evidenceSufficient=selected.length>0&&verified.length>0&&title.status!=="INSUFFICIENT_DATA"&&uncitedFindings.length===0;
 return {exceptions,uncitedFindings,evidenceSufficient,reviewItemsOpen:title.reviewQueueOpenCount+uncitedFindings.length,
  reason:evidenceSufficient?"Readiness is limited to the selected title analysis and confirmed tract scope.":"Confirmed tract linkage and reviewed, cited instrument text are required to assess title readiness.",
  actions:[...new Set([...exceptions.map(x=>x.resolution),...(evidenceSufficient?[]:["Confirm the well-to-tract linkage and review the missing instrument evidence."])])],
  scope:{analysisId:title.analysisId,tractIds:selected,verifiedInstrumentCount:verified.length,searchCoverage:title.searchCoverage},
 };
}
