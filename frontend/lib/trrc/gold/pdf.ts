import path from "node:path";
import React from "react";
import {Document,Page,Text,View,Link,StyleSheet,renderToBuffer,Svg,Rect,Font} from "@react-pdf/renderer";
import type {DecisionField,DecisionFieldKey} from "../decision-record";
import {type GoldRecord,validateGoldRecord} from "./assemble";

// Fonts are resolved from the frontend package root rather than via
// `new URL(..., import.meta.url)`: under Next's webpack server bundle that
// URL comes from a different realm and `fileURLToPath` throws
// ERR_INVALID_ARG_TYPE at module load, which broke `next build`'s page-data
// collection for every route importing this file (production deploy
// dc30fb6 failed on exactly this). `process.cwd()` is the frontend root
// both locally (`npm run gold:report`, vitest) and in Vercel's serverless
// runtime; next.config.js's outputFileTracingIncludes ships the .otf files.
const FONT_DIR=path.join(process.cwd(),"lib","trrc","gold","fonts");
Font.register({family:"GoldSans",fonts:[
 {src:path.join(FONT_DIR,"NimbusSans-Regular.otf"),fontWeight:400},
 {src:path.join(FONT_DIR,"NimbusSans-Bold.otf"),fontWeight:700},
]});
const C={ink:"#122638",muted:"#526578",teal:"#007F78",line:"#DCE5EB",paper:"#F3F7F9",amber:"#805500"};
const S=StyleSheet.create({page:{padding:36,paddingBottom:48,fontFamily:"GoldSans",fontSize:9,color:C.ink},brand:{fontSize:8,color:C.teal,letterSpacing:2,marginBottom:16},title:{fontFamily:"GoldSans",fontWeight:700,fontSize:24,marginBottom:6},subtitle:{fontSize:10,color:C.muted,marginBottom:18},grid:{flexDirection:"row",flexWrap:"wrap",gap:8},card:{width:"48.8%",padding:9,borderWidth:1,borderColor:C.line,borderRadius:4,marginBottom:4},label:{fontSize:8,color:C.muted,marginBottom:5},value:{fontFamily:"GoldSans",fontWeight:700,fontSize:12,marginBottom:5},note:{fontSize:7.5,color:C.muted,lineHeight:1.35},cite:{fontSize:6.5,color:C.teal,marginTop:5},rule:{padding:9,backgroundColor:C.paper,marginBottom:8},footer:{position:"absolute",bottom:22,left:36,right:36,fontSize:7,color:C.muted},row:{flexDirection:"row",paddingVertical:6,borderBottomWidth:1,borderColor:C.line},cell:{fontSize:8,paddingRight:7},warning:{padding:10,backgroundColor:"#FFF6DF",marginBottom:12,fontSize:9,color:C.amber}});
const e=React.createElement;
const titles:Partial<Record<DecisionFieldKey,string>>={"identity.api10":"Confirmed API","identity.api14":"Completion / sidetrack API","identity.evaluated_position":"Evaluated position","economics.base_value":"Base position value","economics.maximum_buy_price":"Maximum acquisition price","ownership.nri":"Net revenue interest","production.lease_monthly":"Regulator lease monthly production","production.subject_monthly":"Subject-well monthly production","decision.posture":"Acquisition posture","decision.closing_readiness":"Closing readiness"};
function label(key:DecisionFieldKey){return titles[key]??key.split(".").slice(1).join(" ").replace(/_/g," ").replace(/^./,s=>s.toUpperCase());}
function show(field:DecisionField):string{
 if(field.status==="unavailable")return "Unavailable";
 if(field.status==="insufficient_data")return "Insufficient data";
 if(Array.isArray(field.value))return `${field.value.length} retrieved record(s)`;
 if(field.value&&typeof field.value==="object")return Object.entries(field.value).slice(0,8).map(([k,v])=>`${k.replace(/_/g," ")}: ${typeof v==="object"?"See evidence JSON":String(v)}`).join("\n");
 if(typeof field.value==="number")return field.value.toLocaleString("en-US",{maximumFractionDigits:8});
 return String(field.value).replace(/_/g," ");
}
function Field({gold,k,compact=false}:{gold:GoldRecord;k:DecisionFieldKey;compact?:boolean}){
 const field=gold.record.fields[k];
 return e(View,{style:[S.card,compact?{width:"31.8%",padding:8}:{}],wrap:false},e(Text,{style:S.label},label(k)),e(Text,{style:S.value},show(field)),
  compact?null:field.reason?e(Text,{style:S.note},field.reason):e(Text,{style:S.note},field.status==="calculated"?`Calculated: ${field.method}`:"Observed in retained source payload."),
  ...field.citations.map((c,i)=>e(Text,{key:i,style:S.cite},`${c.evidenceId} ${c.pointer||"/"}`)));
}
function Production({gold}:{gold:GoldRecord}){
 const field=gold.record.fields["production.lease_monthly"];
 if(field.status!=="observed"||!Array.isArray(field.value))return e(Text,{style:S.warning},"Production chart unavailable: no verified lease production was retrieved.");
 const rows=field.value as {production_month:string;oil_bbl:number|null;gas_mcf:number|null;casinghead_gas_mcf:number|null}[];
 const oil=rows.some(r=>r.oil_bbl!==null);
 const points=[...rows].sort((a,b)=>a.production_month.localeCompare(b.production_month)).slice(-36).map(r=>({month:r.production_month.slice(0,7),value:oil?r.oil_bbl:(r.gas_mcf===null&&r.casinghead_gas_mcf===null?null:(r.gas_mcf??0)+(r.casinghead_gas_mcf??0))}));
 const known=points.filter(p=>typeof p.value==="number"&&Number.isFinite(p.value));
 if(!known.length)return e(Text,{style:S.warning},"Retrieved months have no reported volumes for the chart.");
 const max=Math.max(1,...known.map(p=>p.value!));const width=530;const step=width/points.length;
 return e(View,{wrap:false,style:{marginBottom:16}},e(Text,{style:S.label},`LEASE-WIDE ${oil?"OIL (bbl)":"GAS (mcf)"} · ${points[0].month} to ${points[points.length-1].month}`),
  e(Svg,{width,height:125,viewBox:`0 0 ${width} 125`},...points.map((p,i)=>e(Rect,{key:i,x:i*step+1,y:110-(p.value??0)/max*100,width:Math.max(1,step-2),height:p.value===null?3:(p.value/max*100),fill:p.value===null?"#C5CDD4":C.teal}))),
  e(Text,{style:S.note},`Scale: 0 to ${max.toLocaleString("en-US")} ${oil?"bbl":"mcf"}. Gray marks indicate missing observations, not zero production. No subject-well allocation is made.`));
}
function Screening({gold}:{gold:GoldRecord}){return e(View,{wrap:false,style:{marginTop:12}},e(Text,{style:S.subtitle},"Supplemental lease-level engineering screening"),...["oil","gas"].map(phase=>{
 const result=gold.screening[phase as "oil"|"gas"];
 return e(View,{key:phase,style:S.rule,wrap:false},e(Text,{style:S.label},`${phase.toUpperCase()} · LEASE SCOPE`),e(Text,{style:S.value},result.status==="calculated"?`${Math.round(result.next12!).toLocaleString("en-US")} ${result.unit} · next 12 forecast months`:"Insufficient data"),e(Text,{style:S.note},result.reason??`Existing Arps model; input period ${result.firstMonth} to ${result.lastMonth}. Remaining modeled volume ${Math.round(result.forecastRemaining!).toLocaleString("en-US")} ${result.unit}. This is not a subject-well forecast or certified reserves.`),...result.citations.map((c,i)=>e(Text,{key:i,style:S.cite},`${c.evidenceId} ${c.pointer}`)));
}));}
function Sources({gold}:{gold:GoldRecord}){return e(View,{},...gold.coverage.map(c=>e(View,{key:c.category,style:S.rule,wrap:false},e(Text,{style:S.label},`${c.label} · ${c.status.replace(/_/g," ")}`),e(Text,{style:S.note},c.notes??"This source was not queried. No conclusion about absence of records is supported."))),...gold.record.evidence.map(source=>e(View,{key:source.id,style:S.rule,wrap:false},e(Text,{style:S.value},source.source.replace(/_/g," ")),e(Text,{style:S.note},`Evidence: ${source.id}\nRetrieved: ${source.retrievedAt}\nAttempt status: ${source.status}\n${source.error?`Failure: ${source.error}`:"Retained payload and the coverage entries above disclose found/empty/partial scope."}`),source.sourceUrl?e(Link,{src:source.sourceUrl,style:S.cite},source.sourceUrl):e(Text,{style:S.note},"Source URL unavailable"),e(Text,{style:S.cite},`SHA-256 parsed payload: ${source.sha256}`))));}
export async function renderGoldPdf(gold:GoldRecord):Promise<Buffer>{
 const errors=validateGoldRecord(gold);if(errors.length)throw Error(`GOLD validation failed: ${errors.join("; ")}`);
 return renderToBuffer(e(Document,{title:"MineralFlow Acquisition Decision Record",author:"MineralFlow AI"},...gold.sections.map(section=>e(Page,{key:section.id,size:"LETTER",style:S.page},
  e(Text,{style:S.brand},"MINERALFLOW AI · DECISION LAYER"),e(Text,{style:S.title},`${section.id}  ${section.title}`),e(Text,{style:S.subtitle},section.subtitle),
  section.id==="01"?e(Text,{style:S.warning},`Requested API: ${gold.record.input}. As of ${gold.record.generated_at.slice(0,10)}. Acquisition evidence is insufficient. Missing information is disclosed throughout; no ownership or acquisition value is assumed.`):null,
  section.id==="08"?e(Production,{gold}):null,
  e(View,{style:S.grid},...section.fields.map(k=>e(Field,{key:k,gold,k,compact:["01","08","09"].includes(section.id)}))),
  section.id==="08"?e(Screening,{gold}):null,
  ["07","15"].includes(section.id)?e(View,{style:{marginTop:12}},...gold.rules.map(rule=>e(View,{key:rule.id,style:S.rule,wrap:false},e(Text,{style:S.label},`${rule.id} · ${rule.outcome.replace(/_/g," ")}`),e(Text,{style:S.note},rule.explanation),e(Text,{style:S.cite},rule.inputs.join(", "))))):null,
  section.id==="A2"?e(Sources,{gold}):null,
  section.id==="A2"?e(Text,{style:S.note},gold.limitations.join("\n\n")):null,
  e(Text,{fixed:true,style:S.footer,render:({pageNumber,totalPages})=>`MineralFlow AI · ${gold.record.input} · Document-based research, not a title opinion · ${pageNumber} / ${totalPages}`})))));
}
