import { describe, it, expect } from "vitest";
import { parseRunStatements } from "../run-statements";
import { overlaySellerSales, filledSentence, differsSentence } from "../reconcile";
import { pageTextFromItems } from "../pdf-text";
import type { TrrcDDProductionRow } from "../../types";

// Lines as the browser reads them from Energy Transfer Crude Marketing's
// statement for ODC SAN ANDRES UNIT, sales month 04/2026 (2026-10-15 upload).
const odc = (level: number, page: number) => `REVISED(Y/N): N ENERGY TRANSFER CRUDE MARKETING LLC PAGE: ${page}
LEVEL: ${level} RUN STATEMENT TIME: 09:06:25
DATE: 06/30/2026 FOR ASSISTANCE CONTACT:
SALES DATE: 04/2026 PHONE: 800-677-0202
PROPERTY NO: 152671${level === 2 ? "-1" : ""} COUNTY: GAINES OPERATORHOTLINE@ENERGYTRANSFER.COM
PROPERTY NAME: ODC SAN ANDRES UNIT (60509) STATE: TEXAS
OPERATOR NO: 1000421830 STATE LEASE: 060509
TICKET TICKET TYPE ADJ TANK/METER NET CORR AVG GROSS STATE NET
04/08/2026 176246441 N RT 73631 0.00 0.00 0.00 0.00 0.00 -150.00
04/14/2026 176350001 N 73631 160.25 31.30 96.87 15,523.42 715.07 14,808.35
04/27/2026 176520002 N 73631 153.80 31.30 96.87 14,899.86 686.36 14,213.50
TOTALS FOR PROPERTY 314.05 30,423.28 1,401.43 28,571.85`;
const taylor = `REVISED(Y/N): N ENERGY TRANSFER CRUDE MARKETING LLC PAGE: 1
SALES DATE: 05/2026 PHONE: 800-677-0202
PROPERTY NO: 152591-1 COUNTY: GAINES OPERATORHOTLINE@ENERGYTRANSFER.COM
PROPERTY NAME: TAYLOR W. J. A (10289) STATE: TEXAS
OPERATOR NO: 1000421830 STATE LEASE: 010289
05/05/2026 176651951 N 73636 165.06 34.90 104.03 17,170.75 790.89 16,379.86
05/12/2026 176752941 N 73634 179.30 34.80 104.03 18,652.10 859.12 17,792.98
TOTALS FOR PROPERTY 344.36 35,822.85 1,650.01 34,172.84`;

describe("run statement parsing", () => {
  it("reads each property's month, state lease, county and totals, and counts interest-level repeats once", () => {
    const r = parseRunStatements([odc(1, 1), odc(2, 3), taylor, "@ o| START"]);
    expect(r.purchasers).toEqual(["ENERGY TRANSFER CRUDE MARKETING LLC"]);
    expect(r.pagesWithoutText).toBe(1);
    expect(r.warnings).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ leaseNumber: "10289", stateLease: "010289", county: "GAINES", salesMonth: "2026-05", netBbl: 344.36, ticketBbl: 344.36 });
    expect(r.rows[1]).toMatchObject({ propertyName: "ODC SAN ANDRES UNIT (60509)", leaseNumber: "60509", county: "GAINES", salesMonth: "2026-04", netBbl: 314.05,
      grossUsd: 30423.28, taxesUsd: 1401.43, netUsd: 28571.85, avgPriceUsdBbl: 96.87, ticketBbl: 314.05, pages: [1, 2], propertyNos: ["152671", "152671-1"] });
  });

  it("warns when the tickets do not add up to the printed total, and keeps the total", () => {
    const r = parseRunStatements([odc(1, 1).replace("153.80", "150.80")]);
    expect(r.rows[0].netBbl).toBe(314.05);
    expect(r.warnings[0]).toMatch(/tickets sum to 311.05 bbl but the property total is 314.05 bbl/);
  });

  it("rebuilds lines from pdfjs items by baseline, left to right", () => {
    expect(pageTextFromItems([{ str: "TOTALS FOR PROPERTY", transform: [1, 0, 0, 1, 10, 100] }, { str: "314.05", transform: [1, 0, 0, 1, 300, 100.4] }, { str: "SALES DATE: 04/2026", transform: [1, 0, 0, 1, 10, 700] }]))
      .toBe("SALES DATE: 04/2026\nTOTALS FOR PROPERTY 314.05");
  });
});

const prow = (month: string, oil: number | null): TrrcDDProductionRow => ({ entity_type: "lease", api_number: null, district: "8A", lease_number: "60509", gas_id: null, operator_number: null,
  production_month: month, oil_bbl: oil, casinghead_gas_mcf: oil === null ? null : 0, gas_mcf: null, condensate_bbl: null, water_bbl: null });

describe("run statements against TRRC", () => {
  const stmt = (salesMonth: string, netBbl: number) => ({ sourceId: "9", row: { purchaser: "ENERGY TRANSFER CRUDE MARKETING LLC", propertyNos: [], propertyName: "ODC", stateLease: "060509", leaseNumber: "60509", county: "GAINES",
    salesMonth, netBbl, grossUsd: netBbl * 90, taxesUsd: 0, netUsd: 0, avgPriceUsdBbl: 90, pages: [1], ticketBbl: netBbl } });

  it("fills months with no TRRC report, keeps reported months, and flags a disagreement", () => {
    const prod = [prow("2026-01", 0), prow("2026-02", null), prow("2026-03", 410), prow("2026-04", null)];
    const o = overlaySellerSales(prod, [stmt("2026-03", 300), stmt("2026-04", 314.05), stmt("2026-05", 334.93)]);
    expect(o.production.map(r => [r.production_month, r.oil_bbl])).toEqual([["2026-01", 0], ["2026-02", null], ["2026-03", 410], ["2026-04", 314.05], ["2026-05", 334.93]]);
    expect(o.months.map(m => m.basis)).toEqual(["differs", "filled", "filled"]);
    expect(filledSentence(o.months)).toBe("ENERGY TRANSFER CRUDE MARKETING LLC run statements show 648.98 bbl of oil sold Apr 2026–May 2026 (2 months, averaging 324.49 bbl), months for which the operator filed no production report with TRRC. The statements are used for those months; the missing reports are a compliance exposure.");
    expect(differsSentence(o.months)).toMatch(/Mar 2026 statement 300 bbl, TRRC 410 bbl/);
  });

  it("treats sales within the tolerance of TRRC's report as agreeing", () => {
    expect(overlaySellerSales([prow("2026-03", 300)], [stmt("2026-03", 290)]).months[0].basis).toBe("agrees");
  });
});
