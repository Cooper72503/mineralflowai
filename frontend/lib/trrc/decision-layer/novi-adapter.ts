/** Integration boundary owned by MineralFlow. No guessed Novi endpoints or credentials. */
import {normalizeApiNumber} from "../normalization";
import {normalizePartnerInput,type PartnerInput} from "./partner-input";
export type NoviReadResult=
 |{status:"available";api:string;adapterVersion:string;data:PartnerInput}
 |{status:"unavailable";api:string;adapterVersion:string;reasonCode:"partner_feed_unavailable"|"source_query_failed"|"source_returned_no_record";reason:string;retryable:boolean};
export interface NoviAdapter {
 readonly version:string;
 readWell(api:string,options?:{signal?:AbortSignal;timeoutMs?:number}):Promise<NoviReadResult>;
}
const checkedApi=(input:string)=>{const api=normalizeApiNumber(input);if(!api)throw Error("Invalid Texas API for Novi adapter");return api.api10;};
export function unavailableNoviAdapter():NoviAdapter {
 return {version:"mineralflow-novi-unconfigured-1",async readWell(input){const api=checkedApi(input);return {status:"unavailable",api,adapterVersion:this.version,reasonCode:"partner_feed_unavailable",reason:"No Novi transport or reviewed export is configured. No partner data was queried or inferred.",retryable:false};}};
}
/** An agreed Novi response mapper is injected separately from authenticated transport.
 * Raw errors are deliberately not included in reports (URLs/headers may contain credentials).
 * Timeout races bound even transports that fail to honor AbortSignal. */
export function createNoviAdapter(config:{version:string;fetchWell:(api:string,signal:AbortSignal)=>Promise<unknown>;mapResponse:(raw:unknown,api:string)=>PartnerInput|null}):NoviAdapter {
 if(!config.version.trim())throw Error("Novi adapter version is required");
 return {version:config.version,async readWell(input,options={}){
  const api=checkedApi(input),timeout=options.timeoutMs??30000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>120000)throw Error("Invalid Novi request timeout");
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let aborted=false;
  let rejectAbort:(error:Error)=>void=()=>{};
  const abort=()=>{aborted=true;controller.abort();rejectAbort(Error("aborted"));};
  const abortPromise=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  options.signal?.addEventListener("abort",abort,{once:true});
  try{
   if(options.signal?.aborted)throw Error("aborted");
   timer=setTimeout(abort,timeout);
   const raw=await Promise.race([config.fetchWell(api,controller.signal),abortPromise]);
   const data=config.mapResponse(raw,api);
   if(data===null)return {status:"unavailable",api,adapterVersion:this.version,reasonCode:"source_returned_no_record",reason:"The configured partner adapter returned no record for this API.",retryable:false};
   const normalized=normalizePartnerInput(data);
   if(normalized.bundle.mode==="synthetic_fixture")throw Error("Synthetic data cannot be returned by a live adapter");
   const apis=[...normalized.months.map(r=>r.api),...normalized.forecasts.map(r=>r.api),...normalized.leases.flatMap(r=>r.apis)];
   if(!apis.includes(api))throw Error("Partner response does not contain requested subject");
   return {status:"available",api,adapterVersion:this.version,data:normalized.bundle};
  }catch{
   return {status:"unavailable",api,adapterVersion:this.version,reasonCode:"source_query_failed",reason:aborted||options.signal?.aborted?"Partner request was cancelled or exceeded its time limit.":"Partner retrieval or evidence normalization failed; no values from this response were accepted.",retryable:true};
  }finally{if(timer)clearTimeout(timer);options.signal?.removeEventListener("abort",abort);}
 }};
}
