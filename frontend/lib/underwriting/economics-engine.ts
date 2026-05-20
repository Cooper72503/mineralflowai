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
  nri_decimal: number;           // 0.75 default
  wi_decimal: number;            // 1.0 default
  decline_rate_monthly: number;  // fractional e.g. 0.012
  b_factor: number;              // Arps b
  eur_bbl: number;
  remaining_reserves_bbl: number;
  cum_production_bbl: number;
  price_decks?: PriceDeck[];
  acquisition_cost_usd?: number;
};

export type ScenarioResult = {
  deck: PriceDeck;
  monthly_gross_revenue_usd: number;
  monthly_net_revenue_usd: number;    // gross × NRI
  monthly_net_income_usd: number;     // net revenue – LOE × WI
  loe_per_boe: number;
  annual_net_income_usd: number;
  npv10_usd: number;
  npv15_usd: number;
  nav_per_boe: number;
  offer_low_usd: number;
  offer_mid_usd: number;
  offer_high_usd: number;
  irr_pct: number | null;
  payout_months: number | null;
};

export type EconomicsOutput = {
  scenarios: ScenarioResult[];
  // Base-case summary
  monthly_revenue_usd: number;
  monthly_net_income_usd: number;
  loe_per_boe: number;
  annual_net_income_usd: number;
  npv10_base_usd: number;
  offer_range_low: number;
  offer_range_mid: number;
  offer_range_high: number;
  breakeven_oil_price: number;
  months_of_production_remaining: number;
  // Royalty / interest summary
  nri_decimal: number;
  wi_decimal: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function projectRate(
  qi: number,
  Di: number,
  b: number,
  t: number,  // months from now
): number {
  if (t <= 0) return qi;
  if (b <= 0.001) return qi * Math.exp(-Di * t);
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
  const { monthly_oil_bbl, monthly_gas_mcf, monthly_loe_usd,
          nri_decimal, wi_decimal, decline_rate_monthly, b_factor,
          acquisition_cost_usd } = input;

  const netOilPrice = deck.oil_usd_bbl + deck.differential_bbl;

  // Current-month economics
  const grossRev  = monthly_oil_bbl * netOilPrice + monthly_gas_mcf * deck.gas_usd_mcf;
  const netRev    = grossRev * nri_decimal;
  const loeCost   = monthly_loe_usd * wi_decimal;
  const netIncome = netRev - loeCost;
  const boe       = Math.max(monthly_oil_bbl + monthly_gas_mcf / 6, 0.1);
  const loePerBoe = loeCost / boe;

  // Project monthly cash flows (Arps decline)
  const monthlyCFs: number[] = [];
  let cumCF = 0;
  let payoutMonths: number | null = null;

  for (let m = 0; m < maxMonths; m++) {
    const q   = projectRate(monthly_oil_bbl, decline_rate_monthly, b_factor, m);
    const qg  = projectRate(monthly_gas_mcf,  decline_rate_monthly, b_factor, m);
    const rev = (q * netOilPrice + qg * deck.gas_usd_mcf) * nri_decimal;
    const cf  = rev - loeCost;
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

  // Offer range: mineral/WI acquisition multiples on annual NCF
  const annualNcf = Math.max(netIncome * 12, 0);
  const offerLow  = annualNcf * 3;
  const offerMid  = annualNcf * 4.5;
  const offerHigh = Math.min(annualNcf * 6, npv10 * 0.85);

  const irr = acquisition_cost_usd
    ? calcIrr(monthlyCFs, acquisition_cost_usd)
    : null;

  return {
    deck,
    monthly_gross_revenue_usd: Math.round(grossRev),
    monthly_net_revenue_usd:   Math.round(netRev),
    monthly_net_income_usd:    Math.round(netIncome),
    loe_per_boe:               Math.round(loePerBoe * 100) / 100,
    annual_net_income_usd:     Math.round(netIncome * 12),
    npv10_usd:                 Math.round(npv10),
    npv15_usd:                 Math.round(npv15),
    nav_per_boe:               Math.round(navPerBoe * 100) / 100,
    offer_low_usd:             Math.max(Math.round(offerLow / 1000) * 1000, 0),
    offer_mid_usd:             Math.max(Math.round(offerMid / 1000) * 1000, 0),
    offer_high_usd:            Math.max(Math.round(offerHigh / 1000) * 1000, 0),
    irr_pct:                   irr,
    payout_months:             payoutMonths,
  };
}

// ─── Breakeven price ─────────────────────────────────────────────────────────

function calcBreakevenPrice(
  monthly_oil_bbl: number,
  monthly_gas_mcf: number,
  monthly_loe_usd: number,
  nri_decimal: number,
  wi_decimal: number,
  gas_usd_mcf: number,
  diff: number,
): number {
  // Solve: (oil_bbl*(P+diff) + gas*gasP) * NRI = LOE * WI
  // P = (LOE*WI/NRI - gas*gasP) / oil_bbl - diff
  if (monthly_oil_bbl <= 0) return 999;
  const gasContrib = monthly_gas_mcf * gas_usd_mcf;
  const required   = monthly_loe_usd * wi_decimal / nri_decimal;
  const price      = (required - gasContrib) / monthly_oil_bbl - diff;
  return Math.max(Math.round(price * 100) / 100, 0);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function runEconomics(input: EconomicsInput): EconomicsOutput {
  const decks = input.price_decks ?? DEFAULT_PRICE_DECKS;
  const nri   = Math.max(input.nri_decimal || 0.75, 0.01);
  const wi    = Math.max(input.wi_decimal  || 1.0, 0.01);

  const normalized: EconomicsInput = { ...input, nri_decimal: nri, wi_decimal: wi };

  const scenarios = decks.map(d => calcScenario(normalized, d));

  // Base-case = "Base" deck or middle deck
  const base = scenarios.find(s => s.deck.label === "Base") ?? scenarios[Math.floor(scenarios.length / 2)];
  const baseDeck = decks.find(d => d.label === "Base") ?? decks[1];

  const breakeven = calcBreakevenPrice(
    input.monthly_oil_bbl,
    input.monthly_gas_mcf,
    input.monthly_loe_usd,
    nri, wi,
    baseDeck.gas_usd_mcf,
    baseDeck.differential_bbl,
  );

  // Months remaining at base decline
  const lifeMonths = input.decline_rate_monthly > 0
    ? Math.min(Math.ceil(
        Math.log(input.monthly_oil_bbl / 5) / input.decline_rate_monthly
      ), 360)
    : 360;

  return {
    scenarios,
    monthly_revenue_usd:     base.monthly_net_revenue_usd,
    monthly_net_income_usd:  base.monthly_net_income_usd,
    loe_per_boe:             base.loe_per_boe,
    annual_net_income_usd:   base.annual_net_income_usd,
    npv10_base_usd:          base.npv10_usd,
    offer_range_low:         base.offer_low_usd,
    offer_range_mid:         base.offer_mid_usd,
    offer_range_high:        base.offer_high_usd,
    breakeven_oil_price:     breakeven,
    months_of_production_remaining: lifeMonths,
    nri_decimal:             nri,
    wi_decimal:              wi,
  };
}
