import {buildPortfolioRecord,type PortfolioRecord} from "../portfolio/record";
import {validateGold2Draft,type assembleGold2Draft} from "./assemble";
import {payloadHash} from "../decision-layer/partner-input";
type Gold=ReturnType<typeof assembleGold2Draft>;
/** One saved work product; package economics are not added across well reports. */
export function buildPackageDecision(record:PortfolioRecord,rows:{runId:string;draft:Gold}[]){
 const expected=new Set(record.input.members.flatMap(m=>m.runId?[m.runId]:[]));
 if(rows.length!==expected.size||new Set(rows.map(r=>r.runId)).size!==rows.length||rows.some(r=>!expected.has(r.runId)||r.draft.input.runId!==r.runId))throw Error("Incomplete or conflicting GOLD package membership");
 for(const row of rows){
  if(validateGold2Draft(row.draft).length)throw Error("Saved GOLD draft requires regeneration");
  const retained=record.retainedRunRecords[row.runId];
  if(retained&&payloadHash(retained.evidence)!==payloadHash(row.draft.regulator.evidence))throw Error("Package and GOLD evidence snapshots differ");
 }
 const recomputed=buildPortfolioRecord(record.input,rows.map(r=>({id:r.runId,original_input:record.input.members.find(m=>m.runId===r.runId)!.input,status:record.inventory.members.find(m=>m.runId===r.runId)!.runStatus,attempts:r.draft.input.attempts})),record.generatedAt);
 if(payloadHash(recomputed)!==payloadHash(record))throw Error("Saved portfolio differs from recomputed evidence and economics");
 return {schemaVersion:"mineralflow-gold-package-2.0.0",asOf:record.generatedAt,decision:record.decision,
  economics:record.conditionalEconomics??{status:"insufficient_data",reason:"Explicit operating, price and purchase assumptions were not supplied."},
  production:record.production,forecast:record.forecastReadiness,inventory:record.inventory,
  title:rows.map(r=>({runId:r.runId,api:r.draft.input.api,lookup:r.draft.input.titleLookup,ownership:r.draft.ownership,context:r.draft.titleContext,analysis:r.draft.input.title})),
  wellRecords:rows,portfolioRecord:record,
  disclosures:[...record.disclosures,"Package economics are calculated once per unique RRC lease stream, never summed from per-well reports.","MineralFlow's own forecast, cash-flow and exit engines are used. No Novi data or forecast is required.","Conditional operated WI/NRI assumptions are not established by a reviewed mineral/royalty position. Acquisition approval remains withheld until sale scope and ownership are supported."]};
}
