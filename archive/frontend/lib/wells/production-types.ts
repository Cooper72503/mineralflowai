/**
 * Unified production result type — works for any state agency scraper.
 *
 * Supported sources:
 *   "trrc_actual"  — Texas Railroad Commission PDQ
 *   "wvdep_actual" — WV DEP Office of Oil and Gas
 *   "occ_actual"   — Oklahoma Corporation Commission COGIS
 *   "ndic_actual"  — North Dakota Industrial Commission
 *   "ocd_actual"   — New Mexico Oil Conservation Division (EMNRD)
 *   "cogcc_actual" — Colorado Oil and Gas Conservation Commission (ECMC)
 */

export type StateProductionRow = {
  year:    number;
  month:   number;  // 1–12
  oil_bbl: number;
  gas_mcf: number | null;
};

export type StateProductionSource =
  | "trrc_actual"
  | "wvdep_actual"
  | "occ_actual"
  | "ndic_actual"
  | "ocd_actual"
  | "cogcc_actual";

export type StateProductionResult = {
  api_number:   string;
  rows:         StateProductionRow[];
  months_count: number;
  source:       StateProductionSource;
  /** TRRC-specific */
  district_code?: string;
  lease_number?:  string;
};

/** Human-readable label for each data source */
export const SOURCE_LABELS: Record<StateProductionSource, string> = {
  trrc_actual:  "TRRC (Texas)",
  wvdep_actual: "WV DEP",
  occ_actual:   "OCC (Oklahoma)",
  ndic_actual:  "NDIC (North Dakota)",
  ocd_actual:   "OCD / EMNRD (New Mexico)",
  cogcc_actual: "COGCC / ECMC (Colorado)",
};

/** Which 2-digit API state code maps to which state abbreviation */
export const API_PREFIX_TO_STATE: Record<string, string> = {
  "05": "CO",   // Colorado
  "17": "LA",   // Louisiana  (no free public production endpoint yet)
  "30": "NM",   // New Mexico
  "33": "ND",   // North Dakota
  "34": "OH",   // Ohio       (no free public production endpoint yet)
  "35": "OK",   // Oklahoma
  "42": "TX",   // Texas
  "47": "WV",   // West Virginia
  "49": "WY",   // Wyoming    (no free public production endpoint yet)
};
