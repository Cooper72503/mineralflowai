/** Actual integrated GOLD2 PDF export. Certification is separate from delivery. */
import React from "react";
import {fileURLToPath} from "node:url";
import {Document,Page,Text,View,Link,StyleSheet,renderToBuffer,Font,Svg,Rect} from "@react-pdf/renderer";
import {GOLD_SECTIONS} from "../gold/sections";
import {GOLD2_FIELDS} from "./contract";
import {validateGold2Draft,type assembleGold2Draft,type DraftField} from "./assemble";
type Record2=ReturnType<typeof assembleGold2Draft>;
const e=React.createElement;
Font.register({family:"Gold2",fonts:[{src:fileURLToPath(new URL("../gold/fonts/NimbusSans-Regular.otf",import.meta.url)),fontWeight:400},{src:fileURLToPath(new URL("../gold/fonts/NimbusSans-Bold.otf",import.meta.url)),fontWeight:700}]});
const c={ink:"#142D3E",muted:"#526578",teal:"#087F7A",line:"#D8E3E9",paper:"#F3F7F9",warning:"#FFF3DB"};
const s=StyleSheet.create({page:{padding:34,paddingBottom:48,fontFamily:"Gold2",fontSize:9,color:c.ink},brand:{fontSize:8,color:c.teal,letterSpacing:2,marginBottom:12},title:{fontSize:23,fontWeight:700,marginBottom:6},sub:{fontSize:9,color:c.muted,marginBottom:13},grid:{flexDirection:"row",flexWrap:"wrap",gap:7},card:{width:"48.5%",padding:9,borderWidth:1,borderColor:c.line,marginBottom:4},label:{fontSize:8,color:c.muted,marginBottom:4},value:{fontSize:12,fontWeight:700,marginBottom:5},note:{fontSize:7.5,color:c.muted,lineHeight:1.3},citation:{fontSize:6.5,color:c.teal,marginTop:4},box:{backgroundColor:c.paper,padding:9,marginBottom:8},warning:{backgroundColor:c.warning,padding:10,marginBottom:12,fontSize:8,lineHeight:1.35},footer:{position:"absolute",left:34,right:34,bottom:20,fontSize:7,color:c.muted},row:{flexDirection:"row",paddingVertical:5,borderBottomWidth:1,borderColor:c.line},cell:{fontSize:8,paddingRight:6},section:{fontSize:12,fontWeight:700,marginTop:12,marginBottom:8}});
function label(k:string){return k.slice(k.indexOf(".")+1).replace(/_/g," ").replace(/^./,x=>x.toUpperCase());}
function display(v:unknown):string{
 if(typeof v==="number")return v.toLocaleString("en-US",{maximumFractionDigits:8});
 if(typeof v==="string")return v.replace(/_/g," ");
 if(Array.isArray(v))return `${v.length} entries - retained in companion JSON`;
 if(v&&typeof v==="object"){
  const r=v as Record<string,unknown>;
  if(typeof r.n==="string"&&typeof r.d==="string")return `${r.n}/${r.d}`;
  if(typeof r.value==="number")return `${display(r.value)} ${r.unit??""}\n${r.from??""}${r.through?` to ${r.through}`:""}`;
  return Object.entries(r).slice(0,5).map(([k,x])=>`${label("v."+k)}: ${x===null?"Unavailable":typeof x==="object"?"See companion JSON":display(x)}`).join("\n");
 }
 return "Unavailable";
}
function Field({report,k}:{report:Record2;k:string}){
 const f=report.fields[k];
 const value=f.value===null?(f.status==="insufficient_data"?"Insufficient data":"Unavailable"):display(f.value);
 const legacy=report.regulator.fields[k as keyof typeof report.regulator.fields];
 const refs=legacy&&legacy.citations.length&&f.origin?.pointer.startsWith("/regulator/")?legacy.citations.map(x=>`${x.evidenceId} ${x.pointer}`):f.origin?[`${f.origin.source}: ${f.origin.pointer}`]:[];
 return e(View,{style:s.card,wrap:false},e(Text,{style:s.label},label(k)),e(Text,{style:s.value},value),
  e(Text,{style:s.note},f.reason??(f.origin?.source==="provided_assumptions"?"Uses explicitly supplied assumptions; see provenance.":f.origin?.method?`Calculation: ${f.origin.method}`:"Retained evidence; see source reference.")),
  ...refs.map((r,i)=>e(Text,{key:i,style:s.citation},r)));
}
function Missing({reason}:{reason:string}){return e(Text,{style:s.warning},`Unavailable: ${reason}`);}
function Production({report}:{report:Record2}){
 const well=report.fields["production.subject_monthly"],lease=report.fields["production.lease_monthly"];
 const subject=Array.isArray(well.value)&&well.value.length>0;
 const raw=(subject?well.value:lease.value) as Record<string,unknown>[]|null;
 if(!Array.isArray(raw)||!raw.length)return e(Missing,{reason:well.reason??"No production observations were retrieved."});
 const rows=raw.map(r=>({month:String(r.month??r.production_month).slice(0,7),oil:(r.oilBbl??r.oil_bbl??null) as number|null})).filter(r=>r.month<report.input.asOf.slice(0,7)).sort((a,b)=>a.month.localeCompare(b.month)).slice(-36);
 if(!rows.some(r=>typeof r.oil==="number"))return e(Missing,{reason:"No reported oil volumes are available for this oil chart. Gas evidence remains in the record."});
 const max=Math.max(1,...rows.map(r=>r.oil??0)),width=520,step=width/rows.length;
 return e(View,{wrap:false,style:{marginBottom:12}},e(Text,{style:s.section},subject?"Subject well - reported oil":"Supplemental lease-wide oil - not subject-well allocation"),
  e(Svg,{width,height:120},...rows.map((r,i)=>e(Rect,{key:i,x:i*step+1,y:105-(r.oil??0)/max*95,width:Math.max(1,step-2),height:r.oil===null?3:r.oil/max*95,fill:r.oil===null?"#B5C1CA":c.teal}))),
  e(Text,{style:s.note},`${rows[0].month} to ${rows[rows.length-1].month} | Scale 0-${display(max)} bbl/month. Gray marks are missing observations, not zeros. Forecast totals below are separate calculations.`));
}
function Values({report}:{report:Record2}){
 const points=["downside","base","upside"].map(name=>({name,value:report.fields[`economics.${name}_value`].value}));
 if(!points.some(p=>typeof p.value==="number"))return e(Missing,{reason:report.fields["economics.base_value"].reason??"Evidenced ownership and forecast plus supplied economics inputs are required."});
 const max=Math.max(1,...points.map(p=>typeof p.value==="number"?Math.abs(p.value):0));
 return e(View,{wrap:false},e(Text,{style:s.section},"Commodity scenarios - ownership held fixed"),...points.map(p=>e(View,{key:p.name,style:s.row},e(Text,{style:{width:65}},p.name),e(View,{style:{width:320}},typeof p.value==="number"?e(View,{style:{width:Math.abs(p.value)/max*300,height:13,backgroundColor:p.value>=0?c.teal:"#AF493A"}}):null),e(Text,{style:{width:100}},typeof p.value==="number"?`$${display(p.value)}`:"Unavailable"))));
}
function RuleTrace({report}:{report:Record2}){return e(View,{},...report.decision.trace.map(r=>e(View,{key:r.id,style:s.box,wrap:false},e(Text,{style:s.label},`${r.id} - ${r.outcome}`),e(Text,{style:s.note},r.reason))));}
function Sources({report}:{report:Record2}){return e(View,{},...report.regulator.evidence.map(r=>e(View,{key:r.id,style:s.box,wrap:false},e(Text,{style:s.value},r.source.replace(/_/g," ")),e(Text,{style:s.note},`${r.status} | ${r.retrievedAt}\n${r.error??"See retained payload for query results and scope."}`),r.sourceUrl?e(Link,{src:r.sourceUrl,style:s.citation},r.sourceUrl):null,e(Text,{style:s.citation},`Evidence ${r.id}\nSHA-256 ${r.sha256}`))),...report.disclosures.map(d=>e(View,{key:d.id,style:s.box,wrap:false},e(Text,{style:s.label},label("d."+d.id)),e(Text,{style:s.note},d.text))));}
export function gold2Sections(){
 const used=new Set(GOLD_SECTIONS.flatMap(s=>s.fields));
 const extra=GOLD2_FIELDS.filter(k=>!used.has(k as never));
 const targets:Record<string,string>={identity:"01",economics:"02",forecast:"08",production:"08",geology:"09",decision:"15",evidence:"A2"};
 return GOLD_SECTIONS.map(section=>({...section,fields:[...section.fields,...extra.filter(k=>targets[k.split(".")[0]]===section.id)]}));
}
export async function renderGold2Pdf(report:Record2):Promise<Buffer>{
 const errors=validateGold2Draft(report);if(errors.length)throw Error(errors.join("; "));
 const sections=gold2Sections();
 return renderToBuffer(e(Document,{title:`MineralFlow GOLD 2.0 Decision Record - ${report.input.api}`,author:"MineralFlow AI"},...sections.map(section=>e(Page,{key:section.id,size:"LETTER",style:s.page},
  e(Text,{style:s.brand},"MINERALFLOW AI | GOLD 2.0 DECISION RECORD"),e(Text,{style:s.title},`${section.id}  ${section.title}`),e(Text,{style:s.sub},section.subtitle),
  section.id==="01"?e(View,{},e(Text,{style:s.sub},`Requested API: ${report.input.api} | As of: ${report.input.asOf}`),e(Text,{style:s.warning},`Delivery status: integrated evidence report; full GOLD2 acceptance is incomplete. Acquisition posture: ${report.decision.posture}. Closing: ${report.decision.closing.state}.\n${report.implementationGaps.join(" ")}`)):null,
  section.id==="02"?e(Values,{report}):null,section.id==="08"?e(Production,{report}):null,
  e(View,{style:s.grid},...section.fields.map(k=>e(Field,{key:k,report,k}))),
  section.id==="15"?e(RuleTrace,{report}):null,section.id==="A2"?e(Sources,{report}):null,
  e(Text,{fixed:true,style:s.footer,render:({pageNumber,totalPages})=>`MineralFlow | ${report.input.api} | Evidence-based research, subject to professional review | ${pageNumber}/${totalPages}`})))));
}
