import {createHash} from "node:crypto";
import {Fraction} from "./fraction";
/** Preserve database integer strings exactly; never round through Number. */
export function storedTitleFraction(n:unknown,d:unknown):Fraction|null {
 if(n===null||n===undefined){if(d===null||d===undefined)return null;throw Error("Incomplete title fraction");}
 const integer=(v:unknown)=>typeof v==="string"&&/^\d+$/.test(v)||typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
 if(!integer(n)||!integer(d)||BigInt(String(d))===BigInt(0))throw Error("Invalid or unsafe title fraction");
 return new Fraction(String(n),String(d));
}
/** Canonical key order, preserved array semantics, complete material inputs. */
export function titleInputFingerprint(input:unknown):string {
 const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==="object"?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
 return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}
