/**
 * Buyer Question Engine
 *
 * Auto-answers 10 standard acquisition diligence questions using
 * rule-based logic — no extra AI calls, no added latency.
 *
 * Each answer is tagged VERIFIED / INFERRED / LOW_CONFIDENCE / OUTSTANDING
 * so the buyer knows immediately how much to trust each response.
 */

import type { DowntimeAnalysisResult } from "./downtime-engine";
import type { DcaResult }              from "./decline-curve";

// ─── Output types ─────────────────────────────────────────────────────────────

export type BuyerQAConfidence = "verified" | "inferred" | "low_confidence" | "outstanding";

export type BuyerQA = {
  id: string;
  question: string;
  short_answer: string;
  detail: string;
  confidence: BuyerQAConfidence;
  sources: string[];
  /** What to request to convert this from OUTSTANDING → verified */
  outstanding_diligence?: string;
};

// ─── Input type ───────────────────────────────────────────────────────────────

export type BuyerQAInput = {
  // Identity & match quality
  match_tier: string;
  operator_name: string | null;
  run_tickets_present: boolean;
  trrc_matched: boolean;

  // Production
  downtime: DowntimeAnalysisResult;
  dca: DcaResult | null;
  production_trend: "increasing" | "flat" | "declining" | "offline" | null;
  water_cut_pct: number | null;
  monthly_oil_bbl: number;
  monthly_gas_mcf: number;
  current_offline: boolean;

  // Compliance
  open_violations: number;
  total_violations: number;
  has_bond: boolean;

  // LOE / economics
  loe_per_boe: number | null;
  avg_monthly_loe_usd: number | null;
  loe_months_available: number;
  loe_source: "loe_statement" | "edgar" | "benchmark" | "none";
  benchmark_loe_per_boe: number | null;
  monthly_net_income_usd: number | null;
  breakeven_oil_price: number | null;

  // Workovers
  workover_count: number;
  last_workover_date: string | null;
  has_abandonment_risk: boolean;
};

// ─── Q1: Downtime / offline status ───────────────────────────────────────────

function q1_whyOffline(input: BuyerQAInput): BuyerQA {
  const dt = input.downtime;

  if (!input.current_offline && dt.periods.length === 0) {
    return {
      id: "q1_offline",
      question: "Has this well experienced significant offline periods, and if so, why?",
      short_answer: dt.total_months_analyzed >= 3
        ? `No significant downtime detected across ${dt.total_months_analyzed} months of history (${dt.downtime_pct}% offline).`
        : "Insufficient history to assess downtime pattern.",
      detail: dt.total_months_analyzed >= 3
        ? `The well has been producing consistently over the analyzed period. Downtime was ${dt.downtime_pct}% — within normal operational range for a mature rod-pump well.`
        : "Fewer than 3 months of production data available. Provide API number for TRRC lookup to assess long-term operational history.",
      confidence: dt.total_months_analyzed >= 12 ? "verified" : "low_confidence",
      sources: dt.total_months_analyzed > 0 ? ["Production history"] : [],
    };
  }

  if (input.current_offline) {
    const cur = dt.periods.find(p => p.is_current);
    const clsLabel: Record<string, string> = {
      current_offline:   "currently offline — cause unknown",
      regulatory:        "currently offline — TRRC violation on file",
      abandonment_risk:  "currently offline 12+ months — abandonment risk",
      mechanical:        "currently offline — extended mechanical failure",
      unknown:           "currently offline — cause undetermined",
    };
    return {
      id: "q1_offline",
      question: "Why is this well currently offline?",
      short_answer: `Well is ${clsLabel[cur?.classification ?? "unknown"] ?? "currently offline"}.`,
      detail: cur
        ? `${cur.classification_rationale} The well has been offline since ${cur.start_period} (${cur.duration_months} month(s)). Pre-downtime rate: ${cur.pre_downtime_rate_bbl ?? "unknown"} BBL/mo. Monthly revenue is $0 until production resumes.`
        : "The most recent production period shows zero output. Cause is unknown without operator confirmation.",
      confidence: cur?.classification === "regulatory" ? "inferred" : "low_confidence",
      sources: ["Production history", ...(cur?.classification === "regulatory" ? ["TRRC violation record"] : [])],
      outstanding_diligence: "Request operator explanation for offline status and a written restart plan with timeline before issuing LOI.",
    };
  }

  // Historical downtime only — well is currently producing
  const classified   = dt.periods.filter(p => p.classification !== "unknown");
  const unclassified = dt.periods.filter(p => p.classification === "unknown");

  const periodLines = dt.periods.map(p =>
    `${p.start_period}–${p.end_period} (${p.duration_months} mo, ${p.classification.replace(/_/g, " ")}): ${p.classification_rationale}`
  );

  return {
    id: "q1_offline",
    question: "Has this well experienced significant offline periods, and if so, why?",
    short_answer: `${dt.periods.length} downtime period(s) detected. Overall downtime: ${dt.downtime_pct}% across ${dt.total_months_analyzed} months.`,
    detail: [
      `${dt.periods.length} downtime period(s) identified in ${dt.total_months_analyzed} months of production history:`,
      ...periodLines,
    ].join("\n"),
    confidence: classified.length === dt.periods.length ? "inferred" : "low_confidence",
    sources: ["Production history"],
    outstanding_diligence: unclassified.length > 0
      ? `${unclassified.length} period(s) could not be classified. Request workover AFEs to confirm cause.`
      : undefined,
  };
}

// ─── Q2: Compliance ───────────────────────────────────────────────────────────

function q2_compliance(input: BuyerQAInput): BuyerQA {
  if (input.open_violations > 0) {
    return {
      id: "q2_compliance",
      question: "Is the operator in good standing with the TRRC?",
      short_answer: `No — ${input.open_violations} open TRRC violation(s) on file.`,
      detail: `TRRC records show ${input.open_violations} open and ${input.total_violations} total violation(s). Open violations must be resolved before TRRC will approve a transfer of operatorship — this is a potential deal blocker. Penalties and remediation costs must be factored into the purchase price.`,
      confidence: "verified",
      sources: ["TRRC EWA violation database"],
      outstanding_diligence: "Request operator's remediation plan, cost-to-cure estimate, and projected closure timeline. Confirm all violations are curable prior to LOI.",
    };
  }

  if (input.total_violations > 0) {
    return {
      id: "q2_compliance",
      question: "Is the operator in good standing with the TRRC?",
      short_answer: `Yes — no open violations. ${input.total_violations} prior violation(s) all resolved.`,
      detail: `TRRC records show ${input.total_violations} historical violation(s), all now closed. This indicates the operator addresses compliance issues when cited.${!input.has_bond ? " Bond certificate was not confirmed — verify financial assurance is in place." : ""}`,
      confidence: "verified",
      sources: ["TRRC EWA violation database"],
    };
  }

  return {
    id: "q2_compliance",
    question: "Is the operator in good standing with the TRRC?",
    short_answer: input.trrc_matched
      ? "Yes — clean TRRC record. No violations found."
      : "Cannot verify — TRRC match not established.",
    detail: input.trrc_matched
      ? `TRRC lookup returned zero violations for this operator/lease. Combined with ${input.has_bond ? "a confirmed bond on file" : "no confirmed bond (verify)"}, regulatory risk appears low.`
      : "A TRRC compliance check was attempted but no records were found because the API number or RRC lease number was not provided. Compliance status is unverified.",
    confidence: input.trrc_matched ? "verified" : "outstanding",
    sources: input.trrc_matched ? ["TRRC EWA violation database"] : [],
    outstanding_diligence: !input.trrc_matched
      ? "Provide API number to enable a direct TRRC compliance lookup."
      : undefined,
  };
}

// ─── Q3: Third-party verification ────────────────────────────────────────────

function q3_verified(input: BuyerQAInput): BuyerQA {
  const isExactApi    = input.match_tier === "exact_api";
  const isExactLease  = input.match_tier === "exact_rrc_lease";
  const hasRunTickets = input.run_tickets_present;

  if (isExactApi) {
    return {
      id: "q3_verified",
      question: "Is the production data independently verified by a third party?",
      short_answer: "Yes — production confirmed by exact API match to TRRC government records.",
      detail: "Texas Railroad Commission is the authoritative third-party source for well production. An exact API number match means production volumes are government-certified and not solely dependent on operator representations.",
      confidence: "verified",
      sources: ["TRRC production database (exact API match)"],
    };
  }

  if (isExactLease || hasRunTickets) {
    return {
      id: "q3_verified",
      question: "Is the production data independently verified by a third party?",
      short_answer: `Partially verified — ${isExactLease ? "RRC lease match" : ""}${isExactLease && hasRunTickets ? " + " : ""}${hasRunTickets ? "run tickets present" : ""}.`,
      detail: `Production data is ${isExactLease ? "matched to TRRC via RRC lease number" : "unmatched to TRRC"}${hasRunTickets ? " and supported by purchaser run tickets which provide direct measurement of wellhead volumes" : ""}. Run tickets from the crude purchaser are the gold standard for revenue verification.`,
      confidence: "inferred",
      sources: [
        ...(input.trrc_matched ? ["TRRC production database"] : []),
        ...(hasRunTickets ? ["Purchaser run tickets"] : []),
      ],
      outstanding_diligence: !isExactApi
        ? "Provide 10-digit API number for exact TRRC match — strongest possible third-party verification."
        : undefined,
    };
  }

  return {
    id: "q3_verified",
    question: "Is the production data independently verified by a third party?",
    short_answer: "No — production is based on operator-provided documents only.",
    detail: "No TRRC match was established and no run tickets were provided. All production figures come from operator-provided documents, which are self-reported and carry operator conflict-of-interest risk. This materially increases valuation uncertainty.",
    confidence: "low_confidence",
    sources: ["Operator-provided documents"],
    outstanding_diligence: "Provide API number for TRRC verification, OR request 12+ months of purchaser run tickets (Form T-1 or equivalent). One of these is required before making an offer.",
  };
}

// ─── Q4: Decline & EUR ───────────────────────────────────────────────────────

function q4_decline(input: BuyerQAInput): BuyerQA {
  if (!input.dca) {
    return {
      id: "q4_decline",
      question: "What is the actual decline rate and how much total oil remains (EUR)?",
      short_answer: "Cannot calculate — insufficient production history for Arps decline curve analysis.",
      detail: "Decline curve analysis requires at least 3 months of positive production history. Without this, EUR and remaining reserves cannot be estimated from available data. Do not underwrite production-based economics without this analysis.",
      confidence: "outstanding",
      sources: [],
      outstanding_diligence: "Provide 12+ months of monthly production history (API number or production statements). 24 months minimum is preferred for robust DCA.",
    };
  }

  const dca = input.dca;
  const lifeYrs  = (dca.economic_life_months / 12).toFixed(1);
  const riskTier = dca.decline_rate_monthly_pct > 5 ? "HIGH (>5%/mo)" :
                   dca.decline_rate_monthly_pct > 3 ? "elevated (>3%/mo)" : "manageable (<3%/mo)";
  const fitQuality = dca.model.r_squared >= 0.85 ? "good" : dca.model.r_squared >= 0.70 ? "moderate" : "poor";

  return {
    id: "q4_decline",
    question: "What is the actual decline rate and how much total oil remains (EUR)?",
    short_answer: `${dca.model.type} decline at ${dca.decline_rate_monthly_pct.toFixed(1)}%/mo (${dca.decline_rate_annual_pct.toFixed(0)}%/yr). EUR: ${dca.eur_bbl.toLocaleString()} BBL.`,
    detail: [
      `Arps ${dca.model.type} model fit to ${dca.months_of_data} months of production (R²=${dca.model.r_squared.toFixed(2)}, ${fitQuality} fit quality).`,
      `Current rate: ${Math.round(dca.current_bbl).toLocaleString()} BBL/mo. Peak rate: ${Math.round(dca.peak_bbl).toLocaleString()} BBL/mo.`,
      `EUR: ${dca.eur_bbl.toLocaleString()} BBL total. Remaining reserves from today: ${dca.remaining_reserves_bbl.toLocaleString()} BBL.`,
      `Economic life: ~${lifeYrs} years. Monthly decline is ${riskTier}.`,
      dca.decline_rate_monthly_pct > 5
        ? "⚠️ High decline rate compresses the deal value window significantly — weight offer toward conservative scenarios."
        : "",
    ].filter(Boolean).join(" "),
    confidence: dca.months_of_data >= 12 && dca.model.r_squared >= 0.80 ? "inferred" : "low_confidence",
    sources: ["Arps DCA model", "Production history"],
    outstanding_diligence: dca.model.r_squared < 0.70
      ? `DCA fit quality is poor (R²=${dca.model.r_squared.toFixed(2)}). Require independent reserve engineer type-curve study before committing above 3× NCF offer.`
      : undefined,
  };
}

// ─── Q5: Production sustainability ───────────────────────────────────────────

function q5_sustainable(input: BuyerQAInput): BuyerQA {
  const dt = input.downtime;
  const concerns: string[]  = [];
  const positives: string[] = [];

  if (input.production_trend === "increasing") positives.push("production trend is increasing");
  if (input.production_trend === "flat")       positives.push("production rate is stable");
  if (input.production_trend === "declining")  concerns.push("production trend is declining");
  if (input.production_trend === "offline")    concerns.push("well is currently offline");

  if (dt.volatility_score >= 7) concerns.push(`high production volatility (score ${dt.volatility_score}/10)`);
  else if (dt.volatility_score <= 3 && dt.total_months_analyzed >= 6) positives.push(`low volatility (score ${dt.volatility_score}/10)`);

  if (dt.downtime_pct > 20) concerns.push(`${dt.downtime_pct.toFixed(0)}% of periods show zero production`);
  if (input.water_cut_pct != null && input.water_cut_pct > 80) concerns.push(`very high water cut (${input.water_cut_pct.toFixed(0)}%) will continue increasing LOE`);

  if (dt.production_consistency === "consistent") positives.push("production history is consistent");
  if (input.dca && input.dca.model.r_squared > 0.80) positives.push(`strong DCA fit (R²=${input.dca.model.r_squared.toFixed(2)})`);

  if (concerns.length === 0) {
    return {
      id: "q5_sustainable",
      question: "Is the current production level sustainable, or is it likely to drop significantly?",
      short_answer: positives.length > 0
        ? `Yes — ${positives[0]}. No sustainability red flags identified.`
        : "No significant sustainability concerns from available data.",
      detail: `Positive indicators: ${positives.length > 0 ? positives.join("; ") : "none identified"}. All-in production consistency is ${dt.production_consistency}.`,
      confidence: input.dca ? "inferred" : "low_confidence",
      sources: ["Production trend analysis", "Downtime analysis"],
    };
  }

  return {
    id: "q5_sustainable",
    question: "Is the current production level sustainable, or is it likely to drop significantly?",
    short_answer: `Concerns: ${concerns.slice(0, 2).join("; ")}.`,
    detail: [
      `Risk factors: ${concerns.join("; ")}.`,
      positives.length > 0 ? `Positive factors: ${positives.join("; ")}.` : "",
      "Recommend independent production engineering review before committing above conservative (3× NCF) offer.",
    ].filter(Boolean).join(" "),
    confidence: "low_confidence",
    sources: ["Production trend analysis", "Downtime analysis"],
    outstanding_diligence: "Request operator's 12-month forward production forecast with supporting type-curve or decline curve analysis.",
  };
}

// ─── Q6: Workover cause — mechanical vs. reservoir ───────────────────────────

function q6_workoverCause(input: BuyerQAInput): BuyerQA {
  if (input.workover_count === 0 && input.downtime.periods.length === 0) {
    return {
      id: "q6_workover",
      question: "Are workovers on this property mechanical issues or reservoir-related decline?",
      short_answer: "No workover history provided and no significant downtime detected.",
      detail: "Without workover AFEs or extended downtime periods in the production record, there is insufficient evidence of mechanical or reservoir problems. This could mean the well has had minimal intervention (positive), or that records were not provided (unknown).",
      confidence: "low_confidence",
      sources: ["Production history"],
      outstanding_diligence: "Request last 3 years of workover AFEs to confirm absence of recurring mechanical issues.",
    };
  }

  if (input.workover_count === 0) {
    return {
      id: "q6_workover",
      question: "Are workovers on this property mechanical issues or reservoir-related decline?",
      short_answer: "No workover AFEs provided — cannot assess directly.",
      detail: "No workover records were provided, but the production history does show downtime periods. Without AFEs, it is impossible to confirm whether maintenance is mechanical (bounded, recurring cost) or reservoir-related (permanent production loss).",
      confidence: "outstanding",
      sources: ["Production history (downtime analysis)"],
      outstanding_diligence: "Request last 3–5 years of workover AFEs and completion reports. Critical for assessing recurring maintenance exposure.",
    };
  }

  const mechanical  = input.downtime.periods.filter(p => p.classification === "mechanical" || p.classification === "major_workover");
  const hasMech     = mechanical.length > 0;
  const hasAbandonment = input.downtime.periods.filter(p => p.classification === "abandonment_risk").length > 0;

  if (hasAbandonment) {
    return {
      id: "q6_workover",
      question: "Are workovers on this property mechanical issues or reservoir-related decline?",
      short_answer: "Extended downtime periods suggest possible reservoir depletion or uneconomic repair — significant risk.",
      detail: `Downtime analysis identified period(s) exceeding 12 months with no restart. This is inconsistent with routine mechanical maintenance and may indicate the well reached economic limit or the cost to repair exceeded the value of remaining reserves. ${input.workover_count} workover(s) on record — last: ${input.last_workover_date ?? "unknown"}.`,
      confidence: "inferred",
      sources: ["Production history (downtime analysis)", "Workover records"],
      outstanding_diligence: "Confirm with operator: (1) reason for extended offline periods; (2) whether restimulation or recompletion was attempted; (3) reservoir pressure data.",
    };
  }

  return {
    id: "q6_workover",
    question: "Are workovers on this property mechanical issues or reservoir-related decline?",
    short_answer: hasMech
      ? `${mechanical.length} downtime period(s) suggest mechanical failure — well requires active maintenance investment.`
      : `${input.workover_count} workover(s) on record with good recovery — consistent with routine mechanical maintenance.`,
    detail: hasMech
      ? `Downtime analysis found ${mechanical.length} period(s) consistent with major mechanical failure. Last workover: ${input.last_workover_date ?? "unknown"}. In a mature well, recurring mechanical issues (rod fatigue, tubing wear) are predictable costs — budget $15k–$40k/year for routine intervention.`
      : `${input.workover_count} workover(s) on record. Short downtime durations with strong production recovery suggest routine pump replacement or remedial work, not reservoir decline. Last workover: ${input.last_workover_date ?? "unknown"}.`,
    confidence: "inferred",
    sources: ["Workover AFE records", "Production history (downtime analysis)"],
    outstanding_diligence: hasMech
      ? "Confirm with operator: was each extended downtime a new mechanical failure or repeat issue? Repeat failures indicate systemic downhole problems."
      : undefined,
  };
}

// ─── Q7: Hidden liabilities ───────────────────────────────────────────────────

function q7_hiddenRisks(input: BuyerQAInput): BuyerQA {
  const risks: string[] = [];

  if (input.has_abandonment_risk) {
    risks.push("abandonment-risk periods in production history — possible well depletion or uneconomic repair (verify current status with TRRC P-5)");
  }
  if (input.open_violations > 0) {
    risks.push(`${input.open_violations} open TRRC violation(s) — transfer of operatorship may be blocked until cured`);
  }
  if (input.water_cut_pct != null && input.water_cut_pct > 85) {
    risks.push(`extreme water cut (${input.water_cut_pct.toFixed(0)}%) — disposal costs may exceed oil revenue at sub-$60 oil prices`);
  }
  if (input.breakeven_oil_price != null && input.breakeven_oil_price > 70) {
    risks.push(`high breakeven oil price ($${input.breakeven_oil_price.toFixed(2)}/bbl) — currently marginal or negative economics`);
  }
  if (!input.has_bond && input.trrc_matched) {
    risks.push("operator bond not confirmed — TRRC financial assurance status unknown");
  }
  if (input.loe_source === "none") {
    risks.push("LOE completely unverified — cost basis is unknown (cannot confirm positive economics)");
  }
  if (input.monthly_net_income_usd !== null && input.monthly_net_income_usd < 0) {
    risks.push(`currently cash-flow negative ($${Math.abs(input.monthly_net_income_usd).toLocaleString()}/mo loss) at base price deck`);
  }

  if (risks.length === 0) {
    return {
      id: "q7_hidden",
      question: "Are there hidden liabilities or risks not immediately obvious from the production data?",
      short_answer: "No major hidden liabilities identified from available data.",
      detail: "Screening of compliance records, production history, and financial model did not surface obvious hidden liabilities. Standard diligence (title search, environmental Phase I, field inspection, P&A liability verification) should still be completed for any acquisition.",
      confidence: "inferred",
      sources: ["TRRC compliance check", "Production analysis", "Economic model"],
    };
  }

  return {
    id: "q7_hidden",
    question: "Are there hidden liabilities or risks not immediately obvious from the production data?",
    short_answer: `${risks.length} risk factor(s) identified: ${risks[0].split(" — ")[0]}.`,
    detail: risks.map((r, i) => `${i + 1}. ${r.charAt(0).toUpperCase() + r.slice(1)}.`).join("\n"),
    confidence: "inferred",
    sources: ["TRRC compliance", "Production analysis", "Economic model"],
    outstanding_diligence: "Address each identified risk factor before LOI. Priority order: open violations → abandonment risk → financial assurance.",
  };
}

// ─── Q8: Water cut economics ─────────────────────────────────────────────────

function q8_waterCut(input: BuyerQAInput): BuyerQA {
  const wc = input.water_cut_pct;

  if (wc == null) {
    return {
      id: "q8_watercut",
      question: "What is the current water cut and how does it affect lifting costs?",
      short_answer: "Water cut not available — critical data gap for LOE estimation.",
      detail: "Water cut directly determines disposal costs, which are typically the #1 variable operating expense on mature Texas wells. Without this figure, LOE forecasts carry substantial uncertainty.",
      confidence: "outstanding",
      sources: [],
      outstanding_diligence: "Request current water-oil ratio (WOR) and monthly disposal volumes. Also request SWD well permit status and monthly disposal invoices.",
    };
  }

  const tier: string =
    wc > 90 ? "extreme" : wc > 75 ? "very high" : wc > 50 ? "elevated" : wc > 25 ? "moderate" : "low";
  const impactNote: string =
    wc > 90 ? "Economics become marginal even at high oil prices. Disposal costs may approach or exceed oil revenue." :
    wc > 75 ? "Disposal costs are a primary LOE driver. Verify SWD permit allows current volumes." :
    wc > 50 ? "Disposal costs should be explicitly modeled — do not use flat LOE/BOE benchmarks." :
              "Water disposal is a modest cost component. Standard LOE benchmarks apply.";

  return {
    id: "q8_watercut",
    question: "What is the current water cut and how does it affect lifting costs?",
    short_answer: `${tier.charAt(0).toUpperCase() + tier.slice(1)} water cut at ${wc.toFixed(0)}%.`,
    detail: `A ${wc.toFixed(0)}% water cut means ${(100 - wc).toFixed(0)}% of produced fluid is oil. ${impactNote}${wc > 70 ? " Confirm: (1) SWD well is permitted for current daily injection volumes; (2) MIT mechancial integrity test is current." : ""}`,
    confidence: input.match_tier.startsWith("exact") ? "verified" : "inferred",
    sources: input.match_tier.startsWith("exact") ? ["TRRC production data"] : ["Production documents"],
    outstanding_diligence: wc > 75
      ? "Request monthly water disposal invoices and SWD permit status. Model LOE at +10% and +20% water cut increase to stress-test economics."
      : undefined,
  };
}

// ─── Q9: LOE reliability ──────────────────────────────────────────────────────

function q9_loe(input: BuyerQAInput): BuyerQA {
  const srcLabels: Record<string, string> = {
    loe_statement: "operator-provided LOE / JIB statements",
    edgar:         "SEC EDGAR 10-K (company-wide average)",
    benchmark:     "EIA regional basin benchmark",
    none:          "no LOE data available",
  };
  const srcLabel = srcLabels[input.loe_source] ?? "unknown source";
  const loePerBoe = input.loe_per_boe;

  if (input.loe_source === "none") {
    return {
      id: "q9_loe",
      question: "Is the LOE estimate reliable, and what is it based on?",
      short_answer: "LOE data not available — economics use $0 operating cost (overstates profitability).",
      detail: "No LOE statements, EDGAR data, or basin benchmarks were available. The NPV and offer range calculations assume zero LOE, which overstates profitability. Do not make an offer without establishing an LOE baseline — this is the single most impactful missing input for WI underwriting.",
      confidence: "outstanding",
      sources: [],
      outstanding_diligence: "Request 24 months of joint interest billing (JIB) statements. This is the highest-priority missing data item for working interest valuation.",
    };
  }

  const benchmarkDiff = input.benchmark_loe_per_boe != null && loePerBoe != null
    ? loePerBoe - input.benchmark_loe_per_boe
    : null;
  const comparison = benchmarkDiff != null
    ? benchmarkDiff > 8
      ? ` This is $${benchmarkDiff.toFixed(2)}/BOE above basin benchmark — investigate high cost line items.`
      : benchmarkDiff < -8
        ? ` This is $${Math.abs(benchmarkDiff).toFixed(2)}/BOE below basin benchmark — verify completeness of cost categories.`
        : " This is in line with the regional basin benchmark."
    : "";

  const sourceWarning =
    input.loe_source === "benchmark"
      ? "⚠️ Basin benchmarks are rough estimates — actual costs can vary 2–3× for individual wells. Do not bid aggressively without verified statements."
      : input.loe_source === "edgar"
        ? "⚠️ EDGAR data is a company-wide average — individual well LOE may differ significantly."
        : "";

  return {
    id: "q9_loe",
    question: "Is the LOE estimate reliable, and what is it based on?",
    short_answer: loePerBoe != null
      ? `$${loePerBoe.toFixed(2)}/BOE from ${srcLabel}.`
      : `LOE sourced from ${srcLabel} — per-BOE not calculated.`,
    detail: [
      `LOE estimate sourced from: ${srcLabel}.`,
      input.loe_months_available > 0 ? `${input.loe_months_available} month(s) of cost history available (24 months preferred for full underwriting).` : "",
      comparison,
      sourceWarning,
    ].filter(Boolean).join(" "),
    confidence: input.loe_source === "loe_statement" && input.loe_months_available >= 6
      ? "inferred"
      : "low_confidence",
    sources: [srcLabel, ...(input.benchmark_loe_per_boe != null ? ["EIA basin benchmark"] : [])],
    outstanding_diligence: input.loe_months_available < 12
      ? `Only ${input.loe_months_available} month(s) of LOE data. Request full 24 months of JIB statements for robust cost verification.`
      : undefined,
  };
}

// ─── Q10: Operator track record ───────────────────────────────────────────────

function q10_operator(input: BuyerQAInput): BuyerQA {
  const positives: string[] = [];
  const concerns:  string[] = [];

  if (input.total_violations === 0 && input.trrc_matched) positives.push("clean TRRC compliance record");
  if (input.has_bond) positives.push("financial assurance bond on file");
  if (input.open_violations > 0) concerns.push(`${input.open_violations} open TRRC violation(s) unresolved`);
  if (!input.has_bond && input.trrc_matched) concerns.push("operator bond not confirmed");
  if (input.operator_name) positives.push(`identified operator: ${input.operator_name}`);

  if (concerns.length === 0 && positives.length > 0) {
    return {
      id: "q10_operator",
      question: "Does the operator have a solid track record, and are they financially stable?",
      short_answer: positives.slice(0, 2).join(" + ") + ".",
      detail: `Available signals: ${positives.join("; ")}. No adverse TRRC compliance history identified. Note: this covers only public TRRC records — request P-5 organization report, reference checks from other WI owners, and review operator's portfolio of operated properties for a full picture.`,
      confidence: input.trrc_matched ? "inferred" : "low_confidence",
      sources: ["TRRC compliance database", ...(input.has_bond ? ["TRRC bond records"] : [])],
    };
  }

  return {
    id: "q10_operator",
    question: "Does the operator have a solid track record, and are they financially stable?",
    short_answer: concerns.length > 0
      ? `Risk factors: ${concerns[0]}.`
      : "Operator track record unclear — limited public data.",
    detail: [
      concerns.length > 0 ? `Risk indicators: ${concerns.join("; ")}.` : "",
      positives.length > 0 ? `Positive signals: ${positives.join("; ")}.` : "",
      "Consider: requesting P-5 organization report, reference checks from other working interest owners, and 5-year production history for other operated properties.",
    ].filter(Boolean).join(" "),
    confidence: "low_confidence",
    sources: ["TRRC compliance database"],
    outstanding_diligence: "Request TRRC P-5 filing, contact other WI owners for reference check, and obtain most recent annual operator report.",
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function buildBuyerQA(input: BuyerQAInput): BuyerQA[] {
  return [
    q1_whyOffline(input),
    q2_compliance(input),
    q3_verified(input),
    q4_decline(input),
    q5_sustainable(input),
    q6_workoverCause(input),
    q7_hiddenRisks(input),
    q8_waterCut(input),
    q9_loe(input),
    q10_operator(input),
  ];
}
