/** MineralFlow-owned interchange contract; not Novi's API schema. */
import {createHash} from "node:crypto";
import {z} from "zod";
import {WellMeasurementSchema,normalizeWellMeasurement} from "./well-measurement";
import {normalizeApiNumber} from "../normalization";
export const Month=z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
const api=z.string().transform((s,ctx)=>{const n=normalizeApiNumber(s);if(!n){ctx.addIssue({code:"custom",message:"Invalid Texas API"});return z.NEVER;}return n.api10;});
const oil=z.object({value:z.number().finite().nonnegative().nullable(),unit:z.enum(["bbl","Mbbl"])}).strict();
const gas=z.object({value:z.number().finite().nonnegative().nullable(),unit:z.enum(["Mcf","MMcf"])}).strict();
const monthly=z.object({kind:z.literal("well_monthly_production"),api,lease:z.string().min(1),district:z.string().min(1),month:Month,oil,gas}).strict();
const forecast=z.object({kind:z.literal("well_monthly_forecast"),volumeBasis:z.literal("gross_well"),api,forecastId:z.string().min(1),modelVersion:z.string().min(1),generatedAt:z.string().datetime({offset:true}),scenario:z.enum(["base","downside","upside"]),month:Month,oil,gas}).strict();
const membership=z.object({kind:z.literal("lease_membership"),lease:z.string().min(1),district:z.string().min(1),from:Month,through:Month,apis:z.array(api).min(1),completeness:z.enum(["complete","partial","unknown"])}).strict();
const source=z.object({id:z.string().min(1),provider:z.string().min(1),url:z.string().url().refine(s=>s.startsWith("https://")),retrievedAt:z.string().datetime({offset:true}),sha256:z.string().regex(/^[a-f0-9]{64}$/),data:z.unknown()}).strict();
const reference=z.object({sourceId:z.string().min(1),pointer:z.string().refine(s=>s===""||s.startsWith("/"))}).strict();
export const PartnerInputSchema=z.object({contract:z.literal("mineralflow-partner-production-0.1"),mode:z.enum(["partner_export","synthetic_fixture"]),sources:z.array(source),observations:z.array(reference)}).strict();
export type PartnerInput=z.infer<typeof PartnerInputSchema>;
export type PartnerReference=z.infer<typeof reference>;
export const payloadHash=(data:unknown)=>createHash("sha256").update(JSON.stringify(data)).digest("hex");
export function pointerValue(data:unknown,pointer:string):unknown{
 if(pointer==="")return data;
 return pointer.slice(1).split("/").reduce<unknown>((v,t)=>{
  const k=t.replace(/~1/g,"/").replace(/~0/g,"~");
  return v!==null&&typeof v==="object"&&Object.prototype.hasOwnProperty.call(v,k)?(v as Record<string,unknown>)[k]:undefined;
 },data);
}
export function normalizePartnerInput(input:unknown){
 const bundle=PartnerInputSchema.parse(input),sources=new Map(bundle.sources.map(s=>[s.id,s]));
 if(sources.size!==bundle.sources.length)throw Error("Duplicate partner evidence IDs");
 for(const s of bundle.sources)if(payloadHash(s.data)!==s.sha256)throw Error(`Partner payload hash mismatch: ${s.id}`);
 const months:{api:string;lease:string;district:string;month:string;oilBbl:number|null;gasMcf:number|null;citation:PartnerReference}[]=[];
 const forecasts:{api:string;forecastId:string;modelVersion:string;generatedAt:string;scenario:"base"|"downside"|"upside";month:string;oilBbl:number|null;gasMcf:number|null;citation:PartnerReference}[]=[];
 const leases:(z.infer<typeof membership>&{citation:PartnerReference})[]=[];
 const measurements:(ReturnType<typeof normalizeWellMeasurement>&{citation:PartnerReference})[]=[];
 const seen=new Set<string>();
 for(const citation of bundle.observations){
  const source=sources.get(citation.sourceId);if(!source)throw Error(`Unknown partner source: ${citation.sourceId}`);
  const r=z.discriminatedUnion("kind",[monthly,membership,forecast,WellMeasurementSchema]).parse(pointerValue(source.data,citation.pointer));
  if(r.kind==="well_measurement"){
   if(Date.parse(r.measuredAt)>Date.parse(source.retrievedAt))throw Error("Measurement postdates its source retrieval");
   measurements.push({...normalizeWellMeasurement(r),citation});continue;
  }
  if(r.kind==="lease_membership"){
   if(r.from>r.through||new Set(r.apis).size!==r.apis.length)throw Error("Invalid lease membership period or duplicate API");
   leases.push({...r,citation});continue;
  }
  const key=r.kind==="well_monthly_forecast"?`forecast:${r.api}:${r.forecastId}:${r.scenario}:${r.month}`:`production:${r.api}:${r.month}`;if(seen.has(key))throw Error(`Duplicate partner well month: ${key}`);seen.add(key);
  const oilBbl=r.oil.value===null?null:r.oil.value*(r.oil.unit==="Mbbl"?1000:1);
  const gasMcf=r.gas.value===null?null:r.gas.value*(r.gas.unit==="MMcf"?1000:1);
  if([oilBbl,gasMcf].some(v=>v!==null&&!Number.isFinite(v)))throw Error("Partner unit conversion overflow");
  if(r.kind==="well_monthly_forecast"){forecasts.push({api:r.api,forecastId:r.forecastId,modelVersion:r.modelVersion,generatedAt:r.generatedAt,scenario:r.scenario,month:r.month,oilBbl,gasMcf,citation});continue;}
  months.push({api:r.api,lease:r.lease,district:r.district,month:r.month,oilBbl,gasMcf,citation});
 }
 return {bundle,months,leases,forecasts,measurements};
}
