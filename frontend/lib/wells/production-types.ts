/**
 * Unified production result type — works for any state agency scraper.
 *
 * Currently supported sources:
 *   "trrc_actual"  — Texas Railroad Commission PDQ (monthly oil+gas CSV)
 *   "wvdep_actual" — WV DEP Office of Oil and Gas (HTML table)
 */

export type StateProductionRow = {
  year:    number;
  month:   number;  // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
};

export type StateProductionResult = {
  api_number:   string;
  rows:         StateProductionRow[];
  months_count: number;
  source:       "trrc_actual" | "wvdep_actual";
  /** TRRC-specific */
  district_code?: string;
  lease_number?:  string;
};

/** Human-readable label for each data source */
export const SOURCE_LABELS: Record<StateProductionResult["source"], string> = {
  trrc_actual:  "TRRC Actual",
  wvdep_actual: "WV DEP Actual",
};

/** Which state prefix maps to which source (for routing in the API) */
export const API_PREFIX_TO_STATE: Record<string, string> = {
  "42": "TX",   // Texas
  "47": "WV",   // West Virginia
  "33": "ND",   // North Dakota  (no free public production endpoint yet)
  "35": "OK",   // Oklahoma      (no free public production endpoint yet)
  "34": "OH",   // Ohio          (no free public production endpoint yet)
};
