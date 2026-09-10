/**
 * Evidence contract for the existing diligence pipeline. This is not the GOLD
 * sample's unreleased 2.0 ruleset. Unconnected engines are explicit gaps.
 */
import { createHash } from "node:crypto";
import { latestSourceAttempts, type LiteSourceAttempt } from "./coverage";
import { normalizeApiNumber } from "./normalization";
import { buildEvidenceIndex } from "./evidence-index";
import type { TrrcDueDiligenceRun } from "./types";

export const REQUIRED_DECISION_FIELDS = [
  "identity.api10", "identity.api14", "identity.county", "identity.lease", "identity.district", "identity.operator", "identity.well_name", "identity.field", "identity.tract", "identity.evaluated_position", "identity.interest_scope",
  "production.lease_monthly", "production.subject_monthly", "production.vendor_lease_sum", "production.regulator_lease_total", "production.variance_pct", "production.variance_threshold", "production.subject_ttm_oil", "production.subject_ttm_gas", "production.subject_yoy_decline",
  "forecast.next12_oil", "forecast.remaining_oil", "forecast.remaining_gas", "forecast.method",
  "geology.latitude", "geology.longitude", "geology.map_symbol", "geology.survey", "geology.formation", "geology.tvd", "geology.tvdss", "geology.net_pay", "geology.porosity", "geology.water_saturation", "geology.pressure_gradient", "geology.net_to_gross", "geology.parent_child", "geology.same_bench_spacing", "geology.interference", "geology.wells_per_section", "geology.lateral_length", "geology.completion_stages", "geology.proppant", "geology.fluid",
  "regulatory.operator_standing", "regulatory.compliance", "regulatory.severance", "regulatory.orphan", "regulatory.plugging", "regulatory.injection", "regulatory.imaged_documents", "regulatory.permits",
  "title.instruments", "title.search_scope", "title.ownership_graph", "title.encumbrances", "title.exceptions", "title.scenarios",
  "ownership.mineral_fraction", "ownership.gross_acres", "ownership.net_mineral_acres", "ownership.unit_acres", "ownership.tract_participation", "ownership.lease_royalty", "ownership.nri",
  "economics.base_value", "economics.downside_value", "economics.upside_value", "economics.evidence_adjusted_value", "economics.risk_adjusted_value", "economics.measured_exposure", "economics.maximum_buy_price", "economics.asking_price", "economics.price_deck", "economics.costs", "economics.tax_assumptions", "economics.discount_rate", "economics.horizon", "economics.minimum_margin", "economics.sensitivity",
  "decision.posture", "decision.closing_readiness", "decision.confidence", "decision.rule_trace",
] as const;
export type DecisionFieldKey = typeof REQUIRED_DECISION_FIELDS[number];
export type Citation = { evidenceId: string; pointer: string };
export type DecisionField =
  | { status: "observed"; value: unknown; citations: Citation[]; reason: null }
  | { status: "calculated"; value: unknown; citations: Citation[]; reason: null; method: "texas_api10" | "hold_for_missing_inputs"; inputs: string[] }
  | { status: "unavailable" | "insufficient_data"; value: null; citations: Citation[]; reason: string };
export interface DecisionEvidence {
  id: string; source: string; sourceUrl: string; retrievedAt: string;
  status: string; error: string | null; sha256: string; data: Record<string, unknown>;
}
export interface DecisionRecord {
  schema_version: "provenance-1.0.0";
  run_id: string;
  input: string;
  generated_at: string;
  fields: Record<DecisionFieldKey, DecisionField>;
  evidence: DecisionEvidence[];
  limitations: string[];
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function at(data: unknown, pointer: string): unknown {
  if (pointer === "") return data;
  return pointer.slice(1).split("/").reduce<unknown>((v, k) =>
    v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k.replace(/~1/g,"/").replace(/~0/g,"~")] : undefined, data);
}
function finite(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finite);
  if (value && typeof value === "object") return Object.values(value).every(finite);
  return true;
}
export function buildDecisionRecord(run: Pick<TrrcDueDiligenceRun,"id"|"original_input"> & Partial<TrrcDueDiligenceRun>, attempts: LiteSourceAttempt[], now = new Date().toISOString()): DecisionRecord {
  const portals = buildEvidenceIndex(attempts, run as TrrcDueDiligenceRun);
  const evidence = latestSourceAttempts(attempts).map(a => {
    const data = a.result_data_json ?? {};
    return {id:a.source_id,source:a.source_name,sourceUrl:typeof data.query_url==="string" && data.query_url.startsWith("https://") ? data.query_url : portals.find(p=>p.source_name===a.source_name)?.portal_url ?? "",retrievedAt:a.attempted_at,status:a.status,error:a.error_message,sha256:digest(data),data};
  });
  const fields = Object.fromEntries(REQUIRED_DECISION_FIELDS.map(key=>[key,{
    status:"unavailable",value:null,citations:[],reason:
      key.startsWith("title.") ? "The separate title research job is not linked to this diligence run; reviewed tract-specific instruments are required." :
      key.startsWith("ownership.") ? "Evaluated interest, tract, allocation and reviewed ownership evidence are required; no ownership fraction is assumed." :
      key.startsWith("economics.") ? "Position-specific economics require evidenced ownership, forecast, price/cost/tax inputs and buyer criteria; generic screening defaults are not acquisition values." :
      key.startsWith("forecast.") || key.startsWith("production.subject") || key.startsWith("production.vendor") || key.startsWith("production.variance") ? "No matched, cited well-level vendor feed is connected to this run; lease production is not allocated to the subject well." :
      "Required evidence was not retrieved or no validated engine handoff populates this field."
  }])) as unknown as Record<DecisionFieldKey, DecisionField>;
  const usable = (source: string) => evidence.find(e=>e.source===source && e.status==="success" && !e.data.error && e.data.data_gap!==true && e.data.endpoint_available!==false && e.sourceUrl && Number.isFinite(Date.parse(e.retrievedAt)));
  const put = (key: DecisionFieldKey, source:string, pointers:string[], requireFound=true) => {
    const e=usable(source); if(!e || (requireFound && e.data.found!==true)) return;
    for(const pointer of pointers){const value=at(e.data,pointer);if(value===undefined||value===null||value===""||!finite(value))continue;
      fields[key]={status:"observed",value,citations:[{evidenceId:e.id,pointer}],reason:null};return;}
  };
  const wb=usable("search_by_api");
  const requested=normalizeApiNumber(run.original_input);
  const wells=Array.isArray(wb?.data.wells)?wb.data.wells as Record<string,unknown>[]:[];
  const matches=wells.filter(w=>typeof w.api_no==="string" && normalizeApiNumber(w.api_no)?.api10===requested?.api10 && requested!==null);
  const active=matches.filter(w=>w.on_schedule==="Y");
  const candidates=active.length?active:matches;
  const associations=new Set(candidates.filter(w=>w.lease_no && w.district).map(w=>`${w.district}:${w.lease_no}`));
  const ambiguous=associations.size>1;
  const index=wells.indexOf(candidates[0]);
  if(wb && index>=0){
    const pointer=`/wells/${index}/api_no`;
    fields["identity.api10"]={status:"calculated",value:requested!.api10,citations:[{evidenceId:wb.id,pointer}],reason:null,method:"texas_api10",inputs:[]};
    const pairs: [DecisionFieldKey,string[]][]=[
      ["identity.county",["county"]],["identity.lease",["lease_no"]],["identity.district",["district","dist_code"]],
      ["identity.operator",["operator_name"]],["identity.well_name",["well_name"]],["identity.field",["field_name"]],
    ];
    for(const [key,names] of pairs) {
      if (ambiguous && ["identity.lease","identity.district","identity.operator","identity.field"].includes(key)) continue;
      // A matching API can have several current completions or historical rows.
      // Populate a scalar only when all selected rows agree; never choose the first conflicting value.
      const values=candidates.map(w=>names.map(n=>w[n]).find(v=>v!==undefined&&v!==null&&v!==""));
      if(values.some(v=>v===undefined)||new Set(values.map(v=>JSON.stringify(v))).size!==1)continue;
      put(key,"search_by_api",names.map(n=>`/wells/${index}/${n}`));
    }
  }
  // Base-API queries do not verify a sidetrack/completion suffix, even if typed.
  fields["identity.api14"]={status:"insufficient_data",value:null,citations:[],reason:"RRC base-API lookup does not independently verify the requested sidetrack/completion suffix."};
  // These are explicitly lease-scoped raw rows. They are not subject-well totals.
  const prod=usable("fetch_production");
  if (prod && fields["identity.lease"].value === prod.data.lease_number && fields["identity.district"].value === prod.data.district) {
    put("production.lease_monthly","fetch_production",["/rows"]);
  } else if (prod?.data.found) {
    fields["production.lease_monthly"]={status:"insufficient_data",value:null,citations:[],reason:"Retrieved production lease/district does not match a uniquely resolved subject association."};
  }
  const gis=usable("fetch_gis_plat");
  const gisApi=typeof gis?.data.api_number==="string"?normalizeApiNumber(gis.data.api_number)?.api10:null;
  if(requested&&gisApi===requested.api10){
    if(typeof gis?.data.latitude==="number"&&gis.data.latitude>=-90&&gis.data.latitude<=90)put("geology.latitude","fetch_gis_plat",["/latitude"]);
    if(typeof gis?.data.longitude==="number"&&gis.data.longitude>=-180&&gis.data.longitude<=180)put("geology.longitude","fetch_gis_plat",["/longitude"]);
    put("geology.map_symbol","fetch_gis_plat",["/well_type"]);
    put("geology.survey","fetch_gis_plat",["/survey"]);
  }
  for(const [key,source,pointers] of [
    ["regulatory.operator_standing","search_by_operator",["/record"]],
    ["regulatory.compliance","fetch_compliance_violations",["/violations","/records"]],
    ["regulatory.severance","fetch_severance_records",["/records"]],
    ["regulatory.orphan","fetch_orphan_well",["/is_orphan","/records"]],
    ["regulatory.plugging","fetch_plugging_records",["/records"]],
    ["regulatory.injection","fetch_injection_records",["/records"]],
    ["regulatory.imaged_documents","fetch_coda_records",["/documents"]],
    ["regulatory.permits","fetch_drilling_permits",["/permits"]],
  ] as [DecisionFieldKey,string,string[]][])put(key,source,pointers,false);
  const blockers:DecisionFieldKey[]=["ownership.nri","title.instruments","forecast.next12_oil","economics.base_value","economics.minimum_margin"];
  fields["decision.posture"]={status:"calculated",value:"INSUFFICIENT_DATA",reason:null,citations:[],method:"hold_for_missing_inputs",inputs:blockers};
  fields["decision.closing_readiness"]={status:"insufficient_data",value:null,citations:[],reason:"Closing readiness cannot be evaluated without a linked title/evidence file and reviewed blockers."};
  const record:DecisionRecord={schema_version:"provenance-1.0.0",run_id:run.id,input:run.original_input,generated_at:now,fields,evidence,limitations:[
    "This contract exposes current pipeline evidence and gaps; it does not implement the GOLD sample's schema/ruleset 2.0.0.",
    "Evidence hashes protect captured parsed payload integrity; they are not hashes of original county instruments or raw regulator HTML.",
    "Source URLs are query portals; reproduce the query from the run identifiers and inspect the retained payload.",
    "A passed schema check measures honest representation, not source availability, verified ownership or investment readiness."
  ]};
  const errors=validateDecisionRecord(record);if(errors.length)throw new Error(`Decision Record validation failed: ${errors.join("; ")}`);
  return record;
}
export function validateDecisionRecord(record: DecisionRecord): string[] {
  const errors:string[]=[];
  if(record.schema_version!=="provenance-1.0.0")errors.push("Unsupported schema version");
  if(!Number.isFinite(Date.parse(record.generated_at)))errors.push("Invalid generation timestamp");
  for(const key of Object.keys(record.fields))if(!(REQUIRED_DECISION_FIELDS as readonly string[]).includes(key))errors.push(`Unexpected field ${key}`);
  const evidence=new Map(record.evidence.map(e=>[e.id,e]));
  if(evidence.size!==record.evidence.length)errors.push("Duplicate evidence IDs");
  for(const e of record.evidence)if(digest(e.data)!==e.sha256)errors.push(`Evidence hash mismatch: ${e.id}`);
  for(const key of REQUIRED_DECISION_FIELDS){
    const field=record.fields[key];if(!field){errors.push(`Missing field ${key}`);continue;}
    if(field.status==="unavailable"||field.status==="insufficient_data"){
      if(field.value!==null||!field.reason?.trim())errors.push(`Undisclosed gap ${key}`);continue;
    }
    if(!["observed","calculated"].includes(field.status)||field.value===null||!finite(field.value)){errors.push(`Invalid value ${key}`);continue;}
    const refs=field.citations.map(c=>({c,e:evidence.get(c.evidenceId)}));
    for(const {c,e} of refs)if(!e||e.status!=="success"||!/^https:\/\//.test(e.sourceUrl)||!Number.isFinite(Date.parse(e.retrievedAt))||e.data.error||e.data.data_gap===true||e.data.endpoint_available===false||at(e.data,c.pointer)===undefined)errors.push(`Invalid citation ${key}`);
    if(field.status==="observed"){
      if(!refs.length||!refs.some(({c,e})=>e&&JSON.stringify(at(e.data,c.pointer))===JSON.stringify(field.value)))errors.push(`Unsubstantiated observation ${key}`);
    }else if(field.status==="calculated"){
      if(field.method==="texas_api10" && key==="identity.api10"){
        const raw=refs[0]?.e ? at(refs[0].e.data,refs[0].c.pointer):null;
        if(typeof raw!=="string"||normalizeApiNumber(raw)?.api10!==field.value||normalizeApiNumber(record.input)?.api10!==field.value)errors.push(`Invalid API derivation ${key}`);
      }else if(field.method==="hold_for_missing_inputs" && key==="decision.posture"){
        if(field.value!=="INSUFFICIENT_DATA"||!field.inputs.length||!field.inputs.some(k=>["unavailable","insufficient_data"].includes(record.fields[k as DecisionFieldKey]?.status)))errors.push(`Unsubstantiated posture ${key}`);
      }else errors.push(`Unknown derivation ${key}`);
    }
  }
  return errors;
}
