/** Integrated draft export for development/partner payload validation; does not claim GOLD acceptance. */
import {readFile,writeFile,rename,mkdir} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {assembleGold2Draft,validateGold2Draft,type Gold2Input} from "../lib/trrc/gold2/assemble";
async function main(){
 const [inputPath,outputPath]=process.argv.slice(2);
 if(!inputPath||!outputPath)throw Error("Usage: npm run decision:gold2-draft -- INPUT.json OUTPUT.json");
 const input=JSON.parse(await readFile(resolve(inputPath),"utf8")) as Gold2Input;
 const draft=assembleGold2Draft(input),errors=validateGold2Draft(draft);
 if(errors.length)throw Error(errors.join("; "));
 const out=resolve(outputPath);await mkdir(dirname(out),{recursive:true});
 const tmp=out+`.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(draft,null,2)+"\n");await rename(tmp,out);
 console.log(JSON.stringify({state:draft.state,output:out,implementationGaps:draft.implementationGaps}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
