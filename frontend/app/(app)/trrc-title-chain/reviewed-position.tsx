"use client";
import {useState} from "react";
import {useApiFetch} from "@/lib/trrc/use-api-fetch";
export function ReviewedPositionImport({jobId}:{jobId:string}){
 const apiFetch=useApiFetch();const [message,setMessage]=useState("");const [busy,setBusy]=useState(false);
 async function save(file:File){
  setBusy(true);setMessage("");
  try{
   if(file.size>2_000_000)throw Error("Position file must be under 2 MB.");
   const input=JSON.parse(await file.text());
   const result=await apiFetch(`/api/trrc/title-chain/${jobId}/position`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)}).then(r=>r.json());
   if(!result.ok)throw Error(result.error??"Position could not be saved.");
   setMessage(`Reviewed mineral position selected. Calculated NRI: ${result.data.nri.n}/${result.data.nri.d}. Generate a new report or package review to include it. This does not establish working interest or clear title exceptions.`);
  }catch(error){setMessage(error instanceof Error?error.message:"Review failed.");}finally{setBusy(false);}
 }
 return <section style={{padding:16,border:"1px solid #334155",borderRadius:8,marginBottom:16}}>
  <h3>Evaluated mineral position</h3>
  <p>Select an evidence-backed mineral position from the published title analysis. The reviewed position JSON must identify the holding, owner and tract, with cited acreage, unit participation and lease royalty. Importing records your review under your signed-in account.</p>
  <label>Import reviewed position JSON <input type="file" accept=".json,application/json" disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(file)void save(file);e.target.value="";}}/></label>
  <p role="status">{busy?"Validating cited position…":message}</p>
 </section>;
}
