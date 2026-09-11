/** Gate the actual production exporter against GOLD2. Legacy renders NEVER count as GOLD2. */
import {execFileSync} from "node:child_process";
import {payloadHash} from "../lib/trrc/decision-layer/partner-input";
import {createHash} from "node:crypto";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {assembleGold2Draft,validateGold2Draft} from "../lib/trrc/gold2/assemble";
import {validateDecisionRecord} from "../lib/trrc/decision-record";
import {evaluateGold2Rules} from "../lib/trrc/gold2/rules";
import {renderGold2Pdf,gold2Sections} from "../lib/trrc/gold2/pdf";
import {gold2Acceptance,type Gold2AcceptanceCandidate} from "../lib/trrc/gold2/contract";
import {linkReviewedMineralPosition} from "../lib/trrc/decision-layer/ownership";
import {unavailableNoviAdapter} from "../lib/trrc/decision-layer/novi-adapter";
import type {LiteSourceAttempt} from "../lib/trrc/coverage";
async function main(){
 const fixture=resolve(process.argv[2]??"../benchmarks/latest-retrieval.json");
 const out=resolve(process.argv[3]??"../audit-work/gold2-benchmark");
 const capture=JSON.parse(await readFile(fixture,"utf8")) as {cases:{case:{id:string;api10:string};attempts:LiteSourceAttempt[]}[]};
 if(capture.cases?.length!==10||new Set(capture.cases.map(c=>c.case.api10)).size!==10)throw Error("GOLD benchmark requires exactly ten distinct APIs");
 await mkdir(out,{recursive:true});
 const results=[];
 const acceptReviewed=process.argv[4]==="--accept-reviewed";
 let reviews:Record<string,any>={};
 try{reviews=JSON.parse(await readFile(acceptReviewed?resolve(out,"render-review.json"):fileURLToPath(new URL("../../benchmarks/gold2-render-review.json",import.meta.url)),"utf8"));}catch(error){if(acceptReviewed||(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 for(const c of capture.cases){
  try{
   const times=c.attempts.map(a=>Date.parse(a.attempted_at));
   if(!times.length||times.some(t=>!Number.isFinite(t)))throw Error("Benchmark retrieval timestamp missing or invalid");
   const asOf=new Date(Math.max(...times)+1000).toISOString();
   const draft=assembleGold2Draft({api:c.case.api10,runId:c.case.id,asOf,attempts:c.attempts,title:null,position:null,partner:null,reconciliationPolicy:null,economics:null});
   const draftErrors=validateGold2Draft(draft);if(draftErrors.length)throw Error(draftErrors.join("; "));
   if(acceptReviewed&&JSON.stringify(JSON.parse(await readFile(resolve(out,c.case.api10+"-actual-export.json"),"utf8")))!==JSON.stringify(draft))throw Error("Existing report differs from recomputed outputs; regenerate and review it.");
   const pdf=acceptReviewed?await readFile(resolve(out,c.case.api10+"-actual-export.pdf")):await renderGold2Pdf(draft);
   const pdfHash=createHash("sha256").update(pdf).digest("hex");
   await writeFile(resolve(out,c.case.api10+"-actual-export.pdf"),pdf);
   const render=JSON.parse(execFileSync(process.env.MINERALFLOW_REVIEW_PYTHON??"python3",[fileURLToPath(new URL("./inspect-gold2-pdf.py",import.meta.url)),resolve(out,c.case.api10+"-actual-export.pdf")],{encoding:"utf8"}));
   const review=reviews[c.case.api10];
   const renderInspected=!!review&&review.renderSha256===render.renderSha256&&review.renderer===render.renderer&&render.errors.length===0&&review.pageCount===render.pageCount&&review.inputHash===draft.inputHash&&review.recordHash===payloadHash(draft)&&review.reviewer==="Codex visual review"&&Number.isInteger(review.pageCount)&&review.pageCount>=18&&review.reviewedPages?.length===review.pageCount&&review.reviewedPages.every((p:number,i:number)=>p===i+1);
   await writeFile(resolve(out,c.case.api10+"-gold2-draft.json"),JSON.stringify(draft,null,2)+"\n");
   const ownership=linkReviewedMineralPosition(c.case.api10,null,null);
   const partner=await unavailableNoviAdapter().readWell(c.case.api10);
   // Gate the integrated data actually exported, never a legacy version substituted for it.
   const candidate:Gold2AcceptanceCandidate={schemaVersion:draft.schemaVersion,rulesetVersion:draft.decision.rulesetVersion,api:c.case.api10,
    fields:Object.fromEntries(Object.entries(draft.fields).map(([k,f])=>[k,{...f,validated:draftErrors.length===0}])),
    charts:draft.chartInputs.map(c=>({id:c.id,status:c.status==="ready"?"rendered":"unavailable",inputFields:c.inputFields,reason:c.reason,validated:true})),calculations:draft.calculations,sections:gold2Sections().map(s=>s.id),disclosures:[...draft.disclosures],
    audit:{evidenceValid:validateDecisionRecord(draft.regulator).length===0,calculationsRecomputed:draftErrors.length===0,
     rulesRecomputed:JSON.stringify(evaluateGold2Rules(draft.rulesInput))===JSON.stringify(draft.decision),
     renderInspected,engineHandoffsComplete:draft.implementationGaps.length===0}};
   const errors=gold2Acceptance(candidate);
   const result={id:c.case.id,api:c.case.api10,status:errors.length?"implementation_failure":"validated",goldVersion:draft.schemaVersion,pdfSha256:pdfHash,renderSha256:render.renderSha256,renderInspection:render,renderInspected,unavailableFieldCount:Object.values(draft.fields).filter(f=>f.value===null).length,wellContext:draft.wellContext,errors,
    unavailableInputs:{ownership,partner},sourceFailures:c.attempts.filter(a=>a.status!=="success").map(a=>({source:a.source_name,status:a.status,reason:a.error_message}))};
   await writeFile(resolve(out,c.case.api10+"-validation.json"),JSON.stringify(result,null,2)+"\n");
   await writeFile(resolve(out,c.case.api10+"-actual-export.json"),JSON.stringify(draft,null,2)+"\n");
   await writeFile(resolve(out,c.case.api10+"-actual-export.pdf"),pdf);
   results.push(result);
  }catch(error){results.push({id:c.case.id,api:c.case.api10,status:"execution_failure",errors:[String(error)]});}
 }
 const root=fileURLToPath(new URL("../../",import.meta.url));
 const summary={executedAt:new Date().toISOString(),mode:"retained-source-end-to-end-replay",fixture:relative(root,fixture),goldReportsValidated:results.filter(r=>r.status==="validated").length,required:10,results};
 await writeFile(resolve(out,"summary.json"),JSON.stringify(summary,null,2)+"\n");
 await writeFile(resolve(root,"benchmarks/gold2-latest-validation.json"),JSON.stringify(summary,null,2)+"\n");
 const statusPath=resolve(root,"PIPELINE-STATUS.md");
 const status=await readFile(statusPath,"utf8");
 if(!/GOLD reports validated: \d+\/10/.test(status))throw Error("GOLD status marker is missing");
 await writeFile(statusPath,status.replace(/GOLD reports validated: \d+\/10/,`GOLD reports validated: ${summary.goldReportsValidated}/10`));
 console.log(`GOLD reports validated: ${summary.goldReportsValidated}/10`);
 if(summary.goldReportsValidated!==10)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
