"use client";
import {useState,useEffect,type Dispatch,type SetStateAction} from "react";
import {COLORS} from "../colors";
const fields=[
 ["oil","Base oil price ($/bbl)",""],["downOil","Downside oil price ($/bbl)",""],["upOil","Upside oil price ($/bbl)",""],
 ["wi","Assumed working interest (%)",""],["nri","Assumed net revenue interest (%)",""],
 ["fixed","Package monthly fixed costs, including water handling ($)",""],["loe","Additional variable LOE ($/BOE)","0"],["workover","Additional workover reserve ($/BOE)","0"],
 ["capex","Initial capital ($)","0"],["liability","Terminal plugging/other liability ($)",""],
 ["hold","Holding period (months)","24"],["exit","Exit multiple of remaining PV-10","1"],["selling","Exit selling costs (%)","0"],["return","Required annual return (%)","15"],
 ["oilTax","Oil production tax assumption (%)","4.6"],["gasTax","Gas production tax assumption (%)","7.5"],["advalorem","Ad valorem proxy (% of revenue)","2"],["age","Maximum accepted reporting lag (months)","6"],
] as const;
// Labels here were bare <label> elements with no colour, so they inherited the
// browser default (near-black) on the dark surface and were unreadable —
// reported from production 2026-09-22. Use the same tokens the rest of the
// due-diligence UI uses for field labels and inputs.
const labelStyle={display:"block" as const,fontSize:"0.68rem",color:COLORS.text,fontWeight:600,textTransform:"uppercase" as const,letterSpacing:"0.05em",marginBottom:5};
const inputStyle={width:"100%",background:COLORS.surfaceAlt,color:COLORS.text,border:`1px solid ${COLORS.border}`,borderRadius:7,fontSize:"0.9rem",padding:"0.5rem 0.7rem"};

export function ScenarioControls({onChange}:{onChange:Dispatch<SetStateAction<Record<string,unknown>|null|undefined>>}){
 const [enabled,setEnabled]=useState(false);const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(fields.map(([k,,v])=>[k,v])));
 useEffect(()=>{
  if(!enabled){onChange(undefined);return;}
  if(Object.values(values).some(v=>!v.trim()||!Number.isFinite(Number(v)))){onChange(null);return;}
  const n=(k:string)=>Number(values[k]);
  onChange({basis:"conditional_assumptions_not_verified_ownership",prices:{base:{oilUsdBbl:n("oil"),gasUsdMcf:0},downside:{oilUsdBbl:n("downOil"),gasUsdMcf:0},upside:{oilUsdBbl:n("upOil"),gasUsdMcf:0}},workingInterest:n("wi")/100,netRevenueInterest:n("nri")/100,fixedMonthlyCostsUsd:n("fixed"),variableLoeUsdPerBoe:n("loe"),workoverReserveUsdPerBoe:n("workover"),initialCapexUsd:n("capex"),terminalLiabilityUsd:n("liability"),holdMonths:n("hold"),exitMultipleOfPv10:n("exit"),sellingCostFraction:n("selling")/100,requiredAnnualReturn:n("return")/100,oilSeveranceFraction:n("oilTax")/100,gasSeveranceFraction:n("gasTax")/100,adValoremFraction:n("advalorem")/100,maxHistoryAgeMonths:n("age"),productionScope:"oil_only",fixedCostsIncludeWaterHandling:true});
 },[enabled,values,onChange]);
 return <div style={{margin:"1rem 0"}}><label style={{display:"flex",alignItems:"center",gap:"0.5rem",color:COLORS.text,fontSize:"0.85rem",cursor:"pointer"}}><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> Calculate a conditional oil-only acquisition and exit scenario</label>
 {enabled&&<><p style={{color:COLORS.yellow,fontSize:"0.8rem"}}>These are explicit model assumptions, not verified ownership or costs. Interest percentages apply uniformly to the selected leases. Gas revenue is excluded. Fixed costs must include water handling; avoid duplicating those costs in variable LOE. Editable defaults are model assumptions, not retrieved facts.</p>
 <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:"0.7rem"}}>{fields.map(([key,label])=><div key={key}><label style={labelStyle}>{label}</label><input type="number" min="0" step="any" value={values[key]} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))} style={inputStyle}/></div>)}</div></>}
 </div>;
}
