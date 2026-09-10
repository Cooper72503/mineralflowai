/** MineralFlow's well-measurement interchange, not a claim about Novi's native schema. */
import {z} from "zod";
import {normalizeApiNumber} from "../normalization";
export const MEASUREMENT_UNITS={
 formation:["name"],tvd:["ft","m"],reference_elevation:["ft","m"],net_pay:["ft","m"],gross_interval:["ft","m"],
 porosity:["fraction","percent"],water_saturation:["fraction","percent"],pressure_gradient:["psi/ft"],net_to_gross:["fraction","percent"],
 same_bench_spacing:["ft","m"],lateral_length:["ft","m"],completion_stages:["count"],proppant:["lb"],fluid:["bbl"],
} as const;
export type MeasurementProperty=keyof typeof MEASUREMENT_UNITS;
export const WellMeasurementSchema=z.object({
 kind:z.literal("well_measurement"),scope:z.literal("subject_well"),
 api:z.string().transform((s,ctx)=>{const n=normalizeApiNumber(s);if(!n){ctx.addIssue({code:"custom",message:"Invalid measurement API"});return z.NEVER;}return n.api10;}),
 property:z.enum(Object.keys(MEASUREMENT_UNITS) as [MeasurementProperty,...MeasurementProperty[]]),
 value:z.union([z.number().finite(),z.string().trim().min(1)]),unit:z.string(),measuredAt:z.string().datetime({offset:true}),
 referencePoint:z.enum(["KB","DF","GL"]).nullable(),verticalDatum:z.enum(["MSL"]).nullable(),
}).strict();
export function normalizeWellMeasurement(raw:unknown){
 const r=WellMeasurementSchema.parse(raw);
 if(!(MEASUREMENT_UNITS[r.property] as readonly string[]).includes(r.unit))throw Error(`Unsupported ${r.property} unit: ${r.unit}`);
 if(r.property==="formation"){
  if(typeof r.value!=="string")throw Error("Formation must be a reported name");
  return {...r,normalizedValue:r.value,normalizedUnit:"name"};
 }
 if(typeof r.value!=="number"||r.property!=="reference_elevation"&&r.value<0)throw Error(`Invalid ${r.property} value`);
 const normalizedValue=r.unit==="m"?r.value/0.3048:r.unit==="percent"?r.value/100:r.value;
 if(!Number.isFinite(normalizedValue))throw Error("Measurement conversion overflow");
 if(["porosity","water_saturation","net_to_gross"].includes(r.property)&&normalizedValue>1)throw Error("Physical fraction exceeds one");
 if(r.property==="completion_stages"&&!Number.isInteger(r.value))throw Error("Completion stage count must be an integer");
 if(["tvd","reference_elevation"].includes(r.property)&&(!r.referencePoint||!r.verticalDatum))throw Error("Depth measurements require a reference point and vertical datum");
 return {...r,normalizedValue,normalizedUnit:r.unit==="m"?"ft":r.unit==="percent"?"fraction":r.unit};
}
