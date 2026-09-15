/** Integrated GOLD2 work product. A draft is not an accepted/rendered Decision Record. */
import {buildDecisionRecord,validateDecisionRecord,type DecisionRecord} from "../decision-record";
import type {LiteSourceAttempt} from "../coverage";
import type {TitleChainAnalysis} from "../title/chain-types";
import {normalizeApiNumber} from "../normalization";
import {normalizePartnerInput,payloadHash} from "../decision-layer/partner-input";
import {linkReviewedMineralPosition} from "../decision-layer/ownership";
import {reconcilePartnerProduction,type ReconciliationPolicyInput} from "../decision-layer/reconcile";
import {evaluateGold2Economics,Gold2EconomicsInputSchema} from "./economics";
import {evaluateGold2Rules,type Gold2RuleInput} from "./rules";
import {GOLD2_FIELDS,GOLD2_VERSION} from "./contract";
import {subjectProductionMetrics,subjectForecastMetrics,shiftMonth} from "./production";
import {mapWellMeasurements} from "./measurements";
import {retainedWellContext} from "./well-context";
import {deriveCoverageFromAttempts} from "../coverage";
import {buildChartInputs} from "./chart-inputs";
import {GOLD2_CALCULATIONS} from "./requirements";
import {evaluateEvidenceScenarios} from "./evidence-scenarios";
import {explainFieldGaps} from "./gaps";
import type {UnavailableReason} from "./contract";
import {titleDecisionContext} from "./title-context";
import {GOLD2_DISCLOSURES} from "./requirements";
export interface Gold2Input {
 api:string;asOf:string;runId:string;attempts:LiteSourceAttempt[];
 titleLookup?:{status:"linked"|"not_found"|"ambiguous"|"query_failed"|"in_progress";reason:string|null};
 title:TitleChainAnalysis|null;position:unknown|null;partner:unknown|null;
 reconciliationPolicy:ReconciliationPolicyInput|null;economics:unknown|null;
 evidenceScenarios?:unknown|null;
 forecastSelection?:{forecastId:string;scenario:"base"|"downside"|"upside";from:string}|null;
}
export interface DraftField {
 reasonCode?:UnavailableReason|"engine_not_connected";
 status:"observed"|"calculated"|"unavailable"|"insufficient_data";value:unknown;reason:string|null;
 origin:{source:"regulatory_evidence"|"title_analysis"|"reviewed_position"|"partner_evidence"|"provided_assumptions"|"decision_engine";pointer:string;method?:string}|null;
}
export function assembleGold2Draft(input:Gold2Input){
 const api=normalizeApiNumber(input.api)?.api10;if(!api)throw Error("Invalid GOLD2 API");
 if(!Number.isFinite(Date.parse(input.asOf)))throw Error("Invalid GOLD2 as-of date");
 if(input.attempts.some(a=>Date.parse(a.attempted_at)>Date.parse(input.asOf)))throw Error("Report predates retained retrieval evidence");
 const regulator=buildDecisionRecord({id:input.runId,original_input:api},input.attempts,input.asOf);
 const errors=validateDecisionRecord(regulator);if(errors.length)throw Error(errors.join("; "));
 const fields:Record<string,DraftField>=Object.fromEntries(GOLD2_FIELDS.map(k=>{
  const base=regulator.fields[k as keyof DecisionRecord["fields"]];
  return [k,base?{status:base.status,value:base.value,reason:base.reason,origin:base.value===null?null:{source:"regulatory_evidence",pointer:`/regulator/fields/${k}`}}:{status:"unavailable",value:null,reason:"GOLD2 field handoff has not been implemented.",origin:null}];
 }));
 const put=(key:string,value:unknown,source:NonNullable<DraftField["origin"]>["source"],pointer:string,method?:string)=>{
  if(!GOLD2_FIELDS.includes(key as typeof GOLD2_FIELDS[number]))throw Error(`Unknown GOLD2 mapping: ${key}`);
  if(value===null||value===undefined)return;
  fields[key]={status:method?"calculated":"observed",value,reason:null,origin:{source,pointer,...(method?{method}:{})}};
 };
 put("identity.as_of",input.asOf,"provided_assumptions","/input/asOf");
 const wellContext=retainedWellContext(regulator);
 put("identity.lease_name",wellContext.leaseName.value,"regulatory_evidence","/wellContext/leaseName","unique_matching_wellbore_fact_v1");
 put("identity.well_number",wellContext.wellNumber.value,"regulatory_evidence","/wellContext/wellNumber","unique_matching_wellbore_fact_v1");
 put("identity.well_name",wellContext.designation,"regulatory_evidence","/wellContext/designation","rrc_lease_well_designation_v1");
 put("geology.formation",wellContext.formation,"regulatory_evidence","/wellContext/formation","existing_formation_alias_normalizer_v1");
 put("geology.reported_api_depth",wellContext.reportedDepth,"regulatory_evidence","/wellContext/reportedDepth","strict_reported_depth_numeric_v1");
 const ownership=linkReviewedMineralPosition(api,input.title,input.position);
 if(ownership.status==="calculated"){
  for(const [field,key] of Object.entries({"ownership.mineral_fraction":"mineralFraction","ownership.gross_acres":"grossAcres","ownership.unit_acres":"unitAcres","ownership.net_mineral_acres":"netMineralAcres","ownership.tract_participation":"tractParticipation","ownership.lease_royalty":"leaseRoyalty","ownership.nri":"nri"}))put(field,ownership[key as keyof typeof ownership],"reviewed_position",`/ownership/${key}`,ownership.method);
  put("identity.evaluated_position",ownership.position,"reviewed_position","/ownership/position");
  put("identity.tract",ownership.position.tractId,"reviewed_position","/ownership/position/tractId");
  put("identity.interest_scope","mineral_royalty","reviewed_position","/ownership",ownership.method);
 }
 // Title analysis must actually identify the subject; another job's title is never attached by proximity/name.
 const title=input.title;
 if(title){
  if(!title.wells.some(w=>normalizeApiNumber(w.api14??w.formatted??w.originalInput)?.api10===api))throw Error("GOLD2 title analysis does not contain subject API");
  if(Date.parse(title.generatedAt)>Date.parse(input.asOf))throw Error("Report predates title analysis");
  put("title.instruments",title.chronology,"title_analysis","/input/title/chronology");
  put("title.search_scope",title.searchCoverage,"title_analysis","/input/title/searchCoverage");
  put("title.ownership_graph",title.branches,"title_analysis","/input/title/branches");
  put("title.encumbrances",title.branches.flatMap(b=>b.encumbrances),"title_analysis","/input/title/branches","flatten_title_encumbrances_v1");
  put("evidence.search_coverage",title.searchCoverage,"title_analysis","/input/title/searchCoverage");
 }
 if(!title&&input.titleLookup?.reason){
  for(const k of ["title.instruments","title.search_scope","title.ownership_graph","title.encumbrances"]){fields[k]={status:input.titleLookup.status==="not_found"?"unavailable":"insufficient_data",value:null,reason:input.titleLookup.reason,origin:null};}
 }
 const partner=input.partner===null?null:normalizePartnerInput(input.partner);
 if(partner){
  if(partner.bundle.sources.some(s=>Date.parse(s.retrievedAt)>Date.parse(input.asOf)))throw Error("Report predates partner evidence");
  const monthly=partner.months.filter(m=>m.api===api&&m.month<input.asOf.slice(0,7));
  if(monthly.length)put("production.subject_monthly",monthly,"partner_evidence","/partner/months","select_subject_api_and_normalize_phase_units_v1");
 }
 const measurements=partner?mapWellMeasurements(partner.bundle,api,input.asOf):null;
 if(measurements){
  for(const [key,measurement] of Object.entries(measurements.fields))put(key,measurement,"partner_evidence",`/measurements/fields/${key}`,measurement.method);
  for(const conflict of measurements.conflicts)fields[`geology.${conflict.property}`]={status:"insufficient_data",value:null,reason:conflict.reason,origin:{source:"partner_evidence",pointer:"/measurements/conflicts"}};
 }
 const productionMetrics=partner?subjectProductionMetrics(partner.bundle,api,input.asOf):null;
 if(productionMetrics){
  put("production.subject_ttm_oil",productionMetrics.oil.value,"partner_evidence","/productionMetrics/oil",productionMetrics.method);
  put("production.subject_ttm_gas",productionMetrics.gas.value,"partner_evidence","/productionMetrics/gas",productionMetrics.method);
  if(productionMetrics.yoyOilDeclinePct!==null)put("production.subject_yoy_decline",{value:productionMetrics.yoyOilDeclinePct,unit:"percent",phase:"oil",through:productionMetrics.through},"partner_evidence","/productionMetrics",productionMetrics.method);
 }
 const reconciliation=partner&&input.reconciliationPolicy?reconcilePartnerProduction(regulator,partner.bundle,input.reconciliationPolicy):null;
 if(reconciliation){
  put("production.membership_scope",partner!.leases.filter(l=>l.lease===reconciliation.lease&&l.district===reconciliation.district),"partner_evidence","/partner/leases","matching_lease_membership_evidence_v1");
  put("production.reporting_period",reconciliation.policy,"provided_assumptions","/reconciliation/policy");
  put("production.variance_threshold",reconciliation.policy.thresholdPercent,"provided_assumptions","/reconciliation/policy/thresholdPercent");
  for(const [field,key] of Object.entries({"production.vendor_lease_sum":"vendorTotal","production.regulator_lease_total":"regulatorTotal","production.variance_pct":"variancePercent"})){
   const oil=reconciliation.oil[key as keyof typeof reconciliation.oil],gas=reconciliation.gas[key as keyof typeof reconciliation.gas];
   if(oil!==null||gas!==null)put(field,{oil,gas,oilStatus:reconciliation.oil.status,gasStatus:reconciliation.gas.status},"partner_evidence","/reconciliation",reconciliation.method);
  }
 }
 if(input.economics!==null){
  const assumptions=Gold2EconomicsInputSchema.parse(input.economics).assumptions;
  if(assumptions.from<input.asOf.slice(0,7))throw Error("Valuation start precedes report as-of month; align the forecast and valuation period");
  if(Date.parse(assumptions.providedAt)>Date.parse(input.asOf))throw Error("Report predates economic assumptions");
 }
 if(ownership.status==="calculated"&&Date.parse(ownership.position.reviewedAt)>Date.parse(input.asOf))throw Error("Report predates ownership review");
 const economics=input.economics!==null&&input.partner!==null?evaluateGold2Economics({api,title,position:input.position,partner:input.partner,economics:input.economics}):null;
 if(economics){
  for(const name of ["base","downside","upside"] as const)put(`economics.${name}_value`,economics.values[name],"provided_assumptions",`/economics/scenarios/${name}`,economics.method);
  if(economics.sensitivity.some(c=>c.valueUsd!==null))put("economics.sensitivity",economics.sensitivity,"provided_assumptions","/economics/sensitivity",economics.method);
  put("economics.maximum_buy_price",economics.maximumBuyPrice,"provided_assumptions","/economics/maximumBuyPrice","positive_underwrite_value_times_one_minus_supplied_margin_v1");
  put("economics.price_deck",economics.settings.priceDeck,"provided_assumptions","/economics/settings/priceDeck");
  put("economics.underwrite_basis",economics.settings.underwriteBasis,"provided_assumptions","/economics/settings/underwriteBasis");
  const a=economics.settings.assumptions;
  put("economics.risk_haircut",{appliedFraction:0,basis:"No blanket haircut is applied by this cashflow engine; measured evidence scenarios are separate."},"decision_engine","/economics","explicit_engine_cost_scope_v1");
  put("economics.differentials",{appliedOilUsdBbl:0,appliedGasUsdMcf:0,basis:"Supplied prices are used directly. Actual marketing differentials were not independently established."},"decision_engine","/economics","explicit_engine_cost_scope_v1");
  put("economics.cashflow_timing","month_end_from_explicit_valuation_start","provided_assumptions","/economics/scenarios/base","partner_forecast_royalty_month_end_discount_v1");
  for(const [field,key] of Object.entries({"economics.asking_price":"askingPriceUsd","economics.minimum_margin":"minimumValueMarginFraction","economics.discount_rate":"annualDiscountFraction","economics.horizon":"horizonMonths","economics.costs":"monthlyPositionDeductionsUsd","economics.tax_assumptions":"revenueTaxFraction"}))put(field,a[key as keyof typeof a],"provided_assumptions",`/economics/settings/assumptions/${key}`);
  put("economics.assumption_provenance",{id:a.id,providedBy:a.providedBy,providedAt:a.providedAt,basis:a.basis},"provided_assumptions","/economics/settings/assumptions","select_assumption_provenance_v1");
  const base=economics.scenarios.base.scenario;
  if(base?.status==="calculated")put("economics.monthly_cashflows",base.cashflows,"provided_assumptions","/economics/scenarios/base/scenario/cashflows",base.method);
 }
 const forecastSelection=input.forecastSelection??(economics?{forecastId:economics.settings.assumptions.forecastId,scenario:economics.settings.assumptions.scenario,from:economics.settings.assumptions.from}:null);
 const forecastMetrics=partner&&forecastSelection?subjectForecastMetrics(partner.bundle,{api,asOf:input.asOf,...forecastSelection}):null;
 if(forecastMetrics){
  for(const [field,key] of Object.entries({"forecast.next12_oil":"next12Oil","forecast.next12_gas":"next12Gas","forecast.remaining_oil":"remainingOil","forecast.remaining_gas":"remainingGas"})){
   const metric=forecastMetrics[key as "next12Oil"|"next12Gas"|"remainingOil"|"remainingGas"];
   if(metric.value!==null)put(field,{value:metric.value,unit:field.endsWith("oil")?"bbl":"Mcf",from:forecastMetrics.selection.from,through:field.includes("remaining")?forecastMetrics.through:shiftMonth(forecastMetrics.selection.from,11),basis:field.includes("remaining")?"provided_contiguous_forecast_horizon_only":"next_12_months"},"partner_evidence",`/forecastMetrics/${key}`,forecastMetrics.method);
   else fields[field]={status:"insufficient_data",value:null,reason:metric.reason,origin:null};
  }
  put("forecast.model_version",forecastMetrics.modelVersion,"partner_evidence","/forecastMetrics/modelVersion");
  put("forecast.generated_at",forecastMetrics.generatedAt,"partner_evidence","/forecastMetrics/generatedAt");
  put("forecast.method",{method:forecastMetrics.method,disclosure:forecastMetrics.disclosure},"partner_evidence","/forecastMetrics",forecastMetrics.method);
 }
 const sourceInventory={regulatory:regulator.evidence.map(({data,...source})=>source),partner:partner?.bundle.sources.map(({data,...source})=>source)??[],title:title?.sourceInventory??[]};
 const searchCoverage={regulatory:deriveCoverageFromAttempts(input.attempts),title:title?.searchCoverage??null,partner:partner?"supplied_cited_export":"not_connected",titleScope:title?"provided_analysis_only":"no_title_analysis_supplied",titleLookup:input.titleLookup??null};
 put("evidence.source_inventory",sourceInventory,"regulatory_evidence","/sourceInventory","retained_source_inventory_v1");
 put("evidence.search_coverage",searchCoverage,"regulatory_evidence","/searchCoverage","retained_query_coverage_v1");
 const evidenceScenarios=evaluateEvidenceScenarios({...input,scenarios:input.evidenceScenarios??null});
 if(evidenceScenarios.scenarios.length)put("title.scenarios",evidenceScenarios.scenarios,"reviewed_position","/evidenceScenarios/scenarios",evidenceScenarios.method);
 for(const [key,property] of Object.entries({"economics.measured_exposure":"measuredExposure","economics.evidence_adjusted_value":"evidenceAdjustedValue","economics.risk_adjusted_value":"riskAdjustedValue"}))put(key,evidenceScenarios[property as "measuredExposure"|"evidenceAdjustedValue"|"riskAdjustedValue"],"reviewed_position",`/evidenceScenarios/${property}`,property==="evidenceAdjustedValue"?"base_minus_nonoverlapping_measured_exposure_v1":property==="riskAdjustedValue"?"downside_minus_nonoverlapping_measured_exposure_v1":evidenceScenarios.method);
 const quantifiers:Record<string,import("../title/exception-impact").Quantifier>={};
 for(const scenario of evidenceScenarios.scenarios){
  if(scenario.findingIds.length!==1||scenario.valueImpactUsd===null||scenario.ownership.status!=="calculated"||ownership.status!=="calculated")continue;
  const findingId=scenario.findingIds[0];
  if(evidenceScenarios.scenarios.filter(s=>s.findingIds.includes(findingId)).length!==1)continue;
  quantifiers[findingId]={valueImpactUsd:scenario.valueImpactUsd,nriFrom:Number(ownership.nri.n)/Number(ownership.nri.d),nriTo:Number(scenario.ownership.nri.n)/Number(scenario.ownership.nri.d),note:scenario.disclosure};
 }
 const titleContext=titleDecisionContext(title,api,ownership.status==="calculated"?ownership.position.tractId:null,quantifiers);
 if(title&&titleContext.scope){
  const branches=title.branches.filter(b=>titleContext.scope!.tractIds.includes(b.tractId));
  const ids=new Set(branches.flatMap(b=>b.events.map(e=>e.instrumentId)));
  for(const [key,value] of Object.entries({"title.ownership_graph":branches,"title.encumbrances":branches.flatMap(b=>b.encumbrances),"title.instruments":title.chronology.filter(r=>ids.has(r.instrumentId))})){
   if(branches.length)put(key,value,"title_analysis","/input/title","confirmed_subject_tract_title_scope_v1");
   else fields[key]={status:"insufficient_data",value:null,reason:"No confirmed title branch is linked to the selected API/tract.",origin:null};
  }
 }
 if(titleContext.exceptions!==null&&titleContext.uncitedFindings.length===0)put("title.exceptions",titleContext.exceptions,"title_analysis","/titleContext/exceptions","finding_type_to_independent_exception_properties_v1");
 const rulesInput:Gold2RuleInput={identityResolved:regulator.fields["identity.api10"].value===api,positionIdentified:ownership.status==="calculated",nriComputable:ownership.status==="calculated",
  baseValue:economics?.values.base??null,maximumBuyPrice:economics?.maximumBuyPrice??null,askingPrice:economics?.settings.assumptions.askingPriceUsd??null,measuredExposure:evidenceScenarios.measuredExposure,
  exceptions:(titleContext.exceptions??[]).map(x=>({id:x.findingId,closingBlocker:x.blocksClosing,resolved:false,measuredImpact:evidenceScenarios.scenarios.find(s=>s.findingIds.length===1&&s.findingIds[0]===x.findingId)?.valueImpactUsd??x.quantifiedValueImpactUsd,decisionMaterial:x.decisionMaterial})),
  productionReconciled:reconciliation?reconciliation.decisionEffect==="RECONCILIATION_PASSED":null,
  reviewItemsOpen:titleContext.reviewItemsOpen,titleEvidenceSufficient:titleContext.evidenceSufficient,
  confidenceDomains:[
   {domain:"title",level:titleContext.evidenceSufficient?(titleContext.exceptions?.length?"LOW":"MEDIUM"):"INSUFFICIENT_DATA",decisionMaterial:true,reason:titleContext.reason},
   {domain:"ownership",level:ownership.status==="calculated"?"MEDIUM":"INSUFFICIENT_DATA",decisionMaterial:true,reason:ownership.reason??"Exact apparent interest computed from the selected reviewed holding; title exceptions remain independent."},
   {domain:"production",level:reconciliation?.decisionEffect==="RECONCILIATION_PASSED"?"MEDIUM":partner?"LOW":"INSUFFICIENT_DATA",decisionMaterial:true,reason:reconciliation?.decisionEffect??"No cross-source production reconciliation is available."},
   {domain:"forecast",level:forecastMetrics?.modelVersion?"MEDIUM":"INSUFFICIENT_DATA",decisionMaterial:true,reason:forecastMetrics?.disclosure??"No selected cited subject forecast is available."},
   {domain:"economics",level:economics?.values.base!=null?"MEDIUM":"INSUFFICIENT_DATA",decisionMaterial:true,reason:economics?.values.base!=null?"Calculated from supplied assumptions and reviewed NRI; not an independent market valuation.":"Ownership, selected forecast and explicit economic assumptions are required."},
  ],
 };
 const decision=evaluateGold2Rules(rulesInput);
 for(const [field,key] of Object.entries({"decision.posture":"posture","decision.closing_readiness":"closing","decision.confidence":"confidence","decision.rule_trace":"trace","decision.closing_rule_trace":"closing"}))put(field,decision[key as keyof typeof decision],"decision_engine",`/decision/${key}`,"gold2_rules_2.0.0");
 put("decision.next_actions",titleContext.actions,"decision_engine","/titleContext/actions","finding_resolution_actions_v1");
 put("decision.supporting_reasons",decision.trace.filter(r=>r.outcome==="NO_MATCH"),"decision_engine","/decision/trace","evaluated_nonblocking_rule_conditions_v1");
 put("decision.risk_reasons",decision.trace.filter(r=>r.outcome==="MATCH"),"decision_engine","/decision/trace","matched_decision_conditions_v1");
 put("decision.confidence_domains",rulesInput.confidenceDomains,"decision_engine","/rulesInput/confidenceDomains");
 explainFieldGaps(fields,input,regulator);
 const chartInputs=buildChartInputs(fields);
 const calculations=GOLD2_CALCULATIONS.map(c=>({...c,status:c.outputs.every(k=>fields[k].value===null)?"unavailable" as const:"recomputed" as const,
  reason:c.outputs.every(k=>fields[k].value===null)?c.outputs.map(k=>`${k}: ${fields[k].reason}`).join("; "):null,
  outputOrigins:Object.fromEntries(c.outputs.map(k=>[k,fields[k].origin]))}));
 return {schemaVersion:GOLD2_VERSION,state:"draft_not_validated" as const,input,inputHash:payloadHash(input),regulator,chartInputs,calculations,wellContext,titleContext,evidenceScenarios,sourceInventory,searchCoverage,partner,measurements,ownership,productionMetrics,forecastMetrics,reconciliation,economics,rulesInput,decision,fields,disclosures:GOLD2_DISCLOSURES,
  implementationGaps:Object.entries(fields).filter(([,f])=>f.reasonCode==="engine_not_connected").map(([key])=>`Unimplemented field mapping: ${key}`),
 };
}
export function validateGold2Draft(draft:ReturnType<typeof assembleGold2Draft>):string[]{
 try{const recomputed=assembleGold2Draft(draft.input);return JSON.stringify(recomputed)===JSON.stringify(draft)?[]:["GOLD2 draft differs from recomputed engine outputs or retained inputs"];}catch(error){return [String(error)];}
}
