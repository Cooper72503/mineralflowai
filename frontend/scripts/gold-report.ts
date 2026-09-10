/** npm run gold:report -- --api 42-165-02733 --out ./output
 * Use --replay ../benchmarks/captures/gaines-oil.json for reproducible offline execution. */
import {readFile,mkdir,writeFile,rename} from "node:fs/promises";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {normalizeApiNumber} from "../lib/trrc/normalization";
import {assembleGoldRecord,validateGoldRecord} from "../lib/trrc/gold/assemble";
import {renderGoldPdf} from "../lib/trrc/gold/pdf";
import type {LiteSourceAttempt} from "../lib/trrc/coverage";
import {createLocalStore} from "../../worker/src/local-store";
import {runLandmanSequencer} from "../../worker/src/sequencer";
import {closeBrowser} from "../../worker/src/tools/browser";

async function main(){
 const args=process.argv.slice(2);const opts:Record<string,string>={};
 for(let i=0;i<args.length;i+=2){if(!["--api","--out","--replay"].includes(args[i])||!args[i+1])throw Error("Usage: npm run gold:report -- --api TEXAS_API [--out DIRECTORY] [--replay CAPTURE.json]");opts[args[i]]=args[i+1];}
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
 const gold=assembleGoldRecord(run as never,attempts,now);
 const errors=validateGoldRecord(gold);if(errors.length)throw Error(errors.join("; "));
 const pdf=await renderGoldPdf(gold);
 await save(`${api.api10}-gold.json`,JSON.stringify(gold,null,2)+"\n");
 await save(`${api.api10}-gold.pdf`,pdf);
 await save(`${api.api10}-retrieval.json`,JSON.stringify({run,attempts},null,2)+"\n");
 const observed=Object.values(gold.record.fields).filter(f=>f.status==="observed").length;
 console.log(JSON.stringify({api:api.api10,directory:out,mode:opts["--replay"]?"captured-replay":"live-public-retrieval",schema:"valid",observedFields:observed,totalFields:Object.keys(gold.record.fields).length,posture:gold.record.fields["decision.posture"].value},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}).finally(()=>closeBrowser());
