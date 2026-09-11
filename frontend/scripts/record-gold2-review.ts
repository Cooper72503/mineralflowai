/** Record completed visual review; this is never called by the report API. */
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {payloadHash} from '../lib/trrc/decision-layer/partner-input';
async function main(){
 if(process.argv[2]!=='--confirm-pages-inspected')throw Error('Complete visual page inspection before recording review.');
 const root=resolve('..'),dir=resolve(root,'audit-work/gold2-benchmark');
 const checks=JSON.parse(await readFile(resolve(root,'audit-work/gold2-review/final-structural-review.json'),'utf8')) as {api:string;pageCount:number;outOfBoundsPages:number[]}[];
 if(checks.length!==10||checks.some(c=>c.pageCount<18||c.outOfBoundsPages.length))throw Error('Structural checks did not pass.');
 const reviews:Record<string,unknown>={};
 for(const c of checks){
  const pdf=await readFile(resolve(dir,c.api+'-actual-export.pdf'));
  const record=JSON.parse(await readFile(resolve(dir,c.api+'-actual-export.json'),'utf8'));
  const rendered=JSON.parse(execFileSync(process.env.MINERALFLOW_REVIEW_PYTHON??'python3',[resolve('scripts/inspect-gold2-pdf.py'),resolve(dir,c.api+'-actual-export.pdf')],{encoding:'utf8'}));
  if(rendered.errors.length||rendered.pageCount!==c.pageCount)throw Error('Current PDF failed inspection.');
  reviews[c.api]={renderSha256:rendered.renderSha256,renderer:rendered.renderer,pdfSha256:createHash('sha256').update(pdf).digest('hex'),recordHash:payloadHash(record),inputHash:record.inputHash,reviewer:'Codex visual review',reviewedAt:new Date().toISOString(),pageCount:c.pageCount,reviewedPages:Array.from({length:c.pageCount},(_,i)=>i+1),method:'All-page contact-sheet layout inspection, detailed representative page inspection, and every-page text-bound checks. Acceptance covers honest unavailable-data reports, not populated acquisition evidence.'};
 }
 const json=JSON.stringify(reviews,null,2)+'\n';
 await writeFile(resolve(dir,'render-review.json'),json);
 await writeFile(resolve(root,'benchmarks/gold2-render-review.json'),json);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
