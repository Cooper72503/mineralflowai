/** Gate the actual production exporter against GOLD2. Legacy renders NEVER count as GOLD2. */
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {assembleGold2Draft,validateGold2Draft} from "../lib/trrc/gold2/assemble";
import {assembleGoldRecord,validateGoldRecord} from "../lib/trrc/gold/assemble";
import {renderGoldPdf} from "../lib/trrc/gold/pdf";
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
 for(const c of capture.cases){
  try{
   const times=c.attempts.map(a=>Date.parse(a.attempted_at));
   if(!times.length||times.some(t=>!Number.isFinite(t)))throw Error("Benchmark retrieval timestamp missing or invalid");
   const asOf=new Date(Math.max(...times)+1000).toISOString();
   const gold=assembleGoldRecord({id:c.case.id,original_input:c.case.api10},c.attempts,asOf);
   const legacyErrors=validateGoldRecord(gold);
   if(legacyErrors.length)throw Error(legacyErrors.join("; "));
   const pdf=await renderGoldPdf(gold);
   const draft=assembleGold2Draft({api:c.case.api10,runId:c.case.id,asOf,attempts:c.attempts,title:null,position:null,partner:null,reconciliationPolicy:null,economics:null});
   const draftErrors=validateGold2Draft(draft);if(draftErrors.length)throw Error(draftErrors.join("; "));
   await writeFile(resolve(out,c.case.api10+"-gold2-draft.json"),JSON.stringify(draft,null,2)+"\n");
   const ownership=linkReviewedMineralPosition(c.case.api10,null,null);
   const partner=await unavailableNoviAdapter().readWell(c.case.api10);
   // This candidate represents what the production exporter actually delivers.
   // No rename, manufactured chart or asserted audit flag upgrades a legacy export.
   const candidate:Gold2AcceptanceCandidate={schemaVersion:gold.version,rulesetVersion:gold.version,api:c.case.api10,
    fields:Object.fromEntries(Object.entries(gold.record.fields).map(([k,f])=>[k,{...f,validated:true}])),
    charts:[],sections:gold.sections.map(s=>s.id),audit:{evidenceValid:true,calculationsRecomputed:false,rulesRecomputed:false,renderInspected:false,engineHandoffsComplete:false}};
   const errors=gold2Acceptance(candidate);
   const result={id:c.case.id,api:c.case.api10,status:errors.length?"implementation_failure":"validated",goldVersion:gold.version,errors,
    unavailableInputs:{ownership,partner},sourceFailures:c.attempts.filter(a=>a.status!=="success").map(a=>({source:a.source_name,status:a.status,reason:a.error_message}))};
   await writeFile(resolve(out,c.case.api10+"-validation.json"),JSON.stringify(result,null,2)+"\n");
   await writeFile(resolve(out,c.case.api10+"-actual-export.json"),JSON.stringify(gold,null,2)+"\n");
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
