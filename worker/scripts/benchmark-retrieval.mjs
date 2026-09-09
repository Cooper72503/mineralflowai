/** Live read-only RRC retrieval benchmark; no database writes or paid APIs. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {searchWellbore,getProduction,getGisLocation,getDrillingPermits} from '../dist/tools/ewa.js';
const root=new URL('../../benchmarks/',import.meta.url);
const {cases:allCases}=JSON.parse(await readFile(new URL('texas-api-cases.json',root),'utf8'));
const selectedId=process.argv[2];
const cases=selectedId?allCases.filter(c=>c.id===selectedId):allCases;
if(!cases.length)throw Error('Unknown benchmark case');
const captureDirectory=new URL(selectedId?'rechecks/':'captures/',root);
const results=[];
if(cases.some(c=>!/^42\d{8}$/.test(c.api10)))throw Error('Invalid benchmark identifier');
async function run(c){
 const attempts=[];const started=new Date().toISOString();
 async function call(name,fn){
  const at=new Date().toISOString();let data;
  try{data=await fn();}catch(error){data={error:String(error),found:false};}
  const count=['wells','rows','permits','records'].map(k=>data[k]).find(Array.isArray)?.length ?? (data.found?1:0);
  attempts.push({source_id:`${c.id}-${name}`,source_name:name,status:data.error?'failed_transient':'success',result_count:count,error_message:data.error??null,attempted_at:at,result_data_json:data});
  console.log(c.id,name,data.error?'FAILED':data.found?'FOUND':'EMPTY');return data;
 }
 const [well]=await Promise.all([call('search_by_api',()=>searchWellbore(c.api10)),call('fetch_gis_plat',()=>getGisLocation(c.api10))]);
 const matches=(well.wells??[]).filter(w=>String(w.api_no).replace(/\D/g,'').replace(/^42(?=\d{8}$)/,'')===c.api10.slice(2));
 const active=matches.filter(w=>w.on_schedule==='Y');const candidates=active.length?active:matches;
 const associations=new Map(candidates.filter(w=>w.lease_no&&w.district).map(w=>[`${w.district}:${w.lease_no}`,w]));
 const selected=associations.size===1?[...associations.values()][0]:null;
 await call('fetch_production',()=>getProduction(selected?.lease_no??null,selected?.district??null));
 await call('fetch_drilling_permits',()=>getDrillingPermits(c.api10));
 const result={case:c,started_at:started,finished_at:new Date().toISOString(),attempts};results.push(result);
 await writeFile(new URL(`${c.id}.json`,captureDirectory),JSON.stringify(result,null,2)+'\n');
}
await mkdir(captureDirectory,{recursive:true});
if(!selectedId){
 try { const previous=JSON.parse(await readFile(new URL('latest-retrieval.json',root),'utf8'));
 await mkdir(new URL('history/',root),{recursive:true});
 await writeFile(new URL(`history/${previous.generated_at.replace(/[:.]/g,'-')}.json`,root),JSON.stringify(previous,null,2)+'\n');
 } catch(error){if(error.code!=='ENOENT')throw error;}
}
let next=0;await Promise.all(Array.from({length:2},async()=>{while(next<cases.length)await run(cases[next++]);}));
const report={scope:'Live RRC wellbore, GIS, production and permit retrieval only. Does not certify production persistence, full browser adapters, title/Novi handoffs or PDF.',commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),working_tree_changes:true,generated_at:new Date().toISOString(),cases:results.sort((a,b)=>a.case.id.localeCompare(b.case.id))};
await writeFile(new URL(selectedId?`recheck-${selectedId}.json`:'latest-retrieval.json',root),JSON.stringify(report,null,2)+'\n');
console.log('Captured',results.length,'cases');
