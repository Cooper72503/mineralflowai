import { describe, it, expect } from "vitest";
import { reconcileAssetInventory, type LeaseInventoryEvidence } from "../reconcile-asset-inventory";
const offered = [{originalApi:"42-151-500001",wellNumber:"9",leaseNumber:"00123",district:"07B",page:2}];
const source: LeaseInventoryEvidence = {leaseNumber:"123",district:"7B",sourceUrl:"https://example.test/regulator",retrievedAt:"2026-09-15T00:00:00Z",sha256:"a".repeat(64),complete:true,rows:[{api_no:"15100001",well_no:"9",lease_no:"123",district:"7B",on_schedule:"Y"}]};
describe("evidence-backed offered inventory reconciliation",()=>{
 it("preserves malformed input and proposes only the regulator-backed base API",()=>{const r=reconcileAssetInventory(offered,source)[0];expect(r.status).toBe("correction_proposed");expect(r.input.originalApi).toBe(offered[0].originalApi);expect(r.candidates).toEqual(["4215100001"]);expect(r.inputValidationError).toContain("11 digits")});
 it("does not guess from malformed digits when the well number is absent",()=>expect(reconcileAssetInventory([{...offered[0],wellNumber:"8"}],source)[0].status).toBe("unmatched"));
 it("rejects incomplete inventories",()=>expect(reconcileAssetInventory(offered,{...source,complete:false})[0].status).toBe("unavailable"));
 it("does not use historical or wrong-lease associations",()=>{expect(reconcileAssetInventory(offered,{...source,rows:source.rows.map(r=>({...r,on_schedule:"N"}))})[0].status).toBe("unmatched");expect(reconcileAssetInventory(offered,{...source,leaseNumber:"999"})[0].status).toBe("unavailable")});
 it("withholds ambiguous same-number matches",()=>expect(reconcileAssetInventory(offered,{...source,rows:[...source.rows,{...source.rows[0],api_no:"15100002"}]})[0].status).toBe("ambiguous"));
 it("matches a valid API without claiming ownership",()=>expect(reconcileAssetInventory([{...offered[0],originalApi:"4215100001"}],source)[0].status).toBe("matched"));
});
