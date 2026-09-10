/** Conditional royalty scenario using partner forecasts, not a second forecast engine. */
import {z} from "zod";
import {monthlyDiscountRate} from "../economics";
import {Fraction} from "../title/fraction";
import {normalizeApiNumber} from "../normalization";
import {normalizePartnerInput,Month,payloadHash} from "./partner-input";
export const DealAssumptionsSchema=z.object({
 id:z.string().min(1),basis:z.literal("user_assumption"),providedBy:z.string().min(1),providedAt:z.string().datetime({offset:true}),
 api:z.string(),positionType:z.literal("mineral_royalty"),forecastId:z.string().min(1),scenario:z.enum(["base","downside","upside"]),
 nri:z.object({n:z.string().regex(/^\d{1,18}$/),d:z.string().regex(/^\d{1,18}$/)}).strict(),
 from:Month,horizonMonths:z.number().int().min(1).max(600),
 oilUsdBbl:z.number().finite().nonnegative(),gasUsdMcf:z.number().finite().nonnegative(),
 revenueTaxFraction:z.number().finite().min(0).max(1),monthlyPositionDeductionsUsd:z.number().finite().nonnegative(),
 annualDiscountFraction:z.number().finite().min(0).max(1),minimumValueMarginFraction:z.number().finite().min(0).lt(1),askingPriceUsd:z.number().finite().nonnegative().nullable(),
}).strict();
export function evaluateRoyaltyScenario(partnerInput:unknown,assumptionInput:unknown){
 const partner=normalizePartnerInput(partnerInput),a=DealAssumptionsSchema.parse(assumptionInput);
 const api=normalizeApiNumber(a.api);if(!api)throw Error("Invalid scenario API");
 const fraction=Fraction.fromJson(a.nri);if(!fraction||fraction.isNegative()||fraction.gt(Fraction.one()))throw Error("NRI must be a valid fraction between zero and one");
 const months=partner.forecasts.filter(r=>r.api===api.api10&&r.forecastId===a.forecastId&&r.scenario===a.scenario).sort((x,y)=>x.month.localeCompare(y.month));
 const metadata={mode:partner.bundle.mode,api:api.api10,assumptions:a,assumptionsHash:payloadHash(a),forecastSourceCitations:months.map(m=>m.citation),ownershipStatus:"USER_ASSUMPTION_NOT_VERIFIED",closingReadiness:"NOT_EVALUATED",method:"partner_forecast_royalty_month_end_discount_v1"};
 const missing=(reason:string)=>({...metadata,status:"insufficient_data" as const,reason,presentValueUsd:null,maximumPriceUnderAssumptionsUsd:null,priceComparison:"NOT_EVALUATED",cashflows:[]});
 if(!months.length)return missing("No cited forecast matches the subject, selected forecast ID and scenario.");
 if(new Set(months.map(m=>m.modelVersion+":"+m.generatedAt)).size!==1)return missing("Selected forecast mixes model versions or generation timestamps.");
 const nri=Number(fraction.n)/Number(fraction.d),discount=monthlyDiscountRate(a.annualDiscountFraction);
 let cursor=a.from,presentValue=0;
 const cashflows:{month:string;netCashflowUsd:number;discountedCashflowUsd:number}[]=[];
 for(let i=0;i<a.horizonMonths;i++){
  const row=months.find(m=>m.month===cursor);
  if(!row||row.oilBbl===null||row.gasMcf===null)return missing(`Missing oil or gas forecast volume for ${cursor}; no zero or extrapolation is assumed.`);
  if(row.month<row.generatedAt.slice(0,7))return missing("A forecast month precedes its model generation month.");
  const revenue=(row.oilBbl*a.oilUsdBbl+row.gasMcf*a.gasUsdMcf)*nri;
  const netCashflowUsd=revenue*(1-a.revenueTaxFraction)-a.monthlyPositionDeductionsUsd;
  const discountedCashflowUsd=netCashflowUsd/Math.pow(1+discount,i+1);
  if(!Number.isFinite(netCashflowUsd)||!Number.isFinite(discountedCashflowUsd))throw Error("Nonfinite scenario cash flow");
  presentValue+=discountedCashflowUsd;cashflows.push({month:cursor,netCashflowUsd,discountedCashflowUsd});
  const y=Number(cursor.slice(0,4)),m=Number(cursor.slice(5));cursor=m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,"0")}`;
 }
 if(!Number.isFinite(presentValue))throw Error("Nonfinite scenario value");
 const limit=presentValue>0?presentValue*(1-a.minimumValueMarginFraction):null;
 return {...metadata,status:"calculated" as const,reason:null,presentValueUsd:presentValue,maximumPriceUnderAssumptionsUsd:limit,
 priceComparison:a.askingPriceUsd===null?"ASKING_PRICE_UNAVAILABLE":limit===null?"NONPOSITIVE_MODELED_VALUE":a.askingPriceUsd<=limit?"WITHIN_ASSUMPTION_LIMIT":"EXCEEDS_ASSUMPTION_LIMIT",cashflows,
 limitations:["Conditional scenario value, not evidenced ownership or an acquisition recommendation.","Minimum margin means (present value minus purchase price) divided by present value.","Oil and gas only; no NGL, additional reserves or terminal value is inferred.","Amounts use month-end discounting from the explicit scenario start; all deductions and taxes are supplied assumptions."]};
}
