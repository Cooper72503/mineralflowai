/** Execute the decision-layer boundary with retained partner and RRC evidence. */
import {readFile,mkdir,writeFile,rename} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {buildDecisionRecord} from "../lib/trrc/decision-record";
import {normalizePartnerInput} from "../lib/trrc/decision-layer/partner-input";
import {reconcilePartnerProduction} from "../lib/trrc/decision-layer/reconcile";
import {evaluateRoyaltyScenario} from "../lib/trrc/decision-layer/scenario";
import {normalizeApiNumber} from "../lib/trrc/normalization";
async function main(){
 const [inputPath,outputPath,...extra]=process.argv.slice(2);
 if(!inputPath||!outputPath||extra.length)throw Error("Usage: npm run decision:reconcile -- INPUT.json OUTPUT.json");
 const input=JSON.parse(await readFile(resolve(inputPath),"utf8"));
 const api=normalizeApiNumber(input.api??input.regulator?.case?.api10);
 if(!api||normalizeApiNumber(input.regulator?.case?.api10)?.api10!==api.api10||!Array.isArray(input.regulator.attempts))throw Error("Requested API and regulator capture must match");
 const partner=normalizePartnerInput(input.partner);
 const record=buildDecisionRecord({id:input.regulator.case.id,original_input:api.api10},input.regulator.attempts);
 const reconciliation=reconcilePartnerProduction(record,partner.bundle,input.policy);
 if(input.assumptions&&normalizeApiNumber(input.assumptions.api)?.api10!==api.api10)throw Error("Scenario assumptions must match requested API");
 const scenario=input.assumptions?evaluateRoyaltyScenario(partner.bundle,input.assumptions):null;
 const output={scenario,api:api.api10,generatedAt:record.generated_at,mode:partner.bundle.mode,partnerEvidence:partner.bundle.sources,regulatorEvidence:record.evidence,reconciliation};
 const destination=resolve(outputPath);await mkdir(dirname(destination),{recursive:true});
 const temporary=destination+`.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify(output,null,2)+"\n");await rename(temporary,destination);
 console.log(JSON.stringify({api:api.api10,mode:partner.bundle.mode,decisionEffect:reconciliation.decisionEffect,acquisitionDecision:reconciliation.acquisitionDecision,output:destination}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
