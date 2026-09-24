/** Actual integrated GOLD2 PDF export. Certification is separate from delivery. */
import React from "react";
import path from "node:path";
import {Document,Page,Text,View,Link,StyleSheet,renderToBuffer,Font,Svg,Rect} from "@react-pdf/renderer";
import {GOLD_SECTIONS} from "../gold/sections";
import {chartSeries} from "./charts";
import {GOLD2_FIELDS,GOLD2_CHARTS} from "./contract";
import {validateGold2Draft,type assembleGold2Draft,type DraftField} from "./assemble";
type Record2=ReturnType<typeof assembleGold2Draft>;
const e=React.createElement;
// See gold/pdf.ts for why fonts resolve from process.cwd() instead of import.meta.url.
const FONT_DIR=path.join(process.cwd(),"lib","trrc","gold","fonts");
Font.register({family:"Gold2",fonts:[{src:path.join(FONT_DIR,"NimbusSans-Regular.otf"),fontWeight:400},{src:path.join(FONT_DIR,"NimbusSans-Bold.otf"),fontWeight:700}]});
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
function LeaseAnalysis({report}:{report:Record2}){
 const lease=report.internalLease;
 if(!lease.record)return e(Missing,{reason:lease.reason??"Lease evidence unavailable."});
 const record=lease.record, economics=record.conditionalEconomics;
 return e(View,{},e(Text,{style:s.section},"MineralFlow lease forecast and entry / exit"),
  e(Text,{style:s.warning},"RRC lease-wide production. These volumes and values are not allocated to the requested well or established as the seller's interest. Conditional WI/NRI does not clear title."),
  ...record.forecastReadiness.map(r=>e(View,{key:r.streamKey,style:s.box},e(Text,{style:s.label},r.streamKey),e(Text,{style:s.note},`Latest oil: ${r.latestReportedOilMonth??"unavailable"}; ${r.latestReportedOilBbl??"unavailable"} bbl. Reporting lag: ${r.reportingLagMonths??"unknown"} months. ${r.reason??"Existing Arps fit available; forecast is screening, not certified reserves."}${!r.reason&&r.declineWindowNote?` ${r.declineWindowNote}`:""}`))),
  ...lease.oilForecasts.map(m=>{
   const points=m.months.slice(0,60),max=Math.max(1,...points.map(p=>p.oilBbl)),step=500/Math.max(1,points.length);
   return e(View,{key:m.streamKey,wrap:false},e(Text,{style:s.label},`${m.streamKey}: remaining modeled oil ${m.remainingOilBbl===null?"unavailable":display(m.remainingOilBbl)+" bbl"}`),e(Svg,{width:510,height:110},...points.map((p,i)=>e(Rect,{key:i,x:i*step,y:100-p.oilBbl/max*95,width:Math.max(1,step-1),height:p.oilBbl/max*95,fill:c.teal}))),e(Text,{style:s.note},m.reason??`First ${points.length} forecast months; scale 0-${display(max)} bbl/month.`),e(Text,{style:s.note},m.disclosure),e(Text,{style:s.citation},"/internalLease/oilForecasts; evidence: /internalLease/record/production/leaseStreams"));
  }),
  economics?e(View,{},...economics.scenarios.map(x=>e(View,{key:x.name,style:s.box,wrap:false},e(Text,{style:s.value},`${x.name}: maximum entry $${display(x.maximumEntryUsd)}`),e(Text,{style:s.note},`Net modeled exit: $${display(x.entryExit.exitProceedsUsd)} | Remaining modeled oil: ${display(x.remainingGrossOilBbl)} bbl | Required return: ${display(economics.settings.requiredAnnualReturn*100)}% | Hold: ${economics.settings.holdMonths} months`),e(Text,{style:s.citation},`/internalLease/record/conditionalEconomics/scenarios/${x.name}; cited lease months in /internalLease/record/production/leaseStreams`))),...economics.reasons.map((r,i)=>e(Missing,{key:i,reason:r})),...economics.disclosures.map((r,i)=>e(Text,{key:i,style:s.note},r))):e(Missing,{reason:report.fields["economics.lease_scenarios"].reason??"Explicit operating and purchase assumptions are required."}));
}
function Values({report}:{report:Record2}){
 const points=["downside","base","upside"].map(name=>({name,value:report.fields[`economics.${name}_value`].value}));
 if(!points.some(p=>typeof p.value==="number"))return e(Missing,{reason:report.fields["economics.base_value"].reason??"Evidenced ownership and forecast plus supplied economics inputs are required."});
 const max=Math.max(1,...points.map(p=>typeof p.value==="number"?Math.abs(p.value):0));
 return e(View,{wrap:false},e(Text,{style:s.section},"Commodity scenarios - ownership held fixed"),...points.map(p=>e(View,{key:p.name,style:s.row},e(Text,{style:{width:65}},p.name),e(View,{style:{width:320}},typeof p.value==="number"?e(View,{style:{width:Math.abs(p.value)/max*300,height:13,backgroundColor:p.value>=0?c.teal:"#AF493A"}}):null),e(Text,{style:{width:100}},typeof p.value==="number"?`$${display(p.value)}`:"Unavailable"))));
}
// The chain of title, printed. The display() fallback renders any array as
// "N entries - retained in companion JSON", which left the report's own chain
// of title — the section a buyer turns to first — as a bare count.
type ChainRow={recordedDate:string|null;executionDate:string|null;instrumentType:string;clerkDocType?:string|null;contentVerified:boolean;recordingReference:string|null;fromParties:{displayName:string}[];toParties:{displayName:string}[];citations:{label:string|null;sourceUrl:string|null;page:number|null}[]};
const words=(t:string)=>t==="other"?"Recorded instrument":t.replace(/_/g," ").replace(/^./,x=>x.toUpperCase());
function TitleSummary({report}:{report:Record2}){
 const t=report.input.title;
 if(!t)return e(Missing,{reason:report.fields["title.instruments"].reason??"No published title analysis accompanies this API."});
 const rows=(t.chronology??[]) as unknown as ChainRow[];
 const read=rows.filter(r=>r.contentVerified).length;
 const tracts=t.tracts.filter(x=>x.matchStatus==="confirmed").map(x=>x.tractLabel);
 return e(View,{style:s.box,wrap:false},e(Text,{style:s.label},`Title analysis v${t.version} | ${t.generatedAt.slice(0,10)} | ${t.statusDisplay}`),
  e(Text,{style:s.value},`${rows.length} recorded instruments on the confirmed tract`),
  e(Text,{style:s.note},`${tracts.join("; ")||"No confirmed tract"}. ${read} read from the recorded image; ${rows.length-read} from the county clerk index only. The full chain is in Appendix A. Index entries establish that a recording exists and who the clerk indexed as parties; they do not establish what was conveyed, reserved or excepted.`));
}
function TitleChain({report}:{report:Record2}){
 const t=report.input.title;
 if(!t)return e(Missing,{reason:report.fields["title.instruments"].reason??"No published title analysis accompanies this API."});
 const rows=(t.chronology??[]) as unknown as ChainRow[];
 const clerk=t.searchCoverage.filter(x=>x.provider.startsWith("county:"));
 const w={date:62,type:96,parties:222,evidence:48,ref:92};
 const cell=(width:number,text:string,bold=false)=>e(Text,{style:[s.cell,{width,fontWeight:bold?700:400}]},text);
 return e(View,{},
  e(Text,{style:s.section},"Chain of title - confirmed subject tract"),
  e(Text,{style:s.note},`${t.tracts.filter(x=>x.matchStatus==="confirmed").map(x=>x.tractLabel).join("; ")}. Parties as indexed by the county clerk. "Read" instruments were extracted from the recorded image and are cited to a page; "Index" rows are clerk index entries whose images were not read.`),
  e(View,{style:[s.row,{borderBottomWidth:1.5}],fixed:true},cell(w.date,"Recorded",true),cell(w.type,"Instrument",true),cell(w.parties,"Grantor  >  Grantee",true),cell(w.evidence,"Evidence",true),cell(w.ref,"Reference",true)),
  ...rows.map((r,i)=>{
   const cite=r.citations.find(c=>c.sourceUrl)??r.citations[0];
   const party=`${(r.fromParties??[]).map(p=>p.displayName).join("; ")||"-"}  >  ${(r.toParties??[]).map(p=>p.displayName).join("; ")||"-"}`;
   const type=r.clerkDocType?`${r.clerkDocType}${words(r.instrumentType).toLowerCase()!==r.clerkDocType.toLowerCase()?`\n${words(r.instrumentType)}`:""}`:words(r.instrumentType);
   const ref=[r.recordingReference??cite?.label??"",r.contentVerified&&cite?.page?`p. ${cite.page}`:""].filter(Boolean).join(" | ");
   return e(View,{key:i,style:s.row,wrap:false},cell(w.date,r.recordedDate??r.executionDate??"-"),cell(w.type,type),cell(w.parties,party),
    e(Text,{style:[s.cell,{width:w.evidence,color:r.contentVerified?c.teal:c.muted,fontWeight:r.contentVerified?700:400}]},r.contentVerified?"Read":"Index"),
    r.contentVerified&&cite?.sourceUrl?e(Link,{src:cite.sourceUrl,style:[s.cell,{width:w.ref,color:c.teal}]},ref||"Source"):cell(w.ref,ref||"-"));
  }),
  rows.length===0?e(Text,{style:s.note},"No recorded instruments are linked to a confirmed tract in this analysis."):null,
  e(Text,{style:s.section},"County clerk searches"),
  // Latest outcome per distinct query, tract searches first, then by hits.
  // Budget-skipped predecessor searches are counted, not listed.
  ...(()=>{
   const latest=new Map<string,typeof clerk[number]>();
   for(const q of clerk)latest.set(`${q.queryType}|${q.queryValue}`,q);
   const ran=[...latest.values()].filter(q=>q.status!=="skipped_bounded");
   const skipped=[...latest.values()].filter(q=>q.status==="skipped_bounded").length;
   ran.sort((a,b)=>Number(b.queryType==="tract_description")-Number(a.queryType==="tract_description")||(b.resultCount??0)-(a.resultCount??0));
   return [e(View,{key:"qh",style:[s.row,{borderBottomWidth:1.5}]},cell(110,"Search",true),cell(250,"Query",true),cell(80,"Outcome",true),cell(60,"Hits",true)),
    ...ran.map((q,i)=>e(View,{key:`q${i}`,style:s.row,wrap:false},cell(110,q.queryType.replace(/_/g," ")),cell(250,q.queryValue),cell(80,q.status.replace(/_/g," ")),cell(60,`${q.resultCount??0}${(q.resultCount??0)>=50?" (page cap)":""}`))),
    skipped?e(Text,{key:"qs",style:s.note},`${skipped} further predecessor-party searches were planned but not run within the per-job query budget. Coverage of predecessor parties is therefore incomplete.`):null];
  })(),
  clerk.length===0?e(Text,{style:s.note},"No county clerk search was logged; no chain of title can exist in this report."):null,
  ...(t.limitations.length?[e(Text,{key:"lh",style:s.section},"Title limitations"),...t.limitations.map((l,i)=>e(Text,{key:`l${i}`,style:s.note},`- ${l}`))]:[]));
}
function RuleTrace({report}:{report:Record2}){return e(View,{},...report.decision.trace.map(r=>e(View,{key:r.id,style:s.box,wrap:false},e(Text,{style:s.label},`${r.id} - ${r.outcome}`),e(Text,{style:s.note},r.reason))));}
function Sources({report}:{report:Record2}){return e(View,{},...report.regulator.evidence.map(r=>e(View,{key:r.id,style:s.box,wrap:false},e(Text,{style:s.value},r.source.replace(/_/g," ")),e(Text,{style:s.note},`${r.status} | ${r.retrievedAt}\n${r.error??"See retained payload for query results and scope."}`),r.sourceUrl?e(Link,{src:r.sourceUrl,style:s.citation},r.sourceUrl):null,e(Text,{style:s.citation},`Evidence ${r.id}\nSHA-256 ${r.sha256}`))),...report.disclosures.map(d=>e(View,{key:d.id,style:s.box,wrap:false},e(Text,{style:s.label},label("d."+d.id)),e(Text,{style:s.note},d.text))));}
function EvidenceChart({report,id}:{report:Record2;id:string}){
 const input=report.chartInputs.find(c=>c.id===id)!;
 const title=id.replace(/_/g," ");
 if(input.status==="unavailable")return e(View,{style:s.box},e(Text,{style:s.section},`Chart: ${title}`),e(Missing,{reason:input.reason!}));
 const rows=chartSeries(report,id);
 const maximum=(unit:string)=>id==="confidence_domains"?3:Math.max(1,...rows.filter(r=>r.unit===unit).map(r=>Math.abs(r.value??0)));
 return e(View,{},e(Text,{style:s.section},`Chart: ${title}`),e(Text,{style:s.note},"Each unit has its own scale. Missing values are not zeros. Exact inputs and citations are retained in the companion Decision Record."),
  ...rows.map((row,i)=>e(View,{key:i,style:s.box,wrap:false},e(Text,{style:s.label},row.label),
   row.value!==null?e(View,{style:{width:400,borderLeftWidth:1,borderColor:c.line,paddingVertical:3}},e(View,{style:{height:9,width:Math.abs(row.value)/maximum(row.unit)*380,backgroundColor:row.value<0?"#AF493A":c.teal}})):null,
   e(Text,{style:s.note},`${row.value===null?"No numeric value":display(row.value)} | ${row.unit}${row.value!==null?` | scale 0-${display(maximum(row.unit))} in absolute magnitude`:""}`),row.note?e(Text,{style:s.note},row.note):null)),
  rows.length===0?e(Text,{style:s.note},"No entries in the retained evaluated scope; this does not establish absence outside that scope."):null);
}
export function gold2Sections(){
 const used=new Set(GOLD_SECTIONS.flatMap(s=>s.fields));
 const extra=GOLD2_FIELDS.filter(k=>!used.has(k as never));
 const targets:Record<string,string>={identity:"01",economics:"02",forecast:"08",production:"08",geology:"09",decision:"15",evidence:"A2"};
 return GOLD_SECTIONS.map(section=>({...section,fields:[...section.fields,...extra.filter(k=>targets[k.split(".")[0]]===section.id)]}));
}
export async function renderGold2Pdf(report:Record2):Promise<Buffer>{
 const errors=validateGold2Draft(report);if(errors.length)throw Error(errors.join("; "));
 const sections=gold2Sections();
 return renderToBuffer(e(Document,{title:`MineralFlow GOLD 2.0 Decision Record - ${report.input.api}`,author:"MineralFlow AI",creationDate:new Date(report.input.asOf),modificationDate:new Date(report.input.asOf)},...sections.map((section,sectionIndex)=>e(Page,{key:section.id,size:"LETTER",style:s.page},
  e(Text,{style:s.brand},"MINERALFLOW AI | GOLD 2.0 DECISION RECORD"),e(Text,{style:s.title},`${section.id}  ${section.title}`),e(Text,{style:s.sub},section.subtitle),
  section.id==="01"?e(View,{},e(Text,{style:s.sub},`Requested API: ${report.input.api} | As of: ${report.input.asOf}`),e(Text,{style:s.warning},`Delivery status: evidence report; unavailable inputs are disclosed. Acceptance is recorded separately. Acquisition posture: ${report.decision.posture}. Closing: ${report.decision.closing.state}.\n${report.implementationGaps.join(" ")}`)):null,
  section.id==="02"?e(View,{},e(Values,{report}),e(LeaseAnalysis,{report})):null,section.id==="08"?e(Production,{report}):null,
  ...GOLD2_CHARTS.filter(chart=>chart.page===sectionIndex+1).map(chart=>e(EvidenceChart,{key:chart.id,report,id:chart.id})),
  e(View,{style:s.grid},...section.fields.map(k=>e(Field,{key:k,report,k}))),
  section.id==="15"?e(RuleTrace,{report}):null,section.id==="A2"?e(Sources,{report}):null,
  section.id==="10"?e(TitleSummary,{report}):null,section.id==="A"?e(TitleChain,{report}):null,
  e(Text,{fixed:true,style:s.footer,render:({pageNumber,totalPages})=>`MineralFlow | ${report.input.api} | Evidence-based research, subject to professional review | ${pageNumber}/${totalPages}`})))));
}
