/** Resolve a registry picker against the requested identity, never its first row. */
export function selectExactOperator(options:{value:string;text:string}[],name:string|null,number:string|null):string {
 const normalize=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]/g,"");
 const matches=options.filter(o=>{
  if(number)return o.value===number||o.text.match(/^\s*(\d{6})\b/)?.[1]===number;
  const candidate=o.text.replace(/^\s*\d{6}\s*[-–—:]?\s*/,"");
  return !!name&&normalize(candidate)===normalize(name);
 });
 if(matches.length!==1)throw Error(`Operator identity is ${matches.length>1?"ambiguous":"unverified"}; an exact registry name or operator number is required`);
 return matches[0].value;
}
export function confirmedOpenCount(rows:{compliant_on_reinspection:string;last_enforcement_action:string}[]):number|null {
 let count=0;
 for(const r of rows){
  const compliance=r.compliant_on_reinspection.trim().toUpperCase();
  if(compliance==="N"||/\b(open|unresolved)\b/i.test(r.last_enforcement_action))count++;
  else if(compliance!=="Y"&&!/\b(closed|resolved)\b/i.test(r.last_enforcement_action))return null;
 }
 return count;
}
