/** Reviewed mineral-position bridge. Never infers an owner or divides collective holdings. */
import {z} from "zod";
import {Fraction} from "../title/fraction";
import type {TitleChainAnalysis} from "../title/chain-types";
import {normalizeApiNumber} from "../normalization";
import {payloadHash,pointerValue} from "./partner-input";
const exact=z.object({n:z.string().regex(/^\d{1,30}$/),d:z.string().regex(/^[1-9]\d{0,29}$/)}).strict();
const ref=z.object({sourceId:z.string().min(1),pointer:z.string().refine(p=>p===""||p.startsWith("/"))}).strict();
const source=z.object({id:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),data:z.unknown(),documentId:z.string().min(1),documentHash:z.string().regex(/^[a-f0-9]{64}$/),page:z.number().int().positive(),retrievedAt:z.string().datetime({offset:true})}).strict();
export const ReviewedPositionSchema=z.object({
 contract:z.literal("mineralflow-reviewed-mineral-position-1.0"),api:z.string(),analysisId:z.string().min(1),
 tractId:z.string().min(1),canonicalPartyId:z.string().min(1),holdingId:z.string().min(1),
 reviewedBy:z.string().min(1),reviewedAt:z.string().datetime({offset:true}),
 // References point to exact rational quantities extracted and reviewed from retained documents.
 grossAcres:ref,unitAcres:ref,leaseRoyalty:ref,tractParticipation:ref,
 sources:z.array(source).min(1),
}).strict();
export function linkReviewedMineralPosition(apiInput:string,title:TitleChainAnalysis|null,positionInput:unknown){
 const normalized=normalizeApiNumber(apiInput);if(!normalized)throw Error("Invalid ownership API");
 const missing=(reason:string,reasonCode:"position_not_supplied"|"reviewed_documents_insufficient")=>({status:"insufficient_data" as const,api:normalized.api10,reason,reasonCode,nri:null});
 if(positionInput===null||positionInput===undefined)return missing("No evaluated owner/tract position was supplied; an API number does not identify the interest offered for acquisition.","position_not_supplied");
 const p=ReviewedPositionSchema.parse(positionInput);
 if(normalizeApiNumber(p.api)?.api10!==normalized.api10)throw Error("Ownership position API mismatch");
 if(!title)return missing("No reviewed title analysis accompanies the evaluated position.","reviewed_documents_insufficient");
 if(!Number.isFinite(Date.parse(title.generatedAt))||Date.parse(title.generatedAt)>Date.parse(p.reviewedAt))throw Error("Position review predates or cannot verify its title analysis timestamp");
 if(p.analysisId!==title.analysisId)throw Error("Ownership position references a different title analysis");
 const sources=new Map(p.sources.map(s=>[s.id,s]));
 if(sources.size!==p.sources.length)throw Error("Duplicate ownership source IDs");
 for(const s of sources.values()){
  const scope=z.object({api:z.string(),tractId:z.string(),canonicalPartyId:z.string()}).passthrough().parse(s.data);
  if(normalizeApiNumber(scope.api)?.api10!==normalized.api10||scope.tractId!==p.tractId||scope.canonicalPartyId!==p.canonicalPartyId)throw Error("Ownership evidence scope mismatch");
  if(payloadHash(s.data)!==s.sha256)throw Error(`Ownership evidence hash mismatch: ${s.id}`);
  const document=title.sourceInventory.find(d=>d.documentId===s.documentId);
  if(!document||document.contentHash!==s.documentHash||document.pageCount!==null&&s.page>document.pageCount)throw Error(`Ownership source is outside reviewed title inventory: ${s.id}`);
  if(Date.parse(s.retrievedAt)>Date.parse(p.reviewedAt))throw Error("Ownership evidence was retrieved after review");
 }
 const quantity=(r:z.infer<typeof ref>,name:string)=>{
  const s=sources.get(r.sourceId);if(!s)throw Error(`Missing ownership citation: ${name}`);
  const v=exact.parse(pointerValue(s.data,r.pointer));return new Fraction(v.n,v.d);
 };
 const gross=quantity(p.grossAcres,"gross acres"),unit=quantity(p.unitAcres,"unit acres"),royalty=quantity(p.leaseRoyalty,"lease royalty"),participation=quantity(p.tractParticipation,"tract participation");
 if(gross.isZero()||unit.isZero()||gross.gt(unit)||royalty.gt(Fraction.one())||participation.gt(Fraction.one()))throw Error("Invalid acreage, royalty or tract participation");
 // This bridge covers acreage-based pooled minerals. Other allocation mechanisms must have their own evidenced formula.
 if(!gross.div(unit).eq(participation))throw Error("Reviewed participation contradicts tract acreage divided by unit acreage");
 const tract=title.tracts.find(t=>t.id===p.tractId&&t.matchStatus==="confirmed");
 if(!tract)return missing("Evaluated tract is not confirmed in the selected title analysis.","reviewed_documents_insufficient");
 const wells=title.wells.filter(w=>normalizeApiNumber(w.api14??w.formatted??w.originalInput)?.api10===normalized.api10);
 if(!wells.some(w=>w.associations.some(a=>a.tractId===p.tractId&&a.reviewStatus==="confirmed")))return missing("Well-to-tract association has not been confirmed.","reviewed_documents_insufficient");
 const candidates=title.branches.filter(b=>b.tractId===p.tractId&&b.interestType==="mineral").flatMap(b=>b.apparentHolders.filter(h=>h.holdingId===p.holdingId).map(h=>({b,h})));
 if(candidates.length!==1)return missing("A unique mineral holding was not found in the evaluated tract.","reviewed_documents_insufficient");
 const {b,h}=candidates[0];
 if(h.parties.length!==1||h.parties[0].canonicalPartyId!==p.canonicalPartyId||h.status==="collective"||h.status==="unresolved"||b.unresolvedAllocations.length)return missing("Owner identity or allocation remains unresolved; collective interests are not divided by assumption.","reviewed_documents_insufficient");
 const share=Fraction.fromJson(h.share);
 if(!share||share.isNegative()||share.gt(Fraction.one()))return missing("The selected holding has no valid exact mineral fraction.","reviewed_documents_insufficient");
 const events=h.sourceEventIds.map(id=>b.events.find(e=>e.eventId===id));
 if(!events.length||events.some(e=>!e||!e.contentVerified||!e.citations.length))return missing("The selected holding lacks verified, cited instrument support.","reviewed_documents_insufficient");
 const nri=share.mul(participation).mul(royalty),nma=share.mul(gross);
 return {status:"calculated" as const,api:normalized.api10,reason:null,analysisId:title.analysisId,
 position:p,positionHash:payloadHash(p),mineralFraction:share.toJSON(),grossAcres:gross.toJSON(),unitAcres:unit.toJSON(),
 netMineralAcres:nma.toJSON(),tractParticipation:participation.toJSON(),leaseRoyalty:royalty.toJSON(),nri:nri.toJSON(),
 method:"mineral_fraction_times_reviewed_acreage_participation_times_lease_royalty_v1",
 citations:events.flatMap(e=>e!.citations),
 limitations:["Calculated apparent interest from the selected reviewed holding; no marketable-title or closing opinion.","Acreage-based mineral royalty only; working interests, NPRIs, overriding royalties and non-acreage allocation require their own reviewed calculation.","Unresolved title findings remain independent decision and closing inputs; a computable fraction does not cure them."]};
}
