/** Evidence-derived chart series shared by rendering and acceptance tests. */
import type {assembleGold2Draft} from './assemble';
export type GoldChartSeries={label:string;value:number|null;unit:string;note?:string};
export function chartSeries(report:ReturnType<typeof assembleGold2Draft>,id:string):GoldChartSeries[]{
 const f=(key:string)=>report.fields[key].value;
 const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
 const quantity=(v:unknown)=>typeof v==='object'&&v!==null?number((v as {value?:unknown}).value):number(v);
 switch(id){
  case 'value_waterfall': return ['base_value','measured_exposure','evidence_adjusted_value'].map(key=>({label:key.replace(/_/g,' '),value:number(f('economics.'+key)),unit:'USD',note:key==='measured_exposure'?'Adverse amount deducted from base; excludes unmeasured liabilities.':undefined}));
  case 'commodity_sensitivity':return (report.economics?.sensitivity??[]).map(c=>({label:`Oil $${c.oilUsdBbl}/bbl; gas $${c.gasUsdMcf}/Mcf`,value:c.valueUsd,unit:'USD'}));
  case 'ownership_scenarios':return report.evidenceScenarios.scenarios.map(c=>({label:c.id,value:c.valueUsd,unit:'USD',note:c.disclosure}));
  case 'risk_map':return (report.titleContext.exceptions??[]).map(c=>({label:c.findingId,value:c.quantifiedValueImpactUsd,unit:'USD measured effect',note:`Closing blocker: ${c.blocksClosing}; decision material: ${c.decisionMaterial}; quantifiable: ${c.quantifiable}. ${c.unquantifiedReason??''}`}));
  case 'confidence_domains':return report.rulesInput.confidenceDomains.map(c=>({label:c.domain,value:['INSUFFICIENT_DATA','LOW','MEDIUM','HIGH'].indexOf(c.level),unit:c.level,note:`Ordinal level, not a probability. ${c.reason}`}));
  case 'source_to_decision':return report.regulator.evidence.map(c=>({label:c.source,value:null,unit:c.status,note:`Evidence ${c.id} -> retained fields -> ${report.decision.matchedRule}: ${report.decision.posture}. SHA-256 ${c.sha256}`}));
  case 'production_forecast':{
   const monthly=report.partner?.months.filter(m=>m.api===report.regulator.input&&m.month<report.input.asOf.slice(0,7))??[];
   const selection=report.forecastMetrics?.selection;
   const forecast=selection?report.partner?.forecasts.filter(m=>m.api===report.regulator.input&&m.forecastId===selection.forecastId&&m.scenario===selection.scenario&&m.month>=selection.from)??[]:[];
   return [...monthly.map(m=>({...m,label:'Reported'})),...forecast.map(m=>({...m,label:'Forecast'}))].sort((a,b)=>a.month.localeCompare(b.month)).flatMap(m=>[{label:`${m.month} ${m.label} oil`,value:m.oilBbl,unit:'bbl/month'},{label:`${m.month} ${m.label} gas`,value:m.gasMcf,unit:'Mcf/month'}]);
  }
  case 'stratigraphic_column':{
   const tops=f('geology.formation_tops') as {value:{formation:string;top:number;base:number|null}[]};
   return tops.value.flatMap(t=>[{label:`${t.formation} top`,value:t.top,unit:'ft from cited reference'},{label:`${t.formation} base`,value:t.base,unit:'ft from cited reference'}]);
  }
  case 'ownership_graph':return ((f('title.ownership_graph')??[]) as NonNullable<typeof report.input.title>['branches']).flatMap(b=>b.apparentHolders.map(h=>({label:`${b.tractLabel}: ${h.parties.map(p=>p.displayName).join(' + ')}`,value:null,unit:h.share?`${h.share.n}/${h.share.d}`:'fraction unavailable',note:`Branch ${b.branchId}; holding ${h.holdingId}; source events ${h.sourceEventIds.join(', ')}. ${h.status}`})));
  case 'ownership_value_bridge':return [{label:'Reviewed NRI',value:report.ownership.status==='calculated'?Number(report.ownership.nri.n)/Number(report.ownership.nri.d):null,unit:'fraction'},{label:'Position base value',value:number(f('economics.base_value')),unit:'USD',note:'Recomputed from the same forecast and explicit assumptions at the reviewed NRI.'}];
  case 'source_reconciliation':return ['oil','gas'].flatMap(phase=>{
   const r=report.reconciliation?.[phase as 'oil'|'gas'];return [{label:`${phase}: complete vendor lease sum`,value:r?.vendorTotal??null,unit:phase==='oil'?'bbl':'Mcf'},{label:`${phase}: regulator lease total`,value:r?.regulatorTotal??null,unit:phase==='oil'?'bbl':'Mcf'},{label:`${phase}: variance`,value:r?.variancePercent??null,unit:'percent',note:r?.reason}];
  });
  default:throw Error(`No GOLD chart handler: ${id}`);
 }
}
