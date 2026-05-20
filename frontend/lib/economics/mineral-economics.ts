/**
 * Mineral Rights Operating Economics
 *
 * Computes net revenue to a mineral rights owner: gross royalty income
 * minus severance taxes and ad valorem taxes. Mineral owners do NOT pay LOE
 * (that's the operator's burden), but DO pay production taxes.
 *
 * Also provides working interest (WI) economics for comparison when the user
 * holds a working interest.
 *
 * Sources:
 * - State severance rates: state statutes (TX, ND, OK, WV, OH current rates)
 * - LOE benchmarks: EIA Operating Cost Surveys + DrillingInfo basin averages
 * - Ad valorem: IRS Publication 936 + state property tax guidance
 * - Gathering: typical midstream rates by basin
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type StateEconomics = {
  state: string;
  /** Oil severance tax rate (fraction of gross revenue). */
  oil_severance_rate: number;
  /** Gas severance tax rate (fraction of gross revenue). */
  gas_severance_rate: number;
  /** Ad valorem (property tax on production) rate — typical, fraction. */
  ad_valorem_rate: number;
  /** Operator lifting cost (LOE) $/bbl — applies to working interest only. */
  loe_low_per_bbl: number;
  loe_high_per_bbl: number;
  /** Gathering / transportation $/bbl typical. */
  gathering_per_bbl: number;
  /** Oil price used for analysis (current benchmark). */
  oil_price_per_bbl: number;
};

export type MineralEconomicsResult = {
  /** Annual gross oil revenue at current production levels. */
  annual_gross_oil_revenue: number | null;
  /** Annual royalty income before taxes. */
  annual_royalty_gross: number | null;
  /** Annual severance taxes owed by mineral owner. */
  annual_severance_tax: number | null;
  /** Annual ad valorem taxes. */
  annual_ad_valorem_tax: number | null;
  /** Annual NET royalty income after severance + ad valorem. */
  annual_net_royalty: number | null;
  /** Monthly net royalty income. */
  monthly_net_royalty: number | null;
  /** Net royalty as % of gross (shows effective take). */
  effective_net_pct: number | null;
  /** State economics parameters used. */
  state_economics: StateEconomics;
  /** How royalty income was derived. */
  basis: "tract_production" | "bopd_anchored" | "revenue_document" | "production_snapshot" | "insufficient";
  /** Revenue-to-value ratio (cap rate implied by point estimate). */
  implied_cap_rate: number | null;
  /** LOE (operator cost) — informational only for mineral owners, hard burden for WI. */
  loe_estimate_annual: number | null;
  /** Annual net operating income if this were a working interest position. */
  wi_noi_estimate: number | null;
  summary: string;
};

// ── State Economics Tables ─────────────────────────────────────────────────────

const STATE_ECONOMICS: Record<string, StateEconomics> = {
  TX: {
    state: "Texas",
    oil_severance_rate:  0.046,   // 4.6% of gross
    gas_severance_rate:  0.075,   // 7.5% of gross
    ad_valorem_rate:     0.015,   // ~1.5% typical
    loe_low_per_bbl:     8,
    loe_high_per_bbl:    18,
    gathering_per_bbl:   2.5,
    oil_price_per_bbl:   70,
  },
  ND: {
    state: "North Dakota",
    oil_severance_rate:  0.065,   // 5% extraction + 11.5% oil = effective ~6.5%
    gas_severance_rate:  0.050,
    ad_valorem_rate:     0.010,
    loe_low_per_bbl:     12,
    loe_high_per_bbl:    22,
    gathering_per_bbl:   3.5,
    oil_price_per_bbl:   70,
  },
  OK: {
    state: "Oklahoma",
    oil_severance_rate:  0.070,
    gas_severance_rate:  0.070,
    ad_valorem_rate:     0.012,
    loe_low_per_bbl:     8,
    loe_high_per_bbl:    15,
    gathering_per_bbl:   2.0,
    oil_price_per_bbl:   70,
  },
  WV: {
    state: "West Virginia",
    oil_severance_rate:  0.050,
    gas_severance_rate:  0.050,
    ad_valorem_rate:     0.010,
    loe_low_per_bbl:     5,
    loe_high_per_bbl:    12,
    gathering_per_bbl:   1.5,
    oil_price_per_bbl:   70,
  },
  OH: {
    state: "Ohio",
    oil_severance_rate:  0.025,
    gas_severance_rate:  0.025,
    ad_valorem_rate:     0.015,
    loe_low_per_bbl:     6,
    loe_high_per_bbl:    14,
    gathering_per_bbl:   1.5,
    oil_price_per_bbl:   70,
  },
  MT: {
    state: "Montana",
    oil_severance_rate:  0.092,   // 9.2% oil gross
    gas_severance_rate:  0.025,
    ad_valorem_rate:     0.012,
    loe_low_per_bbl:     10,
    loe_high_per_bbl:    20,
    gathering_per_bbl:   3.0,
    oil_price_per_bbl:   70,
  },
  WY: {
    state: "Wyoming",
    oil_severance_rate:  0.060,
    gas_severance_rate:  0.060,
    ad_valorem_rate:     0.013,
    loe_low_per_bbl:     10,
    loe_high_per_bbl:    18,
    gathering_per_bbl:   2.5,
    oil_price_per_bbl:   70,
  },
  CO: {
    state: "Colorado",
    oil_severance_rate:  0.050,
    gas_severance_rate:  0.050,
    ad_valorem_rate:     0.020,
    loe_low_per_bbl:     9,
    loe_high_per_bbl:    16,
    gathering_per_bbl:   2.0,
    oil_price_per_bbl:   70,
  },
  // Default fallback
  DEFAULT: {
    state: "Unknown",
    oil_severance_rate:  0.050,
    gas_severance_rate:  0.050,
    ad_valorem_rate:     0.015,
    loe_low_per_bbl:     10,
    loe_high_per_bbl:    18,
    gathering_per_bbl:   2.5,
    oil_price_per_bbl:   70,
  },
};

// ── Main function ──────────────────────────────────────────────────────────────

export function computeMineralEconomics(args: {
  state: string | null;
  royalty_rate: number | null;
  /** Estimated current BOPD from nearby well analysis. */
  nearby_bopd: number | null;
  /** Acreage for well-equivalent scaling (only used when tract_monthly_bbl unavailable). */
  acreage: number | null;
  /** Document-extracted monthly royalty revenue (highest trust). */
  monthly_royalty_document?: number | null;
  /**
   * Verified actual monthly gross oil production (BBL) from all distinct TRRC leases
   * on this specific tract — the highest-trust production input.
   * When provided, bypasses the well-equivalent × median-BOPD estimation entirely
   * and computes royalty income directly from real lease production data.
   */
  tract_monthly_bbl?: number | null;
  /** Number of distinct TRRC leases contributing to tract_monthly_bbl (informational). */
  tract_lease_count?: number | null;
  /** Point estimate from valuation engine (for cap rate calc). */
  point_estimate?: number | null;
}): MineralEconomicsResult {
  // Normalize state to 2-letter abbreviation for lookup
  const STATE_NAME_TO_ABBR: Record<string, string> = {
    texas: "TX", "north dakota": "ND", oklahoma: "OK",
    "west virginia": "WV", ohio: "OH", montana: "MT",
    wyoming: "WY", colorado: "CO",
  };
  const stateRaw = (args.state ?? "").trim().toLowerCase();
  const stateKey = (stateRaw.length === 2 ? stateRaw.toUpperCase() : STATE_NAME_TO_ABBR[stateRaw]) ?? stateRaw.toUpperCase();
  const se = STATE_ECONOMICS[stateKey] ?? STATE_ECONOMICS.DEFAULT;
  const royalty = args.royalty_rate ?? 0.125;
  const WELL_SPACING = 160;

  let annual_royalty_gross: number | null = null;
  let annual_gross_oil: number | null = null;
  let basis: MineralEconomicsResult["basis"] = "insufficient";

  // Priority 1: Verified tract-level production (most accurate — actual TRRC lease data)
  // annual royalty = monthly_bbl × 12 × oil_price × royalty_rate
  // No well-equivalent scaling needed — this IS the total production on this tract.
  if (args.tract_monthly_bbl != null && args.tract_monthly_bbl > 0) {
    annual_gross_oil = args.tract_monthly_bbl * 12 * se.oil_price_per_bbl;
    annual_royalty_gross = annual_gross_oil * royalty;
    basis = "tract_production";
  }
  // Priority 2: Document-extracted royalty revenue
  else if (args.monthly_royalty_document != null && args.monthly_royalty_document > 0) {
    annual_royalty_gross = args.monthly_royalty_document * 12;
    annual_gross_oil = annual_royalty_gross / royalty;
    basis = "revenue_document";
  }
  // Priority 3: BOPD-anchored from nearby wells (estimation fallback)
  else if (args.nearby_bopd != null && args.nearby_bopd > 0 && args.acreage != null) {
    const well_equivalents = Math.max(0.25, args.acreage / WELL_SPACING);
    const daily_gross_bbl = well_equivalents * args.nearby_bopd;
    annual_gross_oil = daily_gross_bbl * 365 * se.oil_price_per_bbl;
    annual_royalty_gross = annual_gross_oil * royalty;
    basis = "bopd_anchored";
  }

  if (annual_royalty_gross == null || annual_gross_oil == null) {
    return {
      annual_gross_oil_revenue: null,
      annual_royalty_gross: null,
      annual_severance_tax: null,
      annual_ad_valorem_tax: null,
      annual_net_royalty: null,
      monthly_net_royalty: null,
      effective_net_pct: null,
      state_economics: se,
      basis,
      implied_cap_rate: null,
      loe_estimate_annual: null,
      wi_noi_estimate: null,
      summary: "Insufficient production data to compute mineral economics.",
    };
  }

  // Mineral owner tax burden
  const annual_severance = Math.round(annual_royalty_gross * se.oil_severance_rate);
  const annual_ad_valorem = Math.round(annual_royalty_gross * se.ad_valorem_rate);
  const annual_net = Math.round(annual_royalty_gross - annual_severance - annual_ad_valorem);
  const monthly_net = Math.round(annual_net / 12);
  const effective_net_pct = annual_royalty_gross > 0
    ? Math.round((annual_net / annual_royalty_gross) * 100)
    : null;

  // LOE estimate (operator burden, shown for context / WI analysis)
  const loe_mid = (se.loe_low_per_bbl + se.loe_high_per_bbl) / 2;
  let loe_estimate_annual: number | null = null;
  let wi_noi: number | null = null;
  if (args.nearby_bopd != null && args.acreage != null) {
    const well_equivalents = Math.max(0.25, args.acreage / WELL_SPACING);
    const daily_bbl = well_equivalents * args.nearby_bopd;
    loe_estimate_annual = Math.round(daily_bbl * 365 * loe_mid);
    const gross_rev = annual_gross_oil;
    const wi_severance = Math.round(gross_rev * se.oil_severance_rate);
    wi_noi = Math.round(gross_rev - loe_estimate_annual - wi_severance - annual_ad_valorem);
  }

  // Cap rate implied by point estimate
  let implied_cap_rate: number | null = null;
  if (args.point_estimate != null && args.point_estimate > 0 && annual_net > 0) {
    implied_cap_rate = Math.round((annual_net / args.point_estimate) * 1000) / 10;
  }

  // Build summary
  const netStr = `$${(annual_net / 1000).toFixed(0)}k/yr net`;
  const taxStr = `${(se.oil_severance_rate * 100).toFixed(1)}% severance + ${(se.ad_valorem_rate * 100).toFixed(1)}% ad valorem`;
  const royaltyPct = `${(royalty * 100).toFixed(1)}% royalty`;
  const capStr = implied_cap_rate != null ? ` Implied cap rate: ${implied_cap_rate}%.` : "";
  const basisNote = basis === "tract_production"
    ? ` Based on ${args.tract_monthly_bbl?.toFixed(0)} BBL/mo actual lease production` +
      (args.tract_lease_count ? ` (${args.tract_lease_count} lease${args.tract_lease_count > 1 ? "s" : ""})` : "") + `.`
    : basis === "revenue_document" ? " Based on document-extracted revenue." : "";

  const summary = `${netStr} after ${taxStr} (${royaltyPct}, ${se.state}).${basisNote}${capStr}`;

  return {
    annual_gross_oil_revenue: Math.round(annual_gross_oil),
    annual_royalty_gross: Math.round(annual_royalty_gross),
    annual_severance_tax: annual_severance,
    annual_ad_valorem_tax: annual_ad_valorem,
    annual_net_royalty: annual_net,
    monthly_net_royalty: monthly_net,
    effective_net_pct,
    state_economics: se,
    basis,
    implied_cap_rate,
    loe_estimate_annual,
    wi_noi_estimate: wi_noi,
    summary,
  };
}
