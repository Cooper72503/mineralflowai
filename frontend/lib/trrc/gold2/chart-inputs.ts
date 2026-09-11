/** Plot-ready evidence inputs. PDF rendering/visual acceptance is an independent gate. */
import {GOLD2_CHARTS} from "./contract";
import type {DraftField} from "./assemble";
import {payloadHash} from "../decision-layer/partner-input";
export function buildChartInputs(fields:Record<string,DraftField>){
 return GOLD2_CHARTS.map(spec=>{
  const inputs=Object.fromEntries(spec.fields.map(key=>[key,fields[key]]));
  const missing=spec.fields.filter(key=>fields[key].value===null);
  return {id:spec.id,inputFields:[...spec.fields],status:missing.length?"unavailable" as const:"ready" as const,
   inputs,inputHash:payloadHash(inputs),reason:missing.length?missing.map(key=>`${key}: ${fields[key].reason}`).join("; "):null};
 });
}
