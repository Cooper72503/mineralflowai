/**
 * Acquisition Economics Engine
 *
 * Computes NPV, IRR, payout, offer ranges, and scenario analysis for
 * oil & gas working interest / mineral acquisitions.
 */

export type PriceDeck = {
  label: string;
  oil_usd_bbl: number;
  gas_usd_mcf: number;
  differential_bbl: number;  // deduct vs. benchmark (negative = discount)
};

export const DEFAULT_PRICE_DECKS: PriceDeck[] = [
  { label: "Stress",  oil_usd_bbl: 50,  gas_usd_mcf: 2.00, differential_bbl: -5.00 },
  { label: "Base",    oil_usd_bbl: 65,  gas_usd_mcf: 2.50, differential_bbl: -4.00 },
  { label: "Strip",   oil_usd_bbl: 72,  gas_usd_mcf: 3.00, differential_bbl: -3.00 },
  { label: "Upside",  oil_usd_bbl: 85,  gas_usd_mcf: 3.50, differential_bbl: -2.50 },
];

export type EconomicsInput = {
  monthly_oil_bbl: number;
  monthly_gas_mcf: number;
  monthly_loe_usd: number;
  nri_decimal: number;              // 0.75 default
  wi_decimal: number;               // 1.0 default
  decline_rate_monthly: number;     // fractional e.g. 0.012
  b_factor: number;                 // Arps b
  eur_bbl: number;
  remaining_reserves_bbl: number;
  cum_production_bbl: number;
  price_decks?: PriceDeck[];
  acquisition_cost_usd?: number;

  // State production / severance taxes (as fraction of gross revenue, WI-share basis)
  // Texas: oil 4.6%, gas 7.5%
  state_tax_pct_oil?: number;       // e.g. 0.046
  state_tax_pct_gas?: number;       // e.g. 0.075

  // Ad valorem (county property) tax — typically 0.8–1.5% of assessed value.
  // We simplify to a fraction of gross revenue. Default: 0.012 (1.2%).
  ad_valorem_pct?: number;

  // Transport / gathering / compression — deducted from gross revenue before NRI split.
  // Default: $0.50/BBL oil, $0.10/MCF gas. Varies by basin and contract type.
  transport_oil_per_bbl?: number;   // $/BBL
  transport_gas_per_mcf?: number;   // $/MCF

  // Workover reserve — annual budget accrual per BOE, treated as an operating cost.
  // PE-backed buyers typically reserve $1.50–$3.00/BOE/year.
  // Default: $2.00/BOE/year (= ~$0.167/BOE/month × monthly BOE).
  workover_reserve_per_boe_annual?: number;

  // SWD disposal cost — only relevant when water volumes are known.
  // Default: 0 (TRRC does not report water; operator must provide).
  swd_cost_per_bbl_water?: number;  // $/BBL water disposed
  monthly_water_bbl?: number;       // must be provided for SWD cost to apply

  /**
   * Downtime haircut applied to all projected cash flows.
   * A 0.15 haircut reduces each month's projected production by 15% to account
   * for expected downtime consistent with historical pattern.
   * Default: 0 (no haircut unless explicitly set from production-engine analysis).
   */
  downtime_haircut?: number;        // fractional, e.g. 0.10 for 10% expected downtime
};

export type ScenarioResult = {
  deck: PriceDeck;
  monthly_gross_revenue_usd: number;
  monthly_net_revenue_usd: number;      // gross × NRI (after transport deduction)
  monthly_severance_tax_usd: number;    // state production/severance tax (WI share)
  monthly_ad_valorem_usd: number;       // county ad valorem tax
  monthly_transport_usd: number;        // transport / gathering / compression
  monthly_workover_reserve_usd: number; // workover capital reserve accrual
  monthly_swd_cost_usd: number;         // SWD disposal (only if water volumes known)
  monthly_net_income_usd: number;       // net revenue – LOE×WI – severance – ad val – transport – workover
  loe_per_boe: number;
  total_cost_per_boe: number;           // LOE + transport + ad val + workover (all in)
  annual_net_income_usd: number;
  npv10_usd: number;
  npv15_usd: number;
  nav_per_boe: number;
  offer_low_usd: number;
  offer_mid_usd: number;
  offer_high_usd: number;
  irr_pct: number | null;
  payout_months: number | null;
  moic: number | null;                  // Multiple on Invested Capital (total NCF / cost)
  /** Monthly projected net cash flows (Arps decline), up to 60 months */
  monthly_cash_flows?: number[];
};

// ─── Sensitivity Matrix ───────────────────────────────────────────────────────

export type SensitivityCell = {
  production_pct: number;    // production multiplier (50 = 50% of base)
  deck_label: string;        // price deck name
  oil_price: number;         // net oil price (after differential)
  npv10_usd: number;
  annual_net_income_usd: number;
  monthly_net_income_usd: number;
};

export type SensitivityMatrix = {
  production_multipliers: number[];  // e.g. [50, 75, 100, 125]
  price_decks: string[];             // e.g. ["Stress", "Base", "Strip", "Upside"]
  /** cells[i][j] = prodMultipliers[i] × priceDecks[j] */
  cells: SensitivityCell[][];
};

export type EconomicsOutput = {
  scenarios: ScenarioResult[];
  // Base-case summary (from Base price deck)
  monthly_revenue_usd: number;
  monthly_net_income_usd: number;
  loe_per_boe: number;
  total_cost_per_boe: number;
  annual_net_income_usd: number;
  npv10_base_usd: number;
  offer_range_low: number;
  offer_range_mid: number;
  offer_range_high: number;
  breakeven_oil_price: number;
  months_of_production_remaining: number;
  // Cost breakdown (base deck)
  monthly_transport_usd: number;
  monthly_ad_valorem_usd: number;
  monthly_workover_reserve_usd: number;
  monthly_swd_cost_usd: number;
  // Royalty / interest summary
  nri_decimal: number;
  wi_decimal: number;
  // Effective input rates (with downtime haircut applied)
  effective_oil_bbl: number;
  downtime_haircut_applied: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Terminal decline constant — matches decline-curve.ts.
 *
 * When the instantaneous hyperbolic/harmonic decline rate falls below this threshold,
 * forward projections switch to exponential decline at this rate.
 * This prevents b > 1 models from producing unrealistically long economic tails.
 *
 * 8% annual nominal = 0.00667/month — practical industry midpoint (SPE 5–10%).
 * Must match the constant in decline-curve.ts.
 */
const TERMINAL_DI_MONTHLY = 0.006667;

/**
 * Project production rate at t months from now, starting at qi.
 *
 * Di is the instantaneous nominal decline rate at t=0 (now), NOT the historical
 * t=0 rate from the DCA fit window.  Pass dcaResult.effective_Di_at_current from
 * the DCA engine, not model.Di.
 *
 * For hyperbolic / harmonic models, applies the industry-standard terminal
 * decline switch: when the instantaneous Di falls to TERMINAL_DI, the model
 * switches to exponential decline at TERMINAL_DI.  This keeps economic life
 * estimates realistic for high-b wells (b > 1).
 */
function projectRate(
  qi: number,
  Di: number,
  b: number,
  t: number,  // months from now
): number {
  if (t <= 0) return qi;
  if (b <= 0.001) {
    // Exponential — no terminal switch needed
    return qi * Math.exp(-Di * t);
  }

  // Hyperbolic / harmonic — check for terminal switch
  if (Di > TERMINAL_DI_MONTHLY) {
    // Time at which instantaneous Di = TERMINAL_DI:  t_sw = (Di/TERMINAL_DI - 1) / (b·Di)
    const t_sw = (Di / TERMINAL_DI_MONTHLY - 1) / (b * Di);
    if (t >= t_sw) {
      // Rate at the switch point
      const q_sw = qi / Math.pow(1 + b * Di * t_sw, 1 / b);
      // Exponential terminal decline from q_sw
      return q_sw * Math.exp(-TERMINAL_DI_MONTHLY * (t - t_sw));
    }
  }

  // Normal hyperbolic / harmonic before terminal switch
  return qi / Math.pow(1 + b * Di * t, 1 / b);
}

function calcNpv(
  monthlyCashFlows: number[],
  annualDiscountRate: number,
): number {
  const monthlyRate = Math.pow(1 + annualDiscountRate, 1 / 12) - 1;
  return monthlyCashFlows.reduce((pv, cf, i) => {
    return pv + cf / Math.pow(1 + monthlyRate, i + 1);
  }, 0);
}

// Binary-search IRR: find r such that NPV(r) = -cost
function calcIrr(cashFlows: number[], cost: number): number | null {
  if (cost <= 0) return null;
  const flows = [-cost, ...cashFlows];

  // Quick sanity: total inflows must exceed cost
  const totalIn = flows.slice(1).reduce((s, v) => s + v, 0);
  if (totalIn <= cost * 0.05) return null;

  let lo = 0, hi = 20; // annual decimal rate
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const monthlyR = Math.pow(1 + mid, 1 / 12) - 1;
    const npv = flows.reduce((pv, cf, i) => pv + cf / Math.pow(1 + monthlyR, i), 0);
    if (npv > 0) lo = mid; else hi = mid;
    if (hi - lo < 0.0001) break;
  }
  const irr = (lo + hi) / 2;
  return irr > 19 ? null : Math.round(irr * 1000) / 10; // return as %
}

// ─── Single scenario calculation ─────────────────────────────────────────────

function calcScenario(
  input: EconomicsInput,
  deck: PriceDeck,
  maxMonths = 360,
): ScenarioResult {
  const {
    monthly_oil_bbl, monthly_gas_mcf, monthly_loe_usd,
    nri_decimal, wi_decimal, decline_rate_monthly, b_factor,
    acquisition_cost_usd,
    state_tax_pct_oil    = 0,
    state_tax_pct_gas    = 0,
    ad_valorem_pct       = 0.012,     // 1.2% of gross revenue
    transport_oil_per_bbl = 0.50,     // $/BBL transport
    transport_gas_per_mcf = 0.10,     // $/MCF transport
    workover_reserve_per_boe_annual = 2.00,  // $/BOE/year workover reserve
    swd_cost_per_bbl_water = 0,
    monthly_water_bbl    = 0,
    downtime_haircut     = 0,
  } = input;

  const netOilPrice = deck.oil_usd_bbl + deck.differential_bbl;
  const downtimeFactor = 1 - Math.max(0, Math.min(0.5, downtime_haircut));

  // Effective production rates (adjusted for expected downtime)
  const effOil = monthly_oil_bbl * downtimeFactor;
  const effGas = monthly_gas_mcf * downtimeFactor;
  const effBoe = Math.max(effOil + effGas / 6, 0.1);

  // Current-month revenue (gross, before NRI split)
  // Transport is a per-unit deduction from gross wellhead price (pre-NRI)
  const oilGrossRev = effOil * netOilPrice;
  const gasGrossRev = effGas * deck.gas_usd_mcf;
  const grossRev    = oilGrossRev + gasGrossRev;

  // Transport / gathering deduction (pre-NRI)
  const transportCost = effOil * transport_oil_per_bbl + effGas * transport_gas_per_mcf;
  const grossRevAfterTransport = Math.max(grossRev - transportCost, 0);

  // Net revenue (operator's NRI share of gross after transport)
  const netRev  = grossRevAfterTransport * nri_decimal;

  // Severance/production tax: WI-share of gross value × state rate
  const sevTax  = oilGrossRev * wi_decimal * state_tax_pct_oil
                + gasGrossRev * wi_decimal * state_tax_pct_gas;

  // Ad valorem (county property tax): % of gross revenue
  const adValTax = grossRev * ad_valorem_pct * wi_decimal;

  // LOE (direct operating cost)
  const loeCost  = monthly_loe_usd * wi_decimal;

  // Workover reserve (annual $/BOE → monthly)
  const workoverReserve = (workover_reserve_per_boe_annual / 12) * effBoe * wi_decimal;

  // SWD disposal cost (only if water volumes known)
  const swdCost = monthly_water_bbl * swd_cost_per_bbl_water * wi_decimal;

  // Net income
  const netIncome = netRev - loeCost - sevTax - adValTax - workoverReserve - swdCost;

  // Per-BOE cost metrics
  const loePerBoe        = loeCost / effBoe;
  const totalCostPerBoe  = (loeCost + transportCost * wi_decimal + adValTax + workoverReserve + swdCost) / effBoe;

  // Project monthly cash flows (Arps decline with downtime haircut applied uniformly)
  const monthlyCFs: number[] = [];
  let cumCF = 0;
  let payoutMonths: number | null = null;
  let moic: number | null = null;

  for (let m = 0; m < maxMonths; m++) {
    const q    = projectRate(effOil, decline_rate_monthly, b_factor, m);
    const qg   = projectRate(effGas, decline_rate_monthly, b_factor, m);
    const qBoe = Math.max(q + qg / 6, 0.001);

    const oRev    = q * netOilPrice;
    const gRev    = qg * deck.gas_usd_mcf;
    const gRoss   = oRev + gRev;
    const trans   = q * transport_oil_per_bbl + qg * transport_gas_per_mcf;
    const rev     = Math.max(gRoss - trans, 0) * nri_decimal;
    const sev     = oRev * wi_decimal * state_tax_pct_oil + gRev * wi_decimal * state_tax_pct_gas;
    const adVal   = gRoss * ad_valorem_pct * wi_decimal;
    const wkover  = (workover_reserve_per_boe_annual / 12) * qBoe * wi_decimal;
    const swd     = monthly_water_bbl * swd_cost_per_bbl_water * wi_decimal; // water assumed flat
    const cf      = rev - loeCost - sev - adVal - wkover - swd;

    if (cf < 0 && m > 12) break; // economic limit
    monthlyCFs.push(cf);
    cumCF += cf;
    if (payoutMonths === null && acquisition_cost_usd && cumCF >= acquisition_cost_usd) {
      payoutMonths = m + 1;
    }
  }

  const npv10 = calcNpv(monthlyCFs, 0.10);
  const npv15 = calcNpv(monthlyCFs, 0.15);
  const navPerBoe = input.remaining_reserves_bbl > 0
    ? npv10 / input.remaining_reserves_bbl
    : 0;

  // MOIC: total undiscounted NCF / acquisition cost
  if (acquisition_cost_usd && acquisition_cost_usd > 0) {
    const totalNcf = monthlyCFs.reduce((s, v) => s + v, 0);
    moic = Math.round((totalNcf / acquisition_cost_usd) * 100) / 100;
  }

  // Offer range — calibrated to PE-backed WI acquisition market (2025)
  // Conventional stripper wells: 3–5× annual NCF or 70–85% NPV10, whichever is lower
  // Mid-rate wells (>50 BOPD stabilized): 4–7× annual NCF or 80% NPV10
  const annualNcf  = Math.max(netIncome * 12, 0);
  const isHighRate = effOil >= 50;
  const offerLow   = isHighRate ? annualNcf * 3.5 : annualNcf * 2.5;
  const offerMid   = isHighRate ? Math.min(annualNcf * 5.0, npv10 * 0.80) : Math.min(annualNcf * 4.0, npv10 * 0.75);
  const offerHigh  = isHighRate ? Math.min(annualNcf * 7.0, npv10 * 0.85) : Math.min(annualNcf * 5.5, npv10 * 0.80);

  const irr = acquisition_cost_usd
    ? calcIrr(monthlyCFs, acquisition_cost_usd)
    : null;

  return {
    deck,
    monthly_gross_revenue_usd:    Math.round(grossRev),
    monthly_net_revenue_usd:      Math.round(netRev),
    monthly_severance_tax_usd:    Math.round(sevTax),
    monthly_ad_valorem_usd:       Math.round(adValTax),
    monthly_transport_usd:        Math.round(transportCost * wi_decimal),
    monthly_workover_reserve_usd: Math.round(workoverReserve),
    monthly_swd_cost_usd:         Math.round(swdCost),
    monthly_net_income_usd:       Math.round(netIncome),
    loe_per_boe:                  Math.round(loePerBoe * 100) / 100,
    total_cost_per_boe:           Math.round(totalCostPerBoe * 100) / 100,
    annual_net_income_usd:        Math.round(netIncome * 12),
    npv10_usd:                    Math.round(npv10),
    npv15_usd:                    Math.round(npv15),
    nav_per_boe:                  Math.round(navPerBoe * 100) / 100,
    offer_low_usd:                Math.max(Math.round(offerLow / 1000) * 1000, 0),
    offer_mid_usd:                Math.max(Math.round(offerMid / 1000) * 1000, 0),
    offer_high_usd:               Math.max(Math.round(offerHigh / 1000) * 1000, 0),
    irr_pct:                      irr,
    payout_months:                payoutMonths,
    moic,
    monthly_cash_flows:           monthlyCFs.slice(0, 60).map(v => Math.round(v)),
  };
}

// ─── Sensitivity Matrix Builder ──────────────────────────────────────────────

/**
 * Build a production × price sensitivity matrix.
 *
 * Rows: production multipliers (default [50, 75, 100, 125] percent of base)
 * Cols: price decks (default DEFAULT_PRICE_DECKS)
 * Cell value: NPV10 at that combination
 *
 * LOE is treated as semi-fixed: 50% fixed + 50% variable with production,
 * which is realistic for rod-pump / conventional wells (electricity scales
 * with fluid volumes, labor/maintenance does not).
 */
export function buildSensitivityMatrix(
  baseInput: EconomicsInput,
  productionMultipliers: number[] = [50, 75, 100, 125],
  deckOverride?: PriceDeck[],
): SensitivityMatrix {
  const decks  = deckOverride ?? baseInput.price_decks ?? DEFAULT_PRICE_DECKS;
  const nri    = Math.max(baseInput.nri_decimal || 0.75, 0.01);
  const wi     = Math.max(baseInput.wi_decimal  || 1.0,  0.01);

  const cells: SensitivityCell[][] = productionMultipliers.map(pctProd => {
    const factor = pctProd / 100;
    // Scale production; LOE is 50% fixed + 50% variable
    const scaledInput: EconomicsInput = {
      ...baseInput,
      nri_decimal:     nri,
      wi_decimal:      wi,
      monthly_oil_bbl: baseInput.monthly_oil_bbl * factor,
      monthly_gas_mcf: baseInput.monthly_gas_mcf * factor,
      monthly_loe_usd: baseInput.monthly_loe_usd * (0.5 + 0.5 * factor),
    };
    return decks.map(deck => {
      const s = calcScenario(scaledInput, deck);
      return {
        production_pct:        pctProd,
        deck_label:            deck.label,
        oil_price:             deck.oil_usd_bbl + deck.differential_bbl,
        npv10_usd:             s.npv10_usd,
        annual_net_income_usd: s.annual_net_income_usd,
        monthly_net_income_usd: s.monthly_net_income_usd,
      };
    });
  });

  return {
    production_multipliers: productionMultipliers,
    price_decks:            decks.map(d => d.label),
    cells,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function runEconomics(input: EconomicsInput): EconomicsOutput {
  const decks = input.price_decks ?? DEFAULT_PRICE_DECKS;
  const nri   = Math.max(input.nri_decimal || 0.75, 0.01);
  const wi    = Math.max(input.wi_decimal  || 1.0, 0.01);
  const downtime = Math.max(0, Math.min(0.5, input.downtime_haircut ?? 0));

  const normalized: EconomicsInput = { ...input, nri_decimal: nri, wi_decimal: wi };
  const scenarios = decks.map(d => calcScenario(normalized, d));

  // Base-case = "Base" deck or middle deck
  const base = scenarios.find(s => s.deck.label === "Base") ?? scenarios[Math.floor(scenarios.length / 2)];
  const baseDeck = decks.find(d => d.label === "Base") ?? decks[1];

  const effOil = input.monthly_oil_bbl * (1 - downtime);
  const effGas = input.monthly_gas_mcf * (1 - downtime);

  // ── Breakeven oil price — exact binary search ────────────────────────────
  // The old closed-form formula only included LOE and gas contribution.
  // It missed: transport, ad valorem, workover reserve, and severance tax —
  // all of which are price-dependent or production-cost offsets.
  // Binary search over calcScenario is exact and always correct.
  let breakeven = 0;
  if (effOil > 0) {
    let beLo = 0, beHi = 250;
    for (let i = 0; i < 60; i++) {
      const beMid = (beLo + beHi) / 2;
      const testDeck: PriceDeck = { ...baseDeck, oil_usd_bbl: beMid };
      const testNI   = calcScenario(normalized, testDeck).monthly_net_income_usd;
      if (testNI > 0) beHi = beMid; else beLo = beMid;
      if (beHi - beLo < 0.05) break;
    }
    breakeven = Math.round((beLo + beHi) / 2 * 100) / 100;
  } else {
    breakeven = 999; // gas-only or no production
  }

  // Months remaining at base decline
  const lifeMonths = input.decline_rate_monthly > 0 && effOil > 5
    ? Math.min(Math.ceil(
        Math.log(effOil / 5) / Math.max(input.decline_rate_monthly, 0.001)
      ), 360)
    : 360;

  return {
    scenarios,
    monthly_revenue_usd:          base.monthly_net_revenue_usd,
    monthly_net_income_usd:       base.monthly_net_income_usd,
    loe_per_boe:                  base.loe_per_boe,
    total_cost_per_boe:           base.total_cost_per_boe,
    annual_net_income_usd:        base.annual_net_income_usd,
    npv10_base_usd:               base.npv10_usd,
    offer_range_low:              base.offer_low_usd,
    offer_range_mid:              base.offer_mid_usd,
    offer_range_high:             base.offer_high_usd,
    breakeven_oil_price:          breakeven,
    months_of_production_remaining: lifeMonths,
    monthly_transport_usd:        base.monthly_transport_usd,
    monthly_ad_valorem_usd:       base.monthly_ad_valorem_usd,
    monthly_workover_reserve_usd: base.monthly_workover_reserve_usd,
    monthly_swd_cost_usd:         base.monthly_swd_cost_usd,
    nri_decimal:                  nri,
    wi_decimal:                   wi,
    effective_oil_bbl:            Math.round(effOil),
    downtime_haircut_applied:     downtime,
  };
}
