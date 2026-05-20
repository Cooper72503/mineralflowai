/**
 * Risk Scoring & Recommendation Engine
 *
 * Scores an acquisition across six risk dimensions and outputs a
 * pursue / review / pass recommendation with supporting evidence.
 */

export type RiskCategory = {
  name: string;
  score: number;          // 1–10 (1 = very low risk, 10 = very high risk)
  weight: number;         // relative weight for overall score
  flags: string[];        // risk factors found
  mitigants: string[];    // positive offsets
};

export type DiligenceItem = {
  item: string;
  status: "complete" | "pending" | "na";
  priority: "critical" | "important" | "nice_to_have";
};

export type RiskReport = {
  overall_score: number;            // 1–10
  recommendation: "pursue" | "review" | "pass";
  recommendation_rationale: string;
  confidence: "high" | "medium" | "low";

  categories: {
    production:       RiskCategory;
    financial:        RiskCategory;
    compliance:       RiskCategory;
    plugging:         RiskCategory;
    operator:         RiskCategory;
    data_quality:     RiskCategory;
  };

  red_flags:    string[];
  yellow_flags: string[];
  green_flags:  string[];

  diligence_checklist: DiligenceItem[];
};

export type RiskInput = {
  // Production
  decline_rate_monthly_pct:  number | null;
  water_cut_pct:             number | null;
  months_producing:          number | null;
  last_production_date:      string | null;
  trend:                     "increasing" | "flat" | "declining" | "offline" | null;
  monthly_oil_bbl:           number | null;
  eur_bbl:                   number | null;

  // Financial
  loe_per_boe:               number | null;
  monthly_net_income_usd:    number | null;
  loe_statements_count:      number;
  run_tickets_present:       boolean;
  breakeven_oil_price:       number | null;
  offer_mid_usd:             number | null;

  // Compliance
  open_violations:           number;
  total_violations:          number;

  // Plugging
  inactive_well_count:       number;
  total_plug_cost_usd:       number | null;
  orphan_risk:               "low" | "medium" | "high" | null;

  // Operator
  operator_name:             string | null;
  has_bond:                  boolean;
  bond_amount_usd:           number | null;

  // Data quality
  match_tier:                string;   // exact_api | exact_rrc_lease | ...
  documents_provided:        number;
  has_reserve_report:        boolean;
  acquisition_cost_usd:      number | null;
  payout_months:             number | null;
};

// ─── Individual category scorers ─────────────────────────────────────────────

function scoreProduction(i: RiskInput): RiskCategory {
  const flags: string[] = [];
  const mitigants: string[] = [];
  let score = 3; // start healthy

  if (i.trend === "offline") {
    score = 9;
    flags.push("Well is currently offline / no recent production");
  } else {
    if (i.trend === "declining") { score += 1; flags.push("Production trend is declining"); }
    if (i.trend === "increasing") { score -= 1; mitigants.push("Production trend is increasing"); }
    if (i.trend === "flat") mitigants.push("Production is stable");
  }

  // Decline rate risk
  const dr = i.decline_rate_monthly_pct ?? 0;
  if (dr > 8)       { score += 3; flags.push(`Very high monthly decline rate: ${dr.toFixed(1)}%/mo`); }
  else if (dr > 5)  { score += 2; flags.push(`High monthly decline rate: ${dr.toFixed(1)}%/mo`); }
  else if (dr > 3)  { score += 1; flags.push(`Elevated decline rate: ${dr.toFixed(1)}%/mo`); }
  else if (dr > 0 && dr <= 2) mitigants.push(`Low decline rate: ${dr.toFixed(1)}%/mo`);

  // Water cut risk
  const wc = i.water_cut_pct ?? 0;
  if (wc > 90)      { score += 3; flags.push(`Very high water cut: ${wc.toFixed(0)}%`); }
  else if (wc > 70) { score += 2; flags.push(`High water cut: ${wc.toFixed(0)}%`); }
  else if (wc > 50) { score += 1; flags.push(`Elevated water cut: ${wc.toFixed(0)}%`); }
  else if (wc < 20 && wc > 0) mitigants.push(`Low water cut: ${wc.toFixed(0)}%`);

  // Last production recency
  if (i.last_production_date) {
    const monthsAgo = monthsSince(i.last_production_date);
    if (monthsAgo > 12) { score += 2; flags.push(`Last production ${monthsAgo} months ago`); }
    else if (monthsAgo <= 3) mitigants.push("Recently active");
  }

  // Longevity
  if (i.months_producing && i.months_producing > 120) mitigants.push("Long-producing well — track record established");

  return { name: "Production Risk", score: clamp(score), weight: 0.30, flags, mitigants };
}

function scoreFinancial(i: RiskInput): RiskCategory {
  const flags: string[] = [];
  const mitigants: string[] = [];
  let score = 4;

  const loe = i.loe_per_boe ?? null;
  if (loe === null) {
    score = 6;
    flags.push("LOE per BOE unknown — no financial statements provided");
  } else {
    if (loe > 50)      { score = 8; flags.push(`Very high LOE/BOE: $${loe.toFixed(2)} — marginal economics`); }
    else if (loe > 35) { score = 6; flags.push(`High LOE/BOE: $${loe.toFixed(2)}`); }
    else if (loe > 20) { score = 4; }
    else               { score = 2; mitigants.push(`Efficient LOE/BOE: $${loe.toFixed(2)}`); }
  }

  if (i.loe_statements_count === 0) { score += 2; flags.push("No LOE statements provided — cannot verify operating costs"); }
  else if (i.loe_statements_count >= 12) mitigants.push(`${i.loe_statements_count} months of LOE history`);

  if (!i.run_tickets_present) { score += 1; flags.push("No run tickets / purchaser statements to verify revenue"); }
  else mitigants.push("Run tickets available to verify revenue");

  if (i.breakeven_oil_price && i.breakeven_oil_price > 60) {
    score += 2;
    flags.push(`High breakeven oil price: $${i.breakeven_oil_price.toFixed(2)}/bbl`);
  } else if (i.breakeven_oil_price && i.breakeven_oil_price < 30) {
    mitigants.push(`Low breakeven: $${i.breakeven_oil_price.toFixed(2)}/bbl`);
  }

  if (i.payout_months && i.payout_months > 0 && i.payout_months < 30) {
    mitigants.push(`Fast payout: ${i.payout_months} months`);
  }

  if (i.monthly_net_income_usd !== null && i.monthly_net_income_usd > 0) {
    mitigants.push(`Currently cash-flow positive: $${i.monthly_net_income_usd.toLocaleString()}/mo net`);
  } else if (i.monthly_net_income_usd !== null && i.monthly_net_income_usd < 0) {
    flags.push("Currently cash-flow negative");
    score += 2;
  }

  return { name: "Financial Risk", score: clamp(score), weight: 0.25, flags, mitigants };
}

function scoreCompliance(i: RiskInput): RiskCategory {
  const flags: string[] = [];
  const mitigants: string[] = [];
  let score = 2; // start clean

  if (i.open_violations > 0) {
    score += Math.min(i.open_violations * 2, 6);
    flags.push(`${i.open_violations} open TRRC violation(s) — requires remediation`);
  } else if (i.total_violations === 0) {
    mitigants.push("Clean TRRC compliance record");
  }

  if (i.total_violations > 5) {
    score += 2;
    flags.push(`${i.total_violations} total violations on record — pattern of non-compliance`);
  } else if (i.total_violations > 0 && i.open_violations === 0) {
    mitigants.push("Prior violations resolved");
  }

  return { name: "Compliance Risk", score: clamp(score), weight: 0.15, flags, mitigants };
}

function scorePlugging(i: RiskInput): RiskCategory {
  const flags: string[] = [];
  const mitigants: string[] = [];
  let score = 2;

  if (i.inactive_well_count > 0) {
    score += Math.min(i.inactive_well_count * 1.5, 5);
    flags.push(`${i.inactive_well_count} inactive/shut-in well(s) — plugging liability`);
  }

  if (i.total_plug_cost_usd && i.total_plug_cost_usd > 50_000) {
    score += 2;
    flags.push(`Estimated plugging liability: $${(i.total_plug_cost_usd / 1000).toFixed(0)}k`);
  }

  if (i.orphan_risk === "high") {
    score += 3;
    flags.push("High orphan well risk — may lack adequate bonding");
  }

  if (i.inactive_well_count === 0) {
    mitigants.push("No inactive wells identified");
  }

  return { name: "Plugging Liability", score: clamp(score), weight: 0.10, flags, mitigants };
}

function scoreOperator(i: RiskInput): RiskCategory {
  const flags: string[] = [];
  const mitigants: string[] = [];
  let score = 4;

  if (!i.has_bond) {
    score += 3;
    flags.push("No bond on file — financial assurance not confirmed");
  } else {
    mitigants.push("Bond on file with TRRC");
    if (i.bond_amount_usd && i.bond_amount_usd >= 25_000) {
      mitigants.push(`Bond amount: $${(i.bond_amount_usd / 1000).toFixed(0)}k`);
    }
  }

  if (!i.operator_name) {
    score += 1;
    flags.push("Operator name not confirmed");
  }

  return { name: "Operator Risk", score: clamp(score), weight: 0.10, flags, mitigants };
}

function scoreDataQuality(i: RiskInput): RiskCategory {
  const flags: string[] = [];
  const mitigants: string[] = [];
  let score = 5;

  // Match quality
  if (i.match_tier === "exact_api" || i.match_tier === "exact_rrc_lease") {
    score -= 2;
    mitigants.push(`Exact asset match (${i.match_tier.replace("_", " ")})`);
  } else if (i.match_tier === "no_match") {
    score += 3;
    flags.push("No TRRC match — production data unverified");
  } else {
    score += 1;
    flags.push(`Soft match only (${i.match_tier.replace(/_/g, " ")})`);
  }

  // Documents
  if (i.documents_provided === 0) {
    score += 2;
    flags.push("No operator documents provided — financials inferred only");
  } else if (i.documents_provided >= 5) {
    score -= 1;
    mitigants.push(`${i.documents_provided} documents provided`);
  }

  if (i.has_reserve_report) {
    score -= 1;
    mitigants.push("Reserve report provided");
  } else {
    score += 1;
    flags.push("No reserve report — EUR based on decline curve model only");
  }

  return { name: "Data Quality", score: clamp(score), weight: 0.10, flags, mitigants };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo = 1, hi = 10): number {
  return Math.round(Math.max(lo, Math.min(hi, n)));
}

function monthsSince(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

// ─── Diligence checklist builder ─────────────────────────────────────────────

function buildChecklist(i: RiskInput): DiligenceItem[] {
  const items: DiligenceItem[] = [
    {
      item: "Confirm well API numbers and TRRC lease identifiers",
      status: i.match_tier === "exact_api" || i.match_tier === "exact_rrc_lease" ? "complete" : "pending",
      priority: "critical",
    },
    {
      item: "Obtain 24 months of LOE statements",
      status: i.loe_statements_count >= 12 ? "complete" : i.loe_statements_count > 0 ? "pending" : "pending",
      priority: "critical",
    },
    {
      item: "Obtain run tickets or purchaser statements (12+ months)",
      status: i.run_tickets_present ? "complete" : "pending",
      priority: "critical",
    },
    {
      item: "Verify TRRC compliance / open violations",
      status: "complete", // always attempted
      priority: "critical",
    },
    {
      item: "Confirm working interest and NRI via division orders",
      status: "pending",
      priority: "critical",
    },
    {
      item: "Obtain current reservoir / production engineering reserve report",
      status: i.has_reserve_report ? "complete" : "pending",
      priority: "important",
    },
    {
      item: "Inspect wellhead, pumping unit, and tank battery",
      status: "pending",
      priority: "important",
    },
    {
      item: "Verify bonding and financial assurance on file with TRRC",
      status: i.has_bond ? "complete" : "pending",
      priority: "important",
    },
    {
      item: "Review lease agreement and primary term / HBP status",
      status: "pending",
      priority: "important",
    },
    {
      item: "Verify surface use agreement / easements",
      status: "pending",
      priority: "important",
    },
    {
      item: "Confirm SWD permit status and MIT test currency",
      status: "pending",
      priority: i.inactive_well_count > 0 ? "important" : "nice_to_have",
    },
    {
      item: "Title search (3 year runsheet minimum)",
      status: "pending",
      priority: "critical",
    },
    {
      item: "Environmental Phase I site assessment",
      status: "pending",
      priority: "important",
    },
    {
      item: "Obtain workover and repair history (5 years)",
      status: "pending",
      priority: "nice_to_have",
    },
  ];
  return items;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function scoreRisk(input: RiskInput): RiskReport {
  const production   = scoreProduction(input);
  const financial    = scoreFinancial(input);
  const compliance   = scoreCompliance(input);
  const plugging     = scorePlugging(input);
  const operator     = scoreOperator(input);
  const data_quality = scoreDataQuality(input);

  const cats = [production, financial, compliance, plugging, operator, data_quality];
  const totalWeight = cats.reduce((s, c) => s + c.weight, 0);
  const overall = cats.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
  const overallScore = Math.round(overall * 10) / 10;

  // Recommendation thresholds
  let recommendation: "pursue" | "review" | "pass";
  let rationale: string;

  if (overallScore <= 4.0) {
    recommendation = "pursue";
    rationale = `Strong risk profile (score ${overallScore}/10). Asset meets baseline diligence criteria — proceed to LOI and confirmatory due diligence.`;
  } else if (overallScore <= 6.5) {
    recommendation = "review";
    rationale = `Moderate risk profile (score ${overallScore}/10). Asset warrants further diligence before committing — address flagged items before LOI.`;
  } else {
    recommendation = "pass";
    rationale = `Elevated risk profile (score ${overallScore}/10). Material unresolved issues identified — pass unless red flags can be fully mitigated.`;
  }

  // Confidence based on data quality
  const dqScore = data_quality.score;
  const confidence: "high" | "medium" | "low" =
    dqScore <= 4 ? "high" : dqScore <= 6 ? "medium" : "low";

  // Aggregate flags
  const red_flags = [
    ...(input.trend === "offline" ? ["Well offline — verify cause and restart timeline"] : []),
    ...(input.open_violations > 0 ? [`${input.open_violations} open TRRC violation(s)`] : []),
    ...(input.orphan_risk === "high" ? ["High orphan well risk"] : []),
    ...(!input.has_bond ? ["No bond on file with TRRC"] : []),
    ...(input.match_tier === "no_match" ? ["No TRRC match — asset identity unconfirmed"] : []),
    ...(input.monthly_net_income_usd !== null && input.monthly_net_income_usd < 0
      ? ["Currently cash-flow negative"] : []),
  ];

  const yellow_flags = [
    ...(input.decline_rate_monthly_pct && input.decline_rate_monthly_pct > 4
      ? [`High decline rate (${input.decline_rate_monthly_pct.toFixed(1)}%/mo) — EUR may be limited`] : []),
    ...(input.water_cut_pct && input.water_cut_pct > 60
      ? [`Elevated water cut (${input.water_cut_pct.toFixed(0)}%) — monitor disposal costs`] : []),
    ...(input.loe_statements_count === 0 ? ["LOE statements not provided — costs unverified"] : []),
    ...(!input.run_tickets_present ? ["No run tickets — revenue unverified"] : []),
    ...(!input.has_reserve_report ? ["No independent reserve report"] : []),
    ...(input.inactive_well_count > 0 ? [`${input.inactive_well_count} inactive well(s) — plugging exposure`] : []),
    ...(input.loe_per_boe !== null && input.loe_per_boe > 30
      ? [`Above-average LOE/BOE ($${input.loe_per_boe.toFixed(2)}) — stress test economics`] : []),
  ];

  const green_flags = [
    ...(input.trend === "increasing" ? ["Production trend is increasing"] : []),
    ...(input.trend === "flat" ? ["Stable production — no rapid decline"] : []),
    ...(input.total_violations === 0 ? ["Clean TRRC compliance record"] : []),
    ...(input.has_bond ? ["Bond on file with TRRC"] : []),
    ...(input.has_reserve_report ? ["Independent reserve report provided"] : []),
    ...(input.run_tickets_present ? ["Run tickets provided — revenue verified"] : []),
    ...(input.loe_statements_count >= 12 ? ["12+ months LOE history available"] : []),
    ...(input.match_tier === "exact_api" ? ["Exact API match — production data verified"] : []),
    ...(input.payout_months !== null && input.payout_months < 30
      ? [`Fast payout: ${input.payout_months} months`] : []),
  ];

  return {
    overall_score: overallScore,
    recommendation,
    recommendation_rationale: rationale,
    confidence,
    categories: { production, financial, compliance, plugging, operator, data_quality },
    red_flags,
    yellow_flags,
    green_flags,
    diligence_checklist: buildChecklist(input),
  };
}
