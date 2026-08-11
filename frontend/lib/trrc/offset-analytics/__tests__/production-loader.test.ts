import { describe, it, expect, afterEach } from "vitest";
import { resolveWellboreToLease, fetchAnalogProduction, detectProductionAnomalies, type AnalogProductionRow } from "../production-loader";

function mockFetchSequence(responses: Array<{ status?: number; body: string }>) {
  let call = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: { get: () => null }, text: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const wellboreHtmlWithLease = `<html><body>
<a href="leaseDetailAction.do?searchType=apiNo&distCode=08&leaseNo=52210&apiNo=16502733">detail</a>
<table>
  <tr><th>API No.</th><th>District</th><th>Lease No.</th><th>Lease Name</th><th>Well No.</th><th>Field Name</th></tr>
  <tr><td>16502733</td><td>08</td><td>52210</td><td>BRADFORD TRUST A UNIT 2</td><td>1</td><td>SPRABERRY (TREND AREA)</td></tr>
</table>
</body></html>`;
const wellboreHtmlNoResults = `<html><body>no results found</body></html>`;

const oilProductionHtml = `<html><body>
<table class="DataGrid">
  <tr><td colspan="9">1 results Page: 1 of 1</td></tr>
  <tr><th rowspan="2">Date</th><th colspan="2">OIL (BBL)</th><th colspan="2">Casinghead (MCF)</th></tr>
  <tr><th>Production</th><th>Disposition</th><th>Production</th><th>Disposition</th></tr>
  <tr><td>Apr 2024</td><td>1,200</td><td>1,150</td><td>300</td><td>0</td></tr>
</table>
</body></html>`;

describe("resolveWellboreToLease", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("extracts lease number and district from the lease-detail link, not fragile cell text", async () => {
    mockFetchSequence([{ body: "<html></html>" }, { body: wellboreHtmlWithLease }]);
    const result = await resolveWellboreToLease("42-165-02733");
    expect(result).toEqual({ leaseNumber: "52210", district: "08", fieldName: "SPRABERRY (TREND AREA)", operatorName: null });
  });

  it("also captures field name from the real table column — needed for analog formation matching (Phase 7)", async () => {
    mockFetchSequence([{ body: "<html></html>" }, { body: wellboreHtmlWithLease }]);
    const result = await resolveWellboreToLease("42-165-02733");
    expect(result!.fieldName).toBe("SPRABERRY (TREND AREA)");
  });

  it("returns null on a genuine 'no results found', not a fabricated lease", async () => {
    mockFetchSequence([{ body: "<html></html>" }, { body: wellboreHtmlNoResults }]);
    const result = await resolveWellboreToLease("42-165-99999");
    expect(result).toBeNull();
  });

  it("returns null for a malformed API number rather than guessing a lease", async () => {
    const result = await resolveWellboreToLease("not-an-api");
    expect(result).toBeNull();
  });

  // Real, severe bug caught live 2026-08-10: every real caller of this
  // function (offset-analytics/service.ts's analog selection AND
  // geology/production.ts's offset-well enrichment) passes the 8-digit
  // TRRC "county+well" form straight off well-search.ts's ArcGIS results
  // (confirmed live: {"API":"16502733", ...}) — never the 10+-digit
  // state-prefixed form the existing tests above use. The original
  // splitApi() required >=10 digits and returned null on the very first
  // line for anything shorter, so every real offset-well call silently
  // short-circuited before a single fetch was attempted — indistinguishable
  // from a clean "no data" result, and invisible to every test above since
  // none of them exercised the 8-digit shape actually used in production.
  it("resolves a lease from the real 8-digit county+well API form real offset wells actually use — not just the 10-digit form", async () => {
    mockFetchSequence([{ body: "<html></html>" }, { body: wellboreHtmlWithLease }]);
    const result = await resolveWellboreToLease("16502733");
    expect(result).toEqual({ leaseNumber: "52210", district: "08", fieldName: "SPRABERRY (TREND AREA)", operatorName: null });
  });
});

describe("fetchAnalogProduction", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("labels every result as LEASE scope with no allocation method — never claims well-level production", async () => {
    mockFetchSequence([{ body: "<html></html>" }, { body: oilProductionHtml }]);
    const result = await fetchAnalogProduction("52210", "08");
    expect(result.scope).toBe("LEASE");
    expect(result.allocationMethod).toBe("NONE_LEASE_LEVEL_ONLY");
  });

  it("parses real oil-type production correctly", async () => {
    mockFetchSequence([{ body: "<html></html>" }, { body: oilProductionHtml }]);
    const result = await fetchAnalogProduction("52210", "08");
    expect(result.found).toBe(true);
    expect(result.rows[0]).toEqual({ productionMonth: "2024-04", oilBbl: 1200, gasMcf: null, casingheadGasMcf: 300, condensateBbl: null });
  });

  it("reports found:false with an info warning, not an error, on a genuine empty result for both lease types", async () => {
    mockFetchSequence([{ body: "<html></html>" }, { body: "<html><body>no results found</body></html>" }]);
    const result = await fetchAnalogProduction("00001", "08");
    expect(result.found).toBe(false);
    expect(result.warnings.some(w => w.code === "NO_PRODUCTION_FOUND")).toBe(true);
  });
});

describe("detectProductionAnomalies", () => {
  it("flags negative production volumes as critical", () => {
    const rows: AnalogProductionRow[] = [{ productionMonth: "2024-01", oilBbl: -50, gasMcf: null, casingheadGasMcf: null, condensateBbl: null }];
    const warnings = detectProductionAnomalies(rows);
    expect(warnings.some(w => w.code === "NEGATIVE_PRODUCTION_VOLUME" && w.severity === "critical")).toBe(true);
  });

  it("flags duplicated months", () => {
    const rows: AnalogProductionRow[] = [
      { productionMonth: "2024-01", oilBbl: 100, gasMcf: null, casingheadGasMcf: null, condensateBbl: null },
      { productionMonth: "2024-01", oilBbl: 100, gasMcf: null, casingheadGasMcf: null, condensateBbl: null },
    ];
    const warnings = detectProductionAnomalies(rows);
    expect(warnings.some(w => w.code === "DUPLICATE_PRODUCTION_MONTHS")).toBe(true);
  });

  it("flags a real gap in the reported date range", () => {
    const rows: AnalogProductionRow[] = [
      { productionMonth: "2024-01", oilBbl: 100, gasMcf: null, casingheadGasMcf: null, condensateBbl: null },
      { productionMonth: "2024-04", oilBbl: 100, gasMcf: null, casingheadGasMcf: null, condensateBbl: null },
    ];
    const warnings = detectProductionAnomalies(rows);
    expect(warnings.some(w => w.code === "MISSING_MONTHS_IN_HISTORY")).toBe(true);
  });

  it("returns no warnings for a clean, complete, non-negative history", () => {
    const rows: AnalogProductionRow[] = [
      { productionMonth: "2024-01", oilBbl: 100, gasMcf: null, casingheadGasMcf: null, condensateBbl: null },
      { productionMonth: "2024-02", oilBbl: 90, gasMcf: null, casingheadGasMcf: null, condensateBbl: null },
    ];
    expect(detectProductionAnomalies(rows)).toEqual([]);
  });
});
