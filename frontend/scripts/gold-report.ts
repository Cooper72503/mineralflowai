/** npm run gold:report -- --api 42-165-02733 --out ./output
 * Use --replay ../benchmarks/captures/gaines-oil.json for reproducible offline execution. */
import {readFile,mkdir,writeFile,rename} from "node:fs/promises";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {normalizeApiNumber} from "../lib/trrc/normalization";
import {assembleGold2Draft,validateGold2Draft,type Gold2Input} from "../lib/trrc/gold2/assemble";
import {renderGold2Pdf} from "../lib/trrc/gold2/pdf";
import type {LiteSourceAttempt} from "../lib/trrc/coverage";
import {createLocalStore} from "../../worker/src/local-store";
import {runLandmanSequencer} from "../../worker/src/sequencer";
import {closeBrowser} from "../../worker/src/tools/browser";

async function main(){
 const args=process.argv.slice(2);const opts:Record<string,string>={};
 for(let i=0;i<args.length;i+=2){if(!["--api","--out","--replay","--inputs"].includes(args[i])||!args[i+1])throw Error("Usage: npm run gold:report -- --api TEXAS_API [--out DIRECTORY] [--replay CAPTURE.json] [--inputs REVIEWED_INPUTS.json]");opts[args[i]]=args[i+1];}
 const api=normalizeApiNumber(opts["--api"]??"");if(!api)throw Error("A supported valid Texas API is required; no report was created.");
 const out=resolve(opts["--out"]??"output/gold");await mkdir(out,{recursive:true});
 async function save(name:string,bytes:string|Buffer){const destination=resolve(out,name);await writeFile(destination+".tmp",bytes);await rename(destination+".tmp",destination);}
 const run={id:randomUUID(),original_input:opts["--api"],normalized_input:api.api10,selected_input_type:"api_number",detected_input_type:"api_number",status:"running",resolved_primary_api:null,started_at:new Date().toISOString()};
 let attempts:LiteSourceAttempt[];
 if(opts["--replay"]){
  const capture=JSON.parse(await readFile(resolve(opts["--replay"]),"utf8"));
  if(normalizeApiNumber(capture.case?.api10)?.api10!==api.api10||!Array.isArray(capture.attempts))throw Error("Replay capture does not match requested API");
  attempts=capture.attempts;
 }else{
  const {db,snapshot}=createLocalStore(run,state=>save(`${api.api10}-checkpoint.json`,JSON.stringify(state,null,2)));
  await runLandmanSequencer(run.id,api.api10,db);
  Object.assign(run,snapshot.trrc_due_diligence_runs[0]);
  if(run.status!=="complete")throw Error(`Worker did not complete (${run.status}); inspect the retained checkpoint.`);
  attempts=snapshot.trrc_source_attempts as unknown as LiteSourceAttempt[];
 }
 const now=new Date(Math.max(Date.now(),...attempts.map(a=>Date.parse(a.attempted_at)).filter(Number.isFinite))).toISOString();
 const supplements=opts["--inputs"]?JSON.parse(await readFile(resolve(opts["--inputs"]),"utf8")):{};
 const permitted=["title","position","partner","reconciliationPolicy","economics","forecastSelection"];
 if(Object.keys(supplements).some(k=>!permitted.includes(k)))throw Error("Supplement file contains unsupported keys; API and retrieval cannot be overridden.");
 const input:Gold2Input={title:null,position:null,partner:null,reconciliationPolicy:null,economics:null,...supplements,api:api.api10,runId:run.id,attempts,asOf:now};
 const gold=assembleGold2Draft(input);
 const errors=validateGold2Draft(gold);if(errors.length)throw Error(errors.join("; "));
 const pdf=await renderGold2Pdf(gold);
 await save(`${api.api10}-gold.json`,JSON.stringify(gold,null,2)+"\n");
 await save(`${api.api10}-gold.pdf`,pdf);
 await save(`${api.api10}-retrieval.json`,JSON.stringify({run,attempts},null,2)+"\n");
 const observed=Object.values(gold.fields).filter(f=>f.status==="observed").length;
 console.log(JSON.stringify({api:api.api10,directory:out,mode:opts["--replay"]?"captured-replay":"live-public-retrieval",reportVersion:"2.0.0",delivery:"pdf_and_json",goldAcceptance:"incomplete",observedFields:observed,totalFields:Object.keys(gold.fields).length,posture:gold.fields["decision.posture"].value},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}).finally(()=>closeBrowser());
