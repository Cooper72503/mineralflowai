import {it,expect} from "vitest";
import {storedTitleFraction,titleInputFingerprint} from "../analysis-input";
it("preserves large integer strings without Number rounding",()=>{expect(storedTitleFraction("9007199254740993","18014398509481986")!.toString()).toBe("1/2");});
it("rejects unsafe numeric, partial and zero-denominator fractions",()=>{for(const [n,d] of [[9007199254740993,2],[null,2],[1,0],[1.5,2]])expect(()=>storedTitleFraction(n,d)).toThrow();expect(storedTitleFraction(null,null)).toBeNull();});
it("invalidates cached title analysis for edited claims, dates and document evidence",()=>{
 const initial={claim:{id:"same",n:"1",d:"4"},instrument:{id:"same",date:"2026-01-01"},document:{hash:"a"}};
 const hash=titleInputFingerprint(initial);
 for(const mutate of [(x:typeof initial)=>{x.claim.n="2";},(x:typeof initial)=>{x.instrument.date="2026-02-01";},(x:typeof initial)=>{x.document.hash="b";}]){const next=structuredClone(initial);mutate(next);expect(titleInputFingerprint(next)).not.toBe(hash);}
});
it("makes object key ordering irrelevant without reordering semantic arrays",()=>{expect(titleInputFingerprint({a:1,b:2})).toBe(titleInputFingerprint({b:2,a:1}));expect(titleInputFingerprint([1,2])).not.toBe(titleInputFingerprint([2,1]));});
