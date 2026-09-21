import { it, expect } from "vitest";
import { productionSeries, reportedProductionSeries } from "../production-series";
import type { TrrcDDProductionRow } from "../types";
const r = (month: string, oil: number | null, gas: number | null) => ({production_month:month,oil_bbl:oil,gas_mcf:null,casinghead_gas_mcf:gas}) as TrrcDDProductionRow;
it("includes reported casinghead gas in gas economics",()=>expect(productionSeries([r("2026-01",100,20)]).gas).toEqual([20]));
it("rejects calendar gaps and duplicates for equally spaced decline fits",()=>{
 expect(productionSeries([r("2026-01",100,20),r("2026-03",90,15)]).oil).toEqual([]);
 expect(productionSeries([r("2026-01",100,20),r("2026-01",90,15)]).oil).toEqual([]);
});
it("does not fill missing volumes with zeros",()=>expect(productionSeries([r("2026-01",null,20)]).oil).toEqual([]));

import { currentProduction } from "../production-series";
import type { LiteSourceAttempt } from "../coverage";
it("does not reuse persisted production after failed retrieval or scope mismatch", () => {
 const row={...r("2026-01",100,20),entity_type:"lease",lease_number:"12345",district:"08"} as TrrcDDProductionRow;
 const attempt={source_name:"fetch_production",status:"success",attempted_at:"2026-09-09",result_data_json:{found:true,lease_number:"12345",district:"08",rows:[row]}} as unknown as LiteSourceAttempt;
 expect(currentProduction([row],[attempt])).toHaveLength(1);
 expect(currentProduction([row],[{...attempt,status:"failed_transient"}])).toEqual([]);
 expect(currentProduction([{...row,lease_number:"OTHER"}],[attempt])).toEqual([]);
 expect(currentProduction([{...row,oil_bbl:999}],[attempt])).toEqual([]);
});

it("reportedProductionSeries trims TRRC's trailing unreported months and reports the lag, without treating them as zero",()=>{
 const rows=[r("2026-03",120,10),r("2026-04",110,9),r("2026-05",100,8),r("2026-06",95,8),r("2026-07",null,null),r("2026-08",null,null),r("2026-09",null,null)];
 const s=reportedProductionSeries(rows);
 expect(s.oil).toEqual([120,110,100,95]);
 expect(s.oilLastReportedMonth).toBe("2026-06");
 expect(s.trailingUnreportedOilMonths).toBe(3);
 expect(productionSeries(rows).oil).toEqual([]); // the strict function is unchanged
});
it("reportedProductionSeries still refuses an interior gap",()=>{
 const rows=[r("2026-03",120,10),r("2026-04",null,null),r("2026-05",100,8),r("2026-06",95,8),r("2026-07",null,null)];
 expect(reportedProductionSeries(rows).oil).toEqual([]);
 expect(reportedProductionSeries(rows).trailingUnreportedOilMonths).toBe(1);
});
