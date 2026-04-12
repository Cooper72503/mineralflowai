export type WellSummary = {
  api: string;
  well_name: string;
  operator: string | null;
  county: string | null;
  state: string;
  status: string | null;
  formation: string | null;
  spud_date: string | null;
  /** Latest available monthly oil production (BBL). */
  latest_monthly_oil_bbl: number | null;
  latest_monthly_gas_mcf: number | null;
  latest_monthly_water_bbl: number | null;
  latest_production_month: string | null; // "YYYY-MM"
  cum_oil_bbl: number | null;
  lat: number | null;
  lng: number | null;
};

export type WellLookupResult = {
  /** Data source identifier. */
  source: "ndic" | "cogcc" | "trrc" | "unavailable";
  /** Whether the transfer limit was exceeded (more wells exist than returned). */
  exceeded_transfer_limit?: boolean;
  wells: WellSummary[];
  /** Human-readable description of the query (e.g. "McKenzie County, ND"). */
  query_description: string;
  /** Optional explanatory note (shown in UI when unavailable). */
  note?: string;
};
