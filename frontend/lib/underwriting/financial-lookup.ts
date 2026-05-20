/**
 * Financial Data Lookup
 *
 * Two sources:
 *   1. EIA API v2 — current WTI oil price + Henry Hub gas price
 *   2. SEC EDGAR — operator LOE/BOE from public company 10-K filings
 *
 * Both return null gracefully on failure — callers degrade to benchmarks.
 */

// ─── EIA Oil & Gas Price Lookup ───────────────────────────────────────────────

export type EiaPriceResult = {
  wti_spot_usd: number;       // WTI spot $/bbl
  henry_hub_usd: number;      // Henry Hub $/MMBtu
  period: string;             // "YYYY-MM-DD" of the data point
  source: "eia_api" | "hardcoded_fallback";
};

// Hardcoded recent fallback prices (updated periodically)
// These are used when EIA_API_KEY is not set or EIA is unreachable
const FALLBACK_PRICES: EiaPriceResult = {
  wti_spot_usd: 72.00,
  henry_hub_usd: 2.65,
  period: "2026-05",
  source: "hardcoded_fallback",
};

export async function fetchCurrentOilPrice(): Promise<EiaPriceResult> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) return FALLBACK_PRICES;

  try {
    // EIA v2 API — WTI Cushing spot price (weekly)
    const [wtiRes, hhRes] = await Promise.all([
      fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${apiKey}` +
        `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1`,
        { signal: AbortSignal.timeout(6_000) }
      ),
      fetch(
        `https://api.eia.gov/v2/natural-gas/pri/fut/data/?api_key=${apiKey}` +
        `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1`,
        { signal: AbortSignal.timeout(6_000) }
      ),
    ]);

    const wtiJson = await wtiRes.json();
    const hhJson  = await hhRes.json();

    const wti = wtiJson?.response?.data?.[0]?.value;
    const hh  = hhJson?.response?.data?.[0]?.value;
    const period = wtiJson?.response?.data?.[0]?.period ?? FALLBACK_PRICES.period;

    if (wti && hh) {
      return {
        wti_spot_usd:   Math.round(Number(wti)  * 100) / 100,
        henry_hub_usd:  Math.round(Number(hh)   * 100) / 100,
        period,
        source: "eia_api",
      };
    }
  } catch {
    // fall through to hardcoded
  }

  return FALLBACK_PRICES;
}

// ─── SEC EDGAR Operator Financial Lookup ─────────────────────────────────────

export type EdgarFinancials = {
  company_name: string;
  cik: string;
  ticker?: string;
  // Most recent annual filing
  fiscal_year: string;
  // Per-BOE figures (all in $/BOE)
  loe_per_boe: number | null;
  production_cost_per_boe: number | null;
  // Total production figures from 10-K
  total_oil_bbl_annual: number | null;
  total_gas_mcf_annual: number | null;
  // Revenue
  total_revenue_usd: number | null;
  // Filing reference
  filing_url: string | null;
  source: "edgar";
};

const EDGAR_BASE = "https://efts.sec.gov";
const EDGAR_DATA = "https://data.sec.gov";
const EDGAR_HEADERS = {
  "User-Agent": "MineralFlowAI contact@mineralflowai.com",
  "Accept":     "application/json",
};

async function searchEdgarCompany(operatorName: string): Promise<{ cik: string; name: string; ticker?: string } | null> {
  try {
    // Try full-text search for company in EDGAR
    const q = encodeURIComponent(`"${operatorName}"`);
    const res = await fetch(
      `${EDGAR_BASE}/LATEST/search-index?q=${q}&forms=10-K&dateRange=custom&startdt=2022-01-01&_source=file_date,entity_name,file_num,period_of_report,biz_location,inc_states&hits.hits.total.relation=eq&hits.hits._source.period_of_report=desc`,
      { headers: EDGAR_HEADERS, signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data?.hits?.hits?.[0]?._source;
    if (!hit) return null;

    // Also try the company search endpoint for CIK
    const companyRes = await fetch(
      `${EDGAR_DATA}/submissions/CIK${String(hit.entity_id ?? "").padStart(10, "0")}.json`,
      { headers: EDGAR_HEADERS, signal: AbortSignal.timeout(5_000) }
    );
    if (!companyRes.ok) return null;
    const company = await companyRes.json();

    return {
      cik:    String(company.cik ?? "").padStart(10, "0"),
      name:   company.name ?? operatorName,
      ticker: company.tickers?.[0],
    };
  } catch {
    return null;
  }
}

// Known CIKs for major Texas operators (avoids search latency)
const KNOWN_CIKS: Record<string, string> = {
  "pioneer natural resources":       "0001038357",
  "pioneer natural resources co":    "0001038357",
  "diamondback energy":              "0001539838",
  "permian basin royalty trust":     "0000076985",
  "cross timbers royalty trust":     "0000811532",
  "burlington resources":            "0000833081",
  "conocophillips":                  "0001163165",
  "coterra energy":                  "0000858470",
  "callon petroleum":                "0000928054",
  "laramie resources":               "0000060714",
  "devon energy":                    "0001090012",
  "apache corporation":              "0000006769",
  "apa corporation":                 "0001764468",
  "ovintiv":                         "0001792789",
  "sm energy":                       "0893538",
  "ring energy":                     "0001638287",
  "abraxas petroleum":               "0000803649",
  "par pacific":                     "0001580068",
};

function findKnownCik(operatorName: string): string | null {
  const lower = operatorName.toLowerCase().trim();
  for (const [key, cik] of Object.entries(KNOWN_CIKS)) {
    if (lower.includes(key) || key.includes(lower.split(" ")[0])) return cik;
  }
  return null;
}

async function fetchEdgarXbrlFacts(cik: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      `${EDGAR_DATA}/api/xbrl/companyfacts/CIK${cik}.json`,
      { headers: EDGAR_HEADERS, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Extract the most recent annual value for a GAAP concept
function latestAnnualValue(
  facts: Record<string, unknown>,
  concept: string,
  unit = "USD",
): { value: number; year: string } | null {
  try {
    const taxonomy = (facts as Record<string, Record<string, unknown>>)["us-gaap"] ?? {};
    const entry = (taxonomy as Record<string, { units?: Record<string, { end: string; val: number; form: string; fp: string }[]> }>)[concept];
    if (!entry?.units?.[unit]) return null;

    const annuals = entry.units[unit]
      .filter(e => e.form === "10-K" && e.fp === "FY")
      .sort((a, b) => b.end.localeCompare(a.end));

    if (annuals.length === 0) return null;
    return { value: annuals[0].val, year: annuals[0].end.slice(0, 4) };
  } catch {
    return null;
  }
}

// O&G specific XBRL tags for production costs / LOE
const LOE_CONCEPTS = [
  "OilAndGasPropertyOperatingExpenses",
  "OilAndGasOperatingExpense",
  "LiftingCosts",
  "LeaseOperatingExpense",
  "ExplorationAndProductionExpense",
  "OperatingCostsAndExpenses",
  "CostOfGoodsAndServicesSold",    // fallback
];

const REVENUE_CONCEPTS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
];

export async function lookupOperatorFinancials(
  operatorName: string | null,
): Promise<EdgarFinancials | null> {
  if (!operatorName || operatorName.trim().length < 4) return null;

  // Find CIK
  let cik = findKnownCik(operatorName);
  if (!cik) {
    const found = await searchEdgarCompany(operatorName);
    if (!found) return null;
    cik = found.cik;
  }

  const facts = await fetchEdgarXbrlFacts(cik);
  if (!facts) return null;

  // Try to find LOE
  let loeValue: number | null = null;
  let loeYear = "";
  for (const concept of LOE_CONCEPTS) {
    const v = latestAnnualValue(facts, concept);
    if (v) { loeValue = v.value; loeYear = v.year; break; }
  }

  // Revenue
  let revenueValue: number | null = null;
  for (const concept of REVENUE_CONCEPTS) {
    const v = latestAnnualValue(facts, concept);
    if (v) { revenueValue = v.value; break; }
  }

  // Production volume from XBRL (barrels of oil equivalent)
  const oilProd  = latestAnnualValue(facts, "OilProductionVolume",  "Boe");
  const gasProd  = latestAnnualValue(facts, "GasProductionVolume",  "Mcfe");
  const boeProd  = latestAnnualValue(facts, "ProductionVolumeOilEquivalents", "BOE")
                ?? latestAnnualValue(facts, "ProductionVolumeOilEquivalents", "Boe");

  const totalBoe = boeProd?.value
    ?? (oilProd?.value != null && gasProd?.value != null
        ? oilProd.value + gasProd.value / 6
        : null);

  // Compute LOE/BOE
  const loePerBoe = loeValue && totalBoe && totalBoe > 0
    ? loeValue / totalBoe
    : null;

  if (!loeValue && !revenueValue) return null;

  // Get company name from facts
  const entityName = (facts as { entityName?: string }).entityName ?? operatorName;

  return {
    company_name:          entityName,
    cik,
    fiscal_year:           loeYear || new Date().getFullYear().toString(),
    loe_per_boe:           loePerBoe ? Math.round(loePerBoe * 100) / 100 : null,
    production_cost_per_boe: loePerBoe ? Math.round(loePerBoe * 100) / 100 : null,
    total_oil_bbl_annual:  oilProd?.value ?? null,
    total_gas_mcf_annual:  gasProd?.value ?? null,
    total_revenue_usd:     revenueValue,
    filing_url:            `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=5`,
    source:                "edgar",
  };
}

// ─── Combined financial context ───────────────────────────────────────────────

export type FinancialContext = {
  oil_price:       EiaPriceResult;
  edgar:           EdgarFinancials | null;
};

export async function fetchFinancialContext(
  operatorName: string | null,
): Promise<FinancialContext> {
  const [oil_price, edgar] = await Promise.all([
    fetchCurrentOilPrice(),
    lookupOperatorFinancials(operatorName),
  ]);
  return { oil_price, edgar };
}
