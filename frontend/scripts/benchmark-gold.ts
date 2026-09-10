/** Reproduce all retained API cases; outputs are evidence reports, not buy recommendations. */
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {assembleGoldRecord,validateGoldRecord} from "../lib/trrc/gold/assemble";
import {renderGoldPdf} from "../lib/trrc/gold/pdf";
import type {LiteSourceAttempt} from "../lib/trrc/coverage";
async function main(){
 const fixture=resolve(process.argv[2]??"../benchmarks/latest-retrieval.json");
 const out=resolve(process.argv[3]??"../audit-work/gold-benchmark");
 const capture=JSON.parse(await readFile(fixture,"utf8")) as {cases:{case:{id:string;api10:string};attempts:LiteSourceAttempt[]}[]};
 if(!Array.isArray(capture.cases)||!capture.cases.length)throw Error("Benchmark cases are required");
 await mkdir(out,{recursive:true});
 const results=[];
 for(const c of capture.cases){
  try{
   const times=c.attempts.map(a=>Date.parse(a.attempted_at)).filter(Number.isFinite);
   if(!times.length)throw Error("Captured retrieval timestamp is required");
   const asOf=new Date(Math.max(...times)+1000).toISOString();
   const gold=assembleGoldRecord({id:c.case.id,original_input:c.case.api10},c.attempts,asOf);
   const errors=validateGoldRecord(gold);if(errors.length)throw Error(errors.join("; "));
   const pdf=await renderGoldPdf(gold);
   await writeFile(resolve(out,c.case.api10+"-gold.json"),JSON.stringify(gold,null,2)+"\n");
   await writeFile(resolve(out,c.case.api10+"-gold.pdf"),pdf);
   const counts={observed:0,calculated:0,unavailable:0,insufficient_data:0};
   for(const f of Object.values(gold.record.fields))counts[f.status]++;
   results.push({id:c.case.id,api:c.case.api10,status:"pass",counts,posture:gold.record.fields["decision.posture"].value,screening:gold.screening});
  }catch(error){results.push({id:c.case.id,api:c.case.api10,status:"failed",error:String(error)});process.exitCode=1;}
 }
 await writeFile(resolve(out,"summary.json"),JSON.stringify({fixture,results},null,2)+"\n");
 console.log(JSON.stringify({cases:results.length,passed:results.filter(r=>r.status==="pass").length,output:out}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
