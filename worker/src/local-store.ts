/** Standalone execution store for the existing deterministic worker. No cloud DB
 * credentials are required. A caller can checkpoint after each committed write. */
import type { SupabaseClient } from "@supabase/supabase-js";
export type LocalRows=Record<string,unknown>[];
export type LocalSnapshot={trrc_due_diligence_runs:LocalRows;trrc_source_attempts:LocalRows;trrc_production_monthly:LocalRows};
export function createLocalStore(run:Record<string,unknown>,checkpoint?:(snapshot:LocalSnapshot)=>Promise<void>){
 const snapshot:LocalSnapshot={trrc_due_diligence_runs:[structuredClone(run)],trrc_source_attempts:[],trrc_production_monthly:[]};
 const db={from(table:string){
  if(!Object.prototype.hasOwnProperty.call(snapshot,table))throw Error(`Unsupported local-store table: ${table}`);
  const filters:{key:string;value:unknown;negated:boolean}[]=[];
  let operation:"select"|"update"|"upsert"="select";
  let payload:Record<string,unknown>|LocalRows={};let conflict:string[]=[];
  async function execute(){
   const rows=snapshot[table as keyof LocalSnapshot];
   const matching=(row:Record<string,unknown>)=>filters.every(f=>f.negated?row[f.key]!==f.value:row[f.key]===f.value);
   let data=rows.filter(matching);
   if(operation==="update")for(const row of data)Object.assign(row,payload);
   if(operation==="upsert"){
    data=[];
    for(const incoming of Array.isArray(payload)?payload:[payload]){
     const existing=rows.find(row=>conflict.length>0&&conflict.every(key=>row[key]===incoming[key]));
     if(existing){Object.assign(existing,structuredClone(incoming));data.push(existing);}
     else {const added=structuredClone(incoming);rows.push(added);data.push(added);}
    }
   }
   if(operation!=="select"&&checkpoint)await checkpoint(structuredClone(snapshot));
   return {data:structuredClone(data),error:null};
  }
  const chain={
   select:(_columns?:string)=>chain,
   eq:(key:string,value:unknown)=>{filters.push({key,value,negated:false});return chain;},
   neq:(key:string,value:unknown)=>{filters.push({key,value,negated:true});return chain;},
   update:(patch:Record<string,unknown>)=>{operation="update";payload=patch;return chain;},
   upsert:(input:Record<string,unknown>|LocalRows,options?:{onConflict?:string})=>{operation="upsert";payload=input;conflict=(options?.onConflict??"").split(",").filter(Boolean);return chain;},
   single:async()=>{const result=await execute();return result.data.length===1?{data:result.data[0],error:null}:{data:null,error:{message:`Expected one ${table} row, received ${result.data.length}`}};},
   then:<T>(resolve:(result:Awaited<ReturnType<typeof execute>>)=>T,reject?:(reason:unknown)=>T)=>execute().then(resolve,reject),
  };
  return chain;
 }} as unknown as SupabaseClient;
 return {db,snapshot};
}
