"use client";
import {useEffect,useState} from "react";
import {useApiFetch} from "@/lib/trrc/use-api-fetch";
import type {PortfolioInput,PortfolioRecord} from "@/lib/trrc/portfolio/record";
import {ScenarioControls} from "./scenario-controls";
import {COLORS} from "../colors";
export function PortfolioReview({members}:{members:PortfolioInput["members"]}){
 const apiFetch=useApiFetch();
 const [scenario,setScenario]=useState<Record<string,unknown>|null|undefined>(undefined);
 const [record,setRecord]=useState<PortfolioRecord|null>(null);
 const [recordId,setRecordId]=useState<string|null>(null);
 const [asking,setAsking]=useState("");const [claimed,setClaimed]=useState("");
 const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 useEffect(()=>{
  const id=new URL(window.location.href).searchParams.get("record");if(!id)return;
  let active=true;setBusy(true);
  apiFetch(`/api/trrc/due-diligence/portfolio-record/${encodeURIComponent(id)}`).then(r=>r.json()).then(result=>{
   if(!active)return;
   if(!result.ok)throw Error(result.error??"Could not load portfolio record.");
   setRecord(result.data.record);setRecordId(result.data.id);
   setAsking(result.data.record.input.askingPriceUsd?.toString()??"");setClaimed(result.data.record.input.claimedWellCount?.toString()??"");
  }).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setBusy(false);});
  return ()=>{active=false;};
 },[apiFetch]);
 const generate=async()=>{
  setBusy(true);setError(null);
  try{
   if(scenario===null)throw Error("Complete every enabled scenario input; missing values are not assumed to be zero.");
   const result=await apiFetch("/api/trrc/due-diligence/portfolio-record",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({members:members.length?members:record?.input.members,askingPriceUsd:asking.trim()?Number(asking):null,claimedWellCount:claimed.trim()?Number(claimed):null,...(scenario?{scenario}:{})})}).then(r=>r.json());
   if(!result.ok)throw Error(result.error??"Could not generate portfolio record.");
   setRecord(result.data.record);setRecordId(result.data.id);
   const url=new URL(window.location.href);url.searchParams.set("record",result.data.id);window.history.replaceState(null,"",url);
  }catch(e){setError(e instanceof Error?e.message:"Portfolio request failed.");}finally{setBusy(false);}
 };
 const download=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify({id:recordId,record},null,2)],{type:"application/json"}));
  const a=document.createElement("a");a.href=url;a.download=`MineralFlow-Portfolio-${recordId}.json`;a.click();URL.revokeObjectURL(url);
 };
 const inputStyle={background:COLORS.surfaceAlt,color:COLORS.text,border:`1px solid ${COLORS.border}`,borderRadius:5,padding:"0.5rem",width:"100%"};
 return <section aria-label="Portfolio evidence review" style={{background:COLORS.surface,border:`1px solid ${COLORS.border}`,borderRadius:8,padding:"1rem",marginBottom:"1rem"}}>
  <h2 style={{fontSize:"1rem",color:COLORS.text}}>Package evidence and acquisition readiness</h2>
  <p style={{color:COLORS.textMuted,fontSize:"0.82rem"}}>Reconcile every submitted entry and count shared lease production once. Optionally run the existing forecast, cash-flow and exit engines under explicit conditional assumptions.</p>
  <div style={{display:"flex",gap:"1rem",flexWrap:"wrap",alignItems:"end"}}>
   <label>Asking price (USD)<input aria-label="Package asking price" type="number" min="0.01" step="0.01" value={asking} onChange={e=>setAsking(e.target.value)} style={inputStyle}/></label>
   <label>Seller’s stated well count<input aria-label="Seller stated well count" type="number" min="1" step="1" value={claimed} onChange={e=>setClaimed(e.target.value)} style={inputStyle}/></label>
   <button onClick={generate} disabled={busy||(!members.length&&!record)} style={{...inputStyle,width:"auto",cursor:"pointer"}}>{busy?"Loading evidence…":"Save portfolio evidence review"}</button>
  </div>
  <ScenarioControls onChange={setScenario}/>
  {error&&<p role="alert" style={{color:COLORS.red}}>{error}</p>}
  {record&&<>
   <p style={{color:COLORS.yellow}}><strong>INSUFFICIENT DATA — acquisition decision withheld</strong></p>
   {members.length>0&&JSON.stringify(members)!==JSON.stringify(record.input.members)&&<p style={{color:COLORS.yellow}}>This saved snapshot covers a different submitted list. Save a new review for the current batch.</p>}
   <p>{record.inventory.submittedEntries} entries · {record.inventory.distinctValidApis} distinct valid APIs · {record.production.leaseStreams.length} identified production streams</p>
   <p style={{color:COLORS.textMuted,fontSize:"0.8rem"}}>Saved {new Date(record.generatedAt).toLocaleString()}. This snapshot does not change as jobs run. Save a new review to refresh it; bookmark this page to reopen the saved record.</p>
   <button onClick={download} style={{...inputStyle,width:"auto"}}>Download evidence record (JSON)</button>
   <div style={{overflowX:"auto",marginTop:"1rem"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:"0.8rem"}}>
    <caption style={{textAlign:"left",padding:"0.5rem 0"}}>Gross regulatory lease streams — ownership and sale allocation unverified</caption>
    <thead><tr>{["District / lease","Type","Linked APIs","Latest retained month","Oil (bbl)"].map(h=><th key={h} style={{textAlign:"left",padding:"0.5rem",borderBottom:`1px solid ${COLORS.border}`}}>{h}</th>)}</tr></thead>
    <tbody>{record.production.leaseStreams.map(s=>{const last=s.months.at(-1);return <tr key={s.key}><td>{s.district} / {s.leaseNumber}</td><td>{s.leaseType==="O"?"Oil":"Gas"}</td><td>{s.apis.length}</td><td>{last?.month??"Unavailable"}</td><td>{last?.volumes.oil_bbl.value?.toLocaleString()??"Insufficient data"}</td></tr>;})}</tbody>
   </table></div>
   {record.conditionalEconomics&&<div style={{marginTop:"1rem"}}>
    <h3>Conditional acquisition scenarios</h3>
    {record.conditionalEconomics.reasons.map(reason=><p key={reason} style={{color:COLORS.yellow}}>{reason}</p>)}
    <div style={{overflowX:"auto"}}><table style={{width:"100%",fontSize:"0.8rem"}}><thead><tr>{["Case","Model PV-10","Maximum entry at required return","Net exit proceeds","Profit incl. hold cash","Positive IRR"].map(h=><th key={h}>{h}</th>)}</tr></thead>
    <tbody>{record.conditionalEconomics.scenarios.map(s=><tr key={s.name}><td>{s.name}</td><td>${Math.round(s.entryExit.pv10AsIsUsd).toLocaleString()}</td><td>${Math.round(s.maximumEntryUsd).toLocaleString()}</td><td>${Math.round(s.entryExit.exitProceedsUsd).toLocaleString()}</td><td>{s.entryExit.profitUsd===null?"Asking price required":`$${Math.round(s.entryExit.profitUsd).toLocaleString()}`}</td><td>{s.entryExit.irrAnnualPct===null?"Not established":`${s.entryExit.irrAnnualPct.toFixed(1)}%`}</td></tr>)}</tbody></table></div>
    <details><summary>Scenario assumptions and limitations</summary><ul>{record.conditionalEconomics.disclosures.map(d=><li key={d}>{d}</li>)}</ul></details>
   </div>}
   <details open><summary>Decision blockers ({record.decision.blockers.length})</summary><ul>{record.decision.blockers.map(b=><li key={b}>{b}</li>)}</ul></details>
   <details><summary>All submitted entries</summary><ul>{record.inventory.members.map((m,i)=><li key={i}>{m.input}: {m.reason??"Production stream reconciled; title and acquisition scope still require review."}</li>)}</ul></details>
   <p style={{fontSize:"0.8rem",color:COLORS.textMuted}}>A final acquisition recommendation remains withheld. Conditional model values do not establish ownership or reserves. Missing volumes are never treated as zero; conflicting observations are withheld. Historical production is not a reserves estimate.</p>
  </>}
 </section>;
}
