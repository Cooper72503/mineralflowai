import {payloadHash} from "../../decision-layer/partner-input";
import {buildOwnershipGraph} from "../../title/ownership-graph";
import {buildGraphInput,TRACT_A} from "../../title/__tests__/fixtures/instruments";
import type {TitleChainAnalysis} from "../../title/chain-types";
const api="4216502733";
export function reviewedPositionFixture(){
 const graph=buildOwnershipGraph({...buildGraphInput([{id:"deed",executed:"2000-01-01",from:["Synthetic Grantor"],to:["Synthetic Buyer"],claims:[{interest:"mineral",fraction:"1/4",basis:"of_entire_estate"}]}]),interestScope:["minerals"]});
 const holding=graph.branches[0].apparentHolders.find(h=>h.parties[0].displayName==="Synthetic Buyer")!;
 const terms={api,tractId:TRACT_A.id,canonicalPartyId:holding.parties[0].canonicalPartyId!,gross:{n:"160",d:"1"},unit:{n:"640",d:"1"},royalty:{n:"3",d:"16"},participation:{n:"1",d:"4"}};
 const title:TitleChainAnalysis={schemaVersion:"1.0.0",jobId:"synthetic-job",version:1,generatedAt:"2026-09-10T00:00:00Z",interestScope:["minerals"],researchStartDate:null,asOfDate:null,status:"INSUFFICIENT_DATA",statusDisplay:"Insufficient data",statusRule:"fixture",chronology:[],findings:graph.findings,searchCoverage:[],limitations:["Synthetic test"],reviewQueueOpenCount:0,statement:"Synthetic test",analysisId:"analysis",tracts:[TRACT_A],branches:graph.branches,
  wells:[{wellId:"well",wellName:"Synthetic well",operatorName:null,countyName:null,resolutionStatus:"resolved",validationError:null,resolutionError:null,originalInput:api,api14:null,formatted:null,associations:[{tractId:TRACT_A.id,tractLabel:TRACT_A.tractLabel,associationType:"user_supplied",confidence:1,reviewStatus:"confirmed"}]}],
  sourceInventory:[{documentId:"doc-deed",source:"synthetic",sourceIdentifier:null,sourceUrl:null,fileName:"synthetic-deed.pdf",documentCategory:"deed",retrievedAt:"2026-09-09T00:00:00Z",hasTextLayer:true,ocrStatus:"not_needed",extractionStatus:"complete",instrumentIds:["deed"],contentHash:"a".repeat(64),pageCount:1}]};
 const ref=(key:string)=>({sourceId:"reviewed-terms",pointer:`/${key}`});
 const position={contract:"mineralflow-reviewed-mineral-position-1.0",api,analysisId:title.analysisId,tractId:TRACT_A.id,canonicalPartyId:terms.canonicalPartyId,holdingId:holding.holdingId,reviewedBy:"Synthetic Reviewer",reviewedAt:"2026-09-10T00:00:00Z",grossAcres:ref("gross"),unitAcres:ref("unit"),leaseRoyalty:ref("royalty"),tractParticipation:ref("participation"),sources:[{id:"reviewed-terms",sha256:payloadHash(terms),data:terms,documentId:"doc-deed",documentHash:"a".repeat(64),page:1,retrievedAt:"2026-09-09T00:00:00Z"}]};
 return {title,position,holding};
}
