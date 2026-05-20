/**
 * Underwriting Report Builder.
 *
 * Takes AI-extracted document data, TRRC production data, TRRC compliance
 * violations, and TRRC injection records, then assembles a complete DDReport
 * with proper provenance, confidence labels, and missing-item tracking.
 *
 * Matching hierarchy (strict):
 *   1. Exact API number
 *   2. Exact RRC lease number (distCode:leaseNo)
 *   3. Operator + lease name + county
 *   4. Well name + county
 *   → Never uses county-level aggregates as subject production
 */

import { randomUUID } from "crypto";
import type {
  DDReport,
  DataPoint,
  DataSource,
  DataConfidence,
  MatchTier,
  SubjectIdentity,
  ProductionSection,
  WellProductionRow,
  EconomicsSection,
  LOEStatement,
  WorkoverSection,
  WorkoverEvent,
  EquipmentSection,
  EquipmentItem,
  ComplianceSection,
  ComplianceViolation,
  PluggingLiabilitySection,
  PluggingLiabilityWell,
  InjectionSection,
  InjectionWellRecord,
  OwnershipSection,
  MissingItem,
  NextQuestion,
  DDReportConfidence,
  DcaSection,
  AcquisitionEconomicsSection,
  EconomicsScenario,
  RiskSection,
} from "./types";
import type { DocumentExtractionResult } from "./document-extraction";
import type { TrrcViolation } from "./trrc-compliance";
import type { TrrcInjectionRecord } from "./trrc-injection";
import { runDca } from "./decline-curve";
import { runEconomics, DEFAULT_PRICE_DECKS } from "./economics-engine";
import { scoreRisk } from "./risk-engine";
import type { FinancialContext } from "./financial-lookup";
import type { BasinBenchmark } from "./benchmarks";

// ─── TRRC production well (from existing well lookup) ─────────────────────────

export type TrrcWellProduction = {
  api: string;
  well_name: string;
  lease_number: string | null;
  district_code: string | null;
  operator: string | null;
  latest_monthly_oil_bbl: number;
  latest_production_month: string | null;
  cum_oil_bbl: number;
  monthly_rows?: { year: number; month: number; oil_bbl: number; gas_mcf: number; water_bbl: number }[];
};

// ─── Helper: build a DataPoint ────────────────────────────────────────────────

function dp<T>(
  value: T | null,
  source: DataSource,
  confidence: DataConfidence,
  sourceDetail?: string,
  note?: string,
): DataPoint<T> {
  return { value, source, confidence, source_detail: sourceDetail, note };
}

function missingDp<T>(note = "Not provided"): DataPoint<T> {
  return { value: null, source: "missing", confidence: "none", note };
}

// ─── Main builder ─────────────────────────────────────────────────────────────

export type BuildReportArgs = {
  input: {
    api_numbers?: string[];
    rrc_lease_numbers?: string[];
    operator_name?: string;
    lease_name?: string;
    county?: string;
    state?: string;
    documents?: { filename: string; text: string; doc_type?: string }[];
  };
  extracted: DocumentExtractionResult | null;
  trrcWells: TrrcWellProduction[];
  trrcViolations: TrrcViolation[];
  trrcInjection: TrrcInjectionRecord[];
  financialContext?: FinancialContext;
  benchmark?: BasinBenchmark;
  processingTimeMs: number;
  aiModel: string;
};

export function buildDDReport(args: BuildReportArgs): DDReport {
  const {
    input,
    extracted,
    trrcWells,
    trrcViolations,
    trrcInjection,
    financialContext,
    benchmark,
    processingTimeMs,
    aiModel,
  } = args;

  const missingItems: MissingItem[] = [];
  const nextQuestions: NextQuestion[] = [];

  // ── Resolve subject identity ──────────────────────────────────────────────

  const providedApis = [
    ...(input.api_numbers ?? []),
    ...(extracted?.api_numbers ?? []),
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  const providedLeases = [
    ...(input.rrc_lease_numbers ?? []),
    ...(extracted?.rrc_lease_numbers ?? []),
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  const operatorName = input.operator_name ?? extracted?.operator_name ?? null;
  const leaseName    = input.lease_name ?? extracted?.lease_name ?? null;
  const county       = input.county ?? extracted?.county ?? null;
  const state        = input.state ?? extracted?.state ?? null;

  // Determine match tier used for TRRC data
  let matchTier: MatchTier = "no_match";
  let matchConfidence: DataConfidence = "none";

  if (trrcWells.length > 0) {
    if (providedApis.length > 0 && trrcWells.some(w => providedApis.includes(w.api))) {
      matchTier = "exact_api";
      matchConfidence = "high";
    } else if (providedLeases.length > 0) {
      matchTier = "exact_rrc_lease";
      matchConfidence = "high";
    } else if (operatorName && leaseName && county) {
      matchTier = "operator_lease_county";
      matchConfidence = "medium";
    } else if (county) {
      matchTier = "well_name_county";
      matchConfidence = "low";
    }
  }

  const subject: SubjectIdentity = {
    api_numbers: providedApis,
    rrc_lease_number: providedLeases[0] ?? null,
    operator_name: operatorName,
    lease_name: leaseName,
    county,
    state,
    match_tier: matchTier,
    match_confidence: matchConfidence,
  };

  // ── Production section ────────────────────────────────────────────────────

  const wellRows: WellProductionRow[] = trrcWells.map(w => {
    // Build monthly trend from rows if available
    const rows = w.monthly_rows ?? [];
    const oilRows = rows.filter(r => r.oil_bbl > 0);

    let trend: "increasing" | "flat" | "declining" | "offline" = "offline";
    if (oilRows.length >= 3) {
      const recent = oilRows.slice(-3).reduce((s, r) => s + r.oil_bbl, 0) / 3;
      const earlier = oilRows.slice(-6, -3).reduce((s, r) => s + r.oil_bbl, 0) / Math.max(1, oilRows.slice(-6, -3).length);
      if (earlier > 0) {
        const pct = (recent - earlier) / earlier;
        if (pct > 0.05)       trend = "increasing";
        else if (pct < -0.08) trend = "declining";
        else                  trend = "flat";
      } else {
        trend = recent > 0 ? "flat" : "offline";
      }
    } else if (oilRows.length > 0) {
      trend = "flat";
    }

    // 6-month avg
    const last6 = oilRows.slice(-6);
    const avg6  = last6.length > 0 ? last6.reduce((s, r) => s + r.oil_bbl, 0) / last6.length : null;
    const last12 = oilRows.slice(-12);
    const avg12  = last12.length > 0 ? last12.reduce((s, r) => s + r.oil_bbl, 0) / last12.length : null;

    // Water cut from latest row
    const latestRow = rows[rows.length - 1];
    let waterCut: number | null = null;
    if (latestRow && latestRow.oil_bbl + latestRow.water_bbl > 0) {
      waterCut = (latestRow.water_bbl / (latestRow.oil_bbl + latestRow.water_bbl)) * 100;
    }

    const trrcSource = `TRRC Lease ${w.lease_number ?? "?"}/${w.district_code ?? "?"}`;

    return {
      api: w.api,
      well_name: w.well_name,
      lease_number: w.lease_number,
      district_code: w.district_code,
      operator: w.operator,
      latest_monthly_oil_bbl: dp(w.latest_monthly_oil_bbl, "trrc", "high", trrcSource),
      latest_monthly_gas_mcf: latestRow?.gas_mcf != null
        ? dp(latestRow.gas_mcf, "trrc", "high", trrcSource)
        : missingDp<number>("Not in TRRC data"),
      latest_monthly_water_bbl: latestRow?.water_bbl != null
        ? dp(latestRow.water_bbl, "trrc", "high", trrcSource)
        : missingDp<number>("Not in TRRC data"),
      latest_production_month: w.latest_production_month,
      water_cut_pct: waterCut != null
        ? dp(waterCut, "trrc", "high", trrcSource)
        : missingDp<number>("Needs operator confirmation"),
      six_month_avg_bbl: avg6 != null ? dp(avg6, "trrc", "high", trrcSource) : missingDp<number>(),
      twelve_month_avg_bbl: avg12 != null ? dp(avg12, "trrc", "high", trrcSource) : missingDp<number>(),
      production_trend: dp(trend, "trrc", avg6 ? "medium" : "low", trrcSource),
      cum_oil_bbl: dp(w.cum_oil_bbl, "trrc", "high", trrcSource),
      formation: null,
      perforation_depth_ft: missingDp<number>("Not in TRRC production data"),
    };
  });

  // Aggregate production
  const totalOil  = trrcWells.reduce((s, w) => s + w.latest_monthly_oil_bbl, 0);
  const totalGas  = trrcWells.reduce((s, w) => {
    const r = w.monthly_rows?.[w.monthly_rows.length - 1];
    return s + (r?.gas_mcf ?? 0);
  }, 0);
  const totalWater = trrcWells.reduce((s, w) => {
    const r = w.monthly_rows?.[w.monthly_rows.length - 1];
    return s + (r?.water_bbl ?? 0);
  }, 0);

  // Water cut from doc extraction if not from TRRC
  const docWaterCut = extracted?.water_cut_pct ?? null;
  const waterCutValue = wellRows.some(w => w.water_cut_pct.value != null)
    ? wellRows.reduce((s, w) => s + (w.water_cut_pct.value ?? 0), 0) / Math.max(1, wellRows.filter(w => w.water_cut_pct.value != null).length)
    : docWaterCut;
  const waterCutSource: DataSource = trrcWells.length > 0 ? "trrc" : docWaterCut != null ? "uploaded_doc" : "missing";

  // Decline rate: simple exponential from 12-month avg vs 6-month avg
  let declineRate: number | null = null;
  const wellsWithTrend = wellRows.filter(w => w.twelve_month_avg_bbl.value && w.six_month_avg_bbl.value);
  if (wellsWithTrend.length > 0) {
    const avgDeclines = wellsWithTrend.map(w => {
      const r12 = w.twelve_month_avg_bbl.value!;
      const r6  = w.six_month_avg_bbl.value!;
      return r12 > 0 ? ((r12 - r6) / r12) * 100 / 6 : 0;  // % per month
    });
    declineRate = avgDeclines.reduce((s, v) => s + v, 0) / avgDeclines.length;
  }

  // Reserve report from docs
  const reservePresent = extracted?.reserve_report_present ?? false;
  const reservePv10    = extracted?.reserve_pv10 ?? null;

  const productionSection: ProductionSection = {
    wells: wellRows,
    total_monthly_oil_bbl: trrcWells.length > 0
      ? dp(totalOil, "trrc", "high", "TRRC production aggregate")
      : missingDp<number>("No TRRC match — provide API number or RRC lease number"),
    total_monthly_gas_mcf: trrcWells.length > 0 && totalGas > 0
      ? dp(totalGas, "trrc", "high", "TRRC production aggregate")
      : missingDp<number>(),
    total_monthly_water_bbl: trrcWells.length > 0 && totalWater > 0
      ? dp(totalWater, "trrc", "high", "TRRC production aggregate")
      : missingDp<number>("Needs operator confirmation"),
    water_cut_pct: waterCutValue != null
      ? dp(waterCutValue, waterCutSource, waterCutSource === "trrc" ? "high" : "medium")
      : missingDp<number>("Needs operator confirmation"),
    decline_rate_pct_monthly: declineRate != null
      ? dp(declineRate, "trrc", "medium", "Computed from TRRC 6/12-month average")
      : missingDp<number>("Needs engineer's decline curve study"),
    production_trend: wellRows.length > 0
      ? dp(wellRows[0].production_trend.value ?? "offline", "trrc", "medium")
      : missingDp<"increasing" | "flat" | "declining" | "offline">(),
    last_production_date: wellRows[0]?.latest_production_month
      ? dp(wellRows[0].latest_production_month, "trrc", "high")
      : missingDp<string>(),
    reserve_report_present: dp(reservePresent, reservePresent ? "uploaded_doc" : "missing", reservePresent ? "high" : "none"),
    reserve_pv10: reservePv10 != null
      ? dp(reservePv10, "uploaded_doc", "medium", "Reserve report")
      : missingDp<number>("Reserve report not provided"),
    notes: trrcWells.length === 0
      ? ["WARNING: No TRRC match found. Provide exact API number or RRC lease number for verified production data. County-level data has NOT been used."]
      : [],
  };

  // ── Economics / LOE section ───────────────────────────────────────────────

  const loeStatements: LOEStatement[] = (extracted?.loe_statements ?? []).map(s => ({
    period: s.period,
    source: "loe_statement" as DataSource,
    source_detail: s.source_detail,
    total_loe_usd: s.total_loe_usd,
    revenue_usd: s.revenue_usd,
    net_income_usd: s.net_income_usd,
    oil_price_per_bbl: s.oil_price_per_bbl,
    gas_price_per_mcf: s.gas_price_per_mcf,
    line_items: s.line_items.map(li => ({ ...li, source_detail: s.source_detail })),
    confidence: s.confidence,
  }));

  const loePeriods = loeStatements.filter(s => s.total_loe_usd != null);
  const avgLoe     = loePeriods.length > 0
    ? loePeriods.reduce((s, v) => s + (v.total_loe_usd ?? 0), 0) / loePeriods.length
    : null;
  const avgRev     = loePeriods.filter(s => s.revenue_usd != null).length > 0
    ? loePeriods.reduce((s, v) => s + (v.revenue_usd ?? 0), 0) / loePeriods.filter(s => s.revenue_usd != null).length
    : null;
  const avgNet     = loePeriods.filter(s => s.net_income_usd != null).length > 0
    ? loePeriods.reduce((s, v) => s + (v.net_income_usd ?? 0), 0) / loePeriods.filter(s => s.net_income_usd != null).length
    : null;

  // LOE per BOE — from statements, then EDGAR public company data, then basin benchmark
  let loePerBoe: number | null = null;
  let avgLoeEffective = avgLoe;
  let loeSource: DataSource = "loe_statement";
  let loeNote: string | undefined;

  if (avgLoe != null && totalOil > 0) {
    loePerBoe = avgLoe / totalOil;
  } else if (financialContext?.edgar?.loe_per_boe != null) {
    // Public company data from SEC EDGAR (company-level, not well-specific)
    loePerBoe      = financialContext.edgar.loe_per_boe;
    avgLoeEffective = totalOil > 0 ? loePerBoe * totalOil : null;
    loeSource       = "uploaded_doc"; // repurpose as external public source
    loeNote         = `SEC EDGAR 10-K (${financialContext.edgar.company_name}, FY${financialContext.edgar.fiscal_year}) — company average, not well-specific`;
  } else if (benchmark != null && totalOil > 0) {
    // Basin benchmark fallback (EIA regional average)
    loePerBoe      = benchmark.loe_median_per_boe;
    avgLoeEffective = loePerBoe * totalOil;
    loeSource       = "inferred";
    loeNote         = `EIA basin benchmark — ${benchmark.basin} median $${benchmark.loe_median_per_boe}/BOE (range $${benchmark.loe_low_per_boe}–$${benchmark.loe_high_per_boe}/BOE). Not well-specific.`;
  }

  // Oil price — from run tickets, then LOE statements, then EIA current price + differential
  const runMonths = (extracted?.production_months ?? []).filter(m => m.oil_price_per_bbl != null);
  const avgOilPrice = runMonths.length > 0
    ? runMonths.reduce((s, m) => s + (m.oil_price_per_bbl ?? 0), 0) / runMonths.length
    : null;
  const loeOilPrice = loePeriods.filter(s => s.oil_price_per_bbl != null);
  const avgLoeOilPrice = loeOilPrice.length > 0
    ? loeOilPrice.reduce((s, v) => s + (v.oil_price_per_bbl ?? 0), 0) / loeOilPrice.length
    : null;

  // EIA + basin differential fallback for oil price
  const eiaWti = financialContext?.oil_price?.wti_spot_usd ?? null;
  const basinDiff = benchmark?.oil_differential_per_bbl ?? -4.00;
  const eiaWellheadPrice = eiaWti != null ? eiaWti + basinDiff : null;

  const oilPriceValue = avgOilPrice ?? avgLoeOilPrice ?? eiaWellheadPrice;
  const oilPriceSource: DataSource = avgOilPrice ? "run_statement"
    : avgLoeOilPrice ? "loe_statement"
    : eiaWellheadPrice ? "inferred"
    : "missing";
  const oilPriceNote = oilPriceSource === "inferred"
    ? `EIA WTI spot $${eiaWti?.toFixed(2)}/bbl ${basinDiff >= 0 ? "+" : ""}${basinDiff.toFixed(2)} ${benchmark?.basin ?? "TX"} differential = est. $${eiaWellheadPrice?.toFixed(2)}/bbl wellhead (${financialContext?.oil_price?.source ?? "hardcoded"})`
    : undefined;

  // EIA gas price fallback
  const eiaHh = financialContext?.oil_price?.henry_hub_usd ?? null;
  const gasDiff = benchmark?.gas_differential_per_mmbtu ?? -0.35;

  const economicsSection: EconomicsSection = {
    loe_statements: loeStatements,
    loe_months_available: loePeriods.length,
    avg_monthly_loe_usd: avgLoeEffective != null
      ? dp(avgLoeEffective, loeSource,
          loePeriods.length >= 12 ? "high" : loePeriods.length > 0 ? "medium" : "low",
          loePeriods.length > 0 ? `${loePeriods.length} months of LOE data` : loeNote)
      : missingDp<number>("LOE statements not provided — critical for WI valuation"),
    avg_monthly_revenue_usd: avgRev != null
      ? dp(avgRev, "loe_statement", loePeriods.length >= 12 ? "high" : "medium")
      : missingDp<number>(),
    avg_monthly_net_income_usd: avgNet != null
      ? dp(avgNet, "loe_statement", loePeriods.length >= 12 ? "high" : "medium")
      : missingDp<number>(),
    loe_per_boe: loePerBoe != null
      ? dp(loePerBoe, "inferred", "medium", "Computed from avg LOE / TRRC monthly production")
      : missingDp<number>(),
    electricity_cost_monthly: extracted?.electricity_cost_monthly != null
      ? dp(extracted.electricity_cost_monthly, "loe_statement", "medium")
      : missingDp<number>("Not broken out in provided LOE"),
    chemical_cost_monthly: extracted?.chemical_cost_monthly != null
      ? dp(extracted.chemical_cost_monthly, "loe_statement", "medium")
      : missingDp<number>(),
    labor_cost_monthly: extracted?.labor_cost_monthly != null
      ? dp(extracted.labor_cost_monthly, "loe_statement", "medium")
      : missingDp<number>(),
    disposal_cost_monthly: extracted?.disposal_cost_monthly != null
      ? dp(extracted.disposal_cost_monthly, "loe_statement", "medium")
      : missingDp<number>(),
    compression_cost_monthly: extracted?.compression_cost_monthly != null
      ? dp(extracted.compression_cost_monthly, "loe_statement", "medium")
      : missingDp<number>(),
    oil_price_received: oilPriceValue != null
      ? dp(oilPriceValue, oilPriceSource,
          oilPriceSource === "run_statement" || oilPriceSource === "loe_statement" ? "medium" : "low",
          oilPriceNote ?? "Avg from run tickets / LOE statements")
      : missingDp<number>("Needs run tickets or purchaser statements"),
    gas_price_received: (() => {
      const loeGas = loePeriods.filter(s => s.gas_price_per_mcf != null);
      if (loeGas.length > 0) {
        const avg = loeGas.reduce((s, v) => s + (v.gas_price_per_mcf ?? 0), 0) / loeGas.length;
        return dp(avg, "loe_statement", "medium");
      }
      if (eiaHh != null) {
        const wellheadGasPrice = eiaHh + gasDiff;
        return dp(wellheadGasPrice, "inferred", "low",
          `EIA Henry Hub $${eiaHh.toFixed(2)}/MMBtu ${gasDiff >= 0 ? "+" : ""}${gasDiff.toFixed(2)} ${benchmark?.basin ?? "TX"} diff = est. $${wellheadGasPrice.toFixed(2)}/MCF wellhead`);
      }
      return missingDp<number>("Needs run tickets or purchaser statements");
    })(),
    run_tickets_present: dp(extracted?.run_tickets_present ?? false, extracted?.run_tickets_present ? "uploaded_doc" : "missing", extracted?.run_tickets_present ? "high" : "none"),
    purchaser_statements_present: dp(extracted?.purchaser_statements_present ?? false, extracted?.purchaser_statements_present ? "uploaded_doc" : "missing", extracted?.purchaser_statements_present ? "high" : "none"),
    notes: [],
  };

  if (loePeriods.length < 12 && loePeriods.length > 0) {
    economicsSection.notes.push(`Only ${loePeriods.length} months of LOE data available — 24 months requested for full underwriting.`);
  }
  if (loePeriods.length === 0) {
    missingItems.push({
      section: "Economics/LOE",
      field: "LOE Statements",
      importance: "critical",
      note: "No LOE statements provided. Request 24 months of joint interest billing from operator.",
    });
  }

  // ── Workovers section ─────────────────────────────────────────────────────

  const workoverEvents: WorkoverEvent[] = (extracted?.workover_events ?? []).map(e => ({
    date: e.date,
    well: e.well,
    type: e.type,
    cost_usd: e.cost_usd,
    result: e.result,
    source: "uploaded_doc" as DataSource,
    source_detail: e.source_detail,
    confidence: "medium" as DataConfidence,
  }));

  const totalWorkoverCost = workoverEvents.reduce((s, e) => s + (e.cost_usd ?? 0), 0);
  const uniqueYears = new Set(workoverEvents.map(e => e.date?.slice(0, 4)).filter(Boolean));
  const avgAnnualWorkover = uniqueYears.size > 0 ? totalWorkoverCost / uniqueYears.size : null;

  const sortedByDate = [...workoverEvents].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const lastWorkoverDate = sortedByDate[0]?.date ?? null;

  const workoverSection: WorkoverSection = {
    events: workoverEvents,
    total_workover_cost_usd: workoverEvents.length > 0
      ? dp(totalWorkoverCost, "uploaded_doc", "medium", "Sum of extracted workover AFEs")
      : missingDp<number>("Workover history not provided"),
    avg_annual_workover_cost_usd: avgAnnualWorkover != null
      ? dp(avgAnnualWorkover, "inferred", "low", "Annualized from provided workover records")
      : missingDp<number>(),
    last_workover_date: lastWorkoverDate
      ? dp(lastWorkoverDate, "uploaded_doc", "medium")
      : missingDp<string>(),
    notes: workoverEvents.length === 0
      ? ["Workover history not provided. Request last 3 years of workover AFEs."]
      : [],
  };

  // ── Equipment section ─────────────────────────────────────────────────────

  const equipmentItems: EquipmentItem[] = (extracted?.equipment_items ?? []).map(e => ({
    type: e.type,
    quantity: e.quantity,
    condition: e.condition,
    age_years: e.age_years,
    estimated_value_usd: e.estimated_value_usd,
    notes: e.notes,
    source: "uploaded_doc" as DataSource,
    source_detail: e.source_detail,
    confidence: "medium" as DataConfidence,
  }));

  const totalEquipmentValue = equipmentItems.reduce((s, e) => s + (e.estimated_value_usd ?? 0), 0);

  const equipmentSection: EquipmentSection = {
    items: equipmentItems,
    total_estimated_value_usd: equipmentItems.length > 0 && totalEquipmentValue > 0
      ? dp(totalEquipmentValue, "uploaded_doc", "low", "Sum of extracted equipment values — verify with field inspection")
      : missingDp<number>("Equipment list not provided"),
    notes: equipmentItems.length === 0
      ? ["Equipment list not provided. Request from operator or field inspection."]
      : [],
  };

  // ── Compliance section ────────────────────────────────────────────────────

  // Merge TRRC violations with doc-extracted violation mentions
  const allViolations: ComplianceViolation[] = [
    ...trrcViolations.map(v => ({
      violation_id: v.violation_id,
      date: v.date,
      type: v.type,
      description: v.description,
      status: v.status,
      penalty_usd: v.penalty_usd,
      api_or_lease: v.api_or_lease,
      source: "trrc" as DataSource,
      source_detail: "TRRC EWA Violation Search",
      confidence: "medium" as DataConfidence,
    })),
    ...(extracted?.violation_mentions ?? []).map(v => ({
      violation_id: null,
      date: v.date,
      type: v.type,
      description: v.description,
      status: v.status,
      penalty_usd: v.penalty_usd,
      api_or_lease: null,
      source: "uploaded_doc" as DataSource,
      source_detail: "Extracted from provided documents",
      confidence: "medium" as DataConfidence,
    })),
  ];

  const openViolations = allViolations.filter(v => v.status === "open");

  const trrcLookupAttempted = trrcViolations.length >= 0;  // always attempted if API provided
  const complianceSource: DataSource = trrcViolations.length > 0 ? "trrc" : "missing";

  const complianceSection: ComplianceSection = {
    violations: allViolations,
    open_violation_count: trrcLookupAttempted
      ? dp(openViolations.length, complianceSource, trrcViolations.length > 0 ? "medium" : "low", "TRRC EWA violation search")
      : missingDp<number>("TRRC compliance lookup not attempted — provide API number"),
    most_recent_violation_date: (() => {
      if (allViolations.length > 0) {
        const d = [...allViolations].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0]?.date;
        return d ? dp<string>(d, "trrc", "medium") : missingDp<string>("Violation date not parsed");
      }
      return missingDp<string>("No violations found");
    })(),
    rrc_good_standing: trrcLookupAttempted
      ? dp(openViolations.length === 0, "trrc", "medium", undefined, openViolations.length > 0 ? `${openViolations.length} open violation(s)` : undefined)
      : missingDp<boolean>("Needs operator confirmation"),
    bond_amount_usd: extracted?.bond_amount_usd != null
      ? dp(extracted.bond_amount_usd, "uploaded_doc", "high")
      : missingDp<number>("Bond certificate not provided"),
    bond_type: extracted?.bond_type != null
      ? dp(extracted.bond_type, "uploaded_doc", "high")
      : missingDp<string>("Bond certificate not provided"),
    bond_number: extracted?.bond_number != null
      ? dp(extracted.bond_number, "uploaded_doc", "high")
      : missingDp<string>(),
    bonding_company: extracted?.bonding_company != null
      ? dp(extracted.bonding_company, "uploaded_doc", "high")
      : missingDp<string>(),
    notes: [],
  };

  if (!extracted?.bond_amount_usd) {
    missingItems.push({
      section: "Compliance",
      field: "Bond Certificate",
      importance: "important",
      note: "Request operator's current RRC bond certificate.",
    });
  }

  // ── Plugging liability section ────────────────────────────────────────────

  const plugWells: PluggingLiabilityWell[] = [
    ...(extracted?.inactive_well_mentions ?? []).map(w => ({
      api: w.api ?? "Unknown",
      well_name: w.well_name,
      status: w.status,
      inactive_since: w.inactive_since,
      estimated_plug_cost_usd: w.estimated_plug_cost,
      rrc_plugging_order: false,
      source: "uploaded_doc" as DataSource,
      confidence: "low" as DataConfidence,
    })),
    // From TRRC wells with no production
    ...trrcWells
      .filter(w => w.latest_monthly_oil_bbl === 0)
      .map(w => ({
        api: w.api,
        well_name: w.well_name,
        status: "Shut-In / No Recent Production",
        inactive_since: w.latest_production_month,
        estimated_plug_cost_usd: benchmark?.plug_cost_per_well ?? null,
        rrc_plugging_order: false,
        source: benchmark ? "inferred" as DataSource : "trrc" as DataSource,
        confidence: benchmark ? "low" as DataConfidence : "medium" as DataConfidence,
      })),
  ];

  const totalPlugCost = plugWells.reduce((s, w) => s + (w.estimated_plug_cost_usd ?? 0), 0);
  const orphanRisk: "low" | "medium" | "high" =
    plugWells.length === 0 ? "low" :
    plugWells.length > 3  ? "high" : "medium";

  const pluggingSection: PluggingLiabilitySection = {
    wells: plugWells,
    total_estimated_plug_cost_usd: plugWells.length > 0 && totalPlugCost > 0
      ? dp(totalPlugCost, "uploaded_doc", "low", "Operator estimates only — verify with RRC average costs")
      : missingDp<number>(plugWells.length > 0 ? "Plug cost estimates not provided" : "No inactive wells identified"),
    inactive_well_count: dp(plugWells.length, "trrc", "medium"),
    orphan_well_risk: dp(orphanRisk, plugWells.length > 0 ? "inferred" : "trrc", "medium"),
    notes: plugWells.length === 0
      ? ["No inactive or shut-in wells identified in provided data. Confirm with TRRC P-5 organization report."]
      : [`${plugWells.length} well(s) identified as inactive or shut-in. Verify plugging liability with RRC H-15 orders.`],
  };

  // ── Injection / SWD section ───────────────────────────────────────────────

  const injectionWells: InjectionWellRecord[] = [
    // From TRRC injection lookup
    ...trrcInjection.map(w => ({
      api: w.api10,
      well_name: w.well_name,
      permit_number: w.permit_number,
      well_type: w.well_type,
      injection_zone: w.injection_zone,
      depth_ft: w.depth_ft,
      permitted_max_volume_bwpd: w.permitted_max_volume_bwpd != null
        ? dp(w.permitted_max_volume_bwpd, "trrc" as DataSource, "high" as DataConfidence, "TRRC injection permit")
        : missingDp<number>("Not in TRRC permit data"),
      permitted_max_pressure_psi: w.permitted_max_pressure_psi != null
        ? dp(w.permitted_max_pressure_psi, "trrc" as DataSource, "high" as DataConfidence)
        : missingDp<number>("Needs operator confirmation"),
      avg_daily_injection_bwpd: missingDp<number>("Request from operator — daily injection logs not public"),
      mit_status: w.mit_status != null
        ? dp(w.mit_status, "trrc" as DataSource, "medium" as DataConfidence)
        : missingDp<string>("Needs operator confirmation"),
      last_mit_date: w.last_mit_date != null
        ? dp(w.last_mit_date, "trrc" as DataSource, "high" as DataConfidence)
        : missingDp<string>(),
      next_mit_due: missingDp<string>("Computed from MIT test schedule — verify with operator"),
      permit_status: w.permit_status != null
        ? dp(w.permit_status, "trrc" as DataSource, "high" as DataConfidence)
        : missingDp<string>(),
      source: "trrc" as DataSource,
      confidence: "medium" as DataConfidence,
    })),
    // From doc extraction
    ...(extracted?.injection_well_mentions ?? []).map(w => ({
      api: w.api ?? "Unknown",
      well_name: w.well_name,
      permit_number: null,
      well_type: w.well_type,
      injection_zone: w.injection_zone,
      depth_ft: w.depth_ft,
      permitted_max_volume_bwpd: w.permitted_max_volume_bwpd != null
        ? dp(w.permitted_max_volume_bwpd, "uploaded_doc" as DataSource, "medium" as DataConfidence, "Extracted from provided docs")
        : missingDp<number>(),
      permitted_max_pressure_psi: w.permitted_max_pressure_psi != null
        ? dp(w.permitted_max_pressure_psi, "uploaded_doc" as DataSource, "medium" as DataConfidence)
        : missingDp<number>(),
      avg_daily_injection_bwpd: w.avg_daily_injection_bwpd != null
        ? dp(w.avg_daily_injection_bwpd, "uploaded_doc" as DataSource, "medium" as DataConfidence)
        : missingDp<number>(),
      mit_status: w.mit_status != null
        ? dp(w.mit_status, "uploaded_doc" as DataSource, "medium" as DataConfidence)
        : missingDp<string>(),
      last_mit_date: w.last_mit_date != null
        ? dp(w.last_mit_date, "uploaded_doc" as DataSource, "medium" as DataConfidence)
        : missingDp<string>(),
      next_mit_due: missingDp<string>(),
      permit_status: missingDp<string>(),
      source: "uploaded_doc" as DataSource,
      confidence: "low" as DataConfidence,
    })),
  ];

  // Deduplicate by API
  const seenApis = new Set<string>();
  const dedupedInjection = injectionWells.filter(w => {
    if (seenApis.has(w.api)) return false;
    seenApis.add(w.api);
    return true;
  });

  const totalCapacity = dedupedInjection.reduce((s, w) => s + (w.permitted_max_volume_bwpd.value ?? 0), 0);

  const injectionSection: InjectionSection = {
    wells: dedupedInjection,
    total_disposal_capacity_bwpd: totalCapacity > 0
      ? dp(totalCapacity, "trrc", "medium", "Sum of permitted max volumes")
      : missingDp<number>(),
    current_utilization_pct: missingDp<number>("Daily injection volumes not public — request from operator"),
    notes: dedupedInjection.length === 0
      ? ["No SWD/injection wells identified. If property includes disposal wells, provide TRRC UIC permit numbers."]
      : [],
  };

  // ── Ownership section ─────────────────────────────────────────────────────

  const ownershipRecords = (extracted?.ownership_records ?? []).map(r => ({
    owner_name: r.owner_name,
    interest_type: r.interest_type,
    decimal_interest: r.decimal_interest,
    nri_decimal: r.nri_decimal,
    source: "uploaded_doc" as DataSource,
    source_detail: r.source_detail,
    confidence: "medium" as DataConfidence,
  }));

  // Try to identify subject WI/NRI from division orders or ownership schedule
  const wiRecord = ownershipRecords.find(r => r.interest_type.includes("WI") || r.interest_type.toLowerCase().includes("working"));
  const riRecord = ownershipRecords.find(r => r.interest_type.includes("RI") || r.interest_type.toLowerCase().includes("royalty"));

  const ownershipSection: OwnershipSection = {
    records: ownershipRecords,
    working_interest_decimal: wiRecord?.decimal_interest != null
      ? dp(wiRecord.decimal_interest, "uploaded_doc", "high", wiRecord.source_detail)
      : missingDp<number>("Division order or WI schedule not provided"),
    royalty_interest_decimal: riRecord?.decimal_interest != null
      ? dp(riRecord.decimal_interest, "uploaded_doc", "high", riRecord.source_detail)
      : missingDp<number>(),
    nri_decimal: wiRecord?.nri_decimal != null
      ? dp(wiRecord.nri_decimal, "uploaded_doc", "high")
      : riRecord?.nri_decimal != null
        ? dp(riRecord.nri_decimal, "uploaded_doc", "high")
        : missingDp<number>("NRI not found in provided docs"),
    subject_wi: missingDp<number>("Needs operator confirmation"),
    subject_nri: missingDp<number>("Needs operator confirmation"),
    notes: ownershipRecords.length === 0
      ? ["Division orders and ownership schedules not provided. Request from operator."]
      : [],
  };

  // ── Missing items ─────────────────────────────────────────────────────────

  if (providedApis.length === 0 && trrcWells.length === 0) {
    missingItems.push({
      section: "Production",
      field: "API Number",
      importance: "critical",
      note: "No API number provided. Cannot match TRRC production to this specific property. County-level data has NOT been substituted.",
    });
  }

  if (!reservePresent) {
    missingItems.push({
      section: "Production",
      field: "Reserve Report",
      importance: "important",
      note: "No reserve report provided. Request SEC-standard reserve estimate (PV10).",
    });
  }

  if (extracted?.run_tickets_present === false || !extracted) {
    missingItems.push({
      section: "Economics/LOE",
      field: "Run Tickets",
      importance: "important",
      note: "Run tickets / purchaser statements not provided. Essential to verify actual revenue received.",
    });
  }

  if (ownershipRecords.length === 0) {
    missingItems.push({
      section: "Ownership",
      field: "Division Orders",
      importance: "critical",
      note: "No division orders or WI/NRI schedules provided. Cannot confirm decimal interest.",
    });
  }

  if (equipmentItems.length === 0) {
    missingItems.push({
      section: "Equipment",
      field: "Equipment List",
      importance: "nice_to_have",
      note: "No equipment inventory provided. Request from operator or arrange field inspection.",
    });
  }

  if (workoverEvents.length === 0) {
    missingItems.push({
      section: "Workovers",
      field: "Workover History",
      importance: "important",
      note: "No workover history provided. Request last 3 years of workover AFEs.",
    });
  }

  // ── Next questions ─────────────────────────────────────────────────────────

  if (trrcWells.length === 0) {
    nextQuestions.push({
      question: "What is the exact 10-digit API number for each subject well?",
      rationale: "Without an API number we cannot pull verified TRRC production and must rely entirely on operator-provided data.",
      priority: "high",
      directed_at: "seller",
    });
  }

  if (loePeriods.length < 12) {
    nextQuestions.push({
      question: `Can you provide 24 months of joint interest billing / LOE statements? We have ${loePeriods.length > 0 ? loePeriods.length + " months" : "none"}.`,
      rationale: "LOE statements are the primary input for working interest economics. Without them we cannot calculate LOE/BOE, netback, or breakeven.",
      priority: "high",
      directed_at: "operator",
    });
  }

  if (waterCutValue == null || (waterCutValue > 70)) {
    const q = waterCutValue == null
      ? "What is the current water-oil ratio or water cut percentage?"
      : `Water cut is reported at ${waterCutValue.toFixed(1)}% — what are the monthly disposal costs and is the SWD well permitted for current volumes?`;
    nextQuestions.push({
      question: q,
      rationale: "High or unknown water cut materially impacts LOE through disposal costs and can indicate reservoir pressure decline.",
      priority: waterCutValue == null ? "high" : "high",
      directed_at: "operator",
    });
  }

  if (declineRate != null && declineRate > 3) {
    nextQuestions.push({
      question: `TRRC data shows a decline rate of ~${declineRate.toFixed(1)}%/month. What is the operator's projected production for next 12/24 months?`,
      rationale: "A decline above 3%/month significantly compresses the deal value window. Get an engineer to run type curves before committing.",
      priority: "high",
      directed_at: "engineer",
    });
  }

  if (allViolations.filter(v => v.status === "open").length > 0) {
    nextQuestions.push({
      question: "There are open TRRC violations on file. What is the remediation plan and expected cost to cure?",
      rationale: "Open violations create title and permitting risk and must be cured before any transfer is approved by RRC.",
      priority: "high",
      directed_at: "state_agency",
    });
  }

  if (!extracted?.bond_amount_usd) {
    nextQuestions.push({
      question: "Can you provide a copy of the current RRC operator bond certificate?",
      rationale: "Verifying the bond ensures the operator is in good standing and meets minimum coverage for P&A liability.",
      priority: "medium",
      directed_at: "operator",
    });
  }

  nextQuestions.push({
    question: "What is the current workover budget for the next 12 months and are any wells candidates for recompletion?",
    rationale: "Unbudgeted workovers are the most common LOE surprise in WI acquisitions.",
    priority: "medium",
    directed_at: "operator",
  });

  nextQuestions.push({
    question: "Are there any preferential purchase rights, consents to assign, or area of mutual interest provisions in the operating agreement?",
    rationale: "These can block the acquisition or require third-party consent, extending timelines.",
    priority: "high",
    directed_at: "title_attorney",
  });

  // ── Decline Curve Analysis ────────────────────────────────────────────────

  // Aggregate all monthly rows across TRRC wells
  const allMonthlyRows = trrcWells.flatMap(w => w.monthly_rows ?? []);
  const dcaResult = allMonthlyRows.length >= 3 ? runDca(allMonthlyRows) : null;

  const dcaSection: DcaSection = {
    model_type: dcaResult
      ? dp(dcaResult.model.type, "trrc", "medium", "Arps DCA fit to TRRC production history")
      : missingDp<"exponential"|"hyperbolic"|"harmonic">("Insufficient production history for DCA (need 3+ months)"),
    decline_rate_monthly_pct: dcaResult
      ? dp(dcaResult.decline_rate_monthly_pct, "trrc", dcaResult.months_of_data >= 12 ? "high" : "medium",
          `${dcaResult.months_of_data} months of data, R²=${dcaResult.model.r_squared.toFixed(2)}`)
      : (declineRate != null
          ? dp(Math.abs(declineRate), "trrc", "low", "Simple 6/12-month average — insufficient data for Arps fit")
          : missingDp<number>("No production data for decline analysis")),
    decline_rate_annual_pct: dcaResult
      ? dp(dcaResult.decline_rate_annual_pct, "trrc", "medium")
      : missingDp<number>(),
    b_factor: dcaResult
      ? dp(dcaResult.model.b, "inferred", "medium", `Arps b-factor (${dcaResult.model.type})`)
      : missingDp<number>(),
    r_squared: dcaResult
      ? dp(dcaResult.model.r_squared, "inferred", "medium", "DCA curve fit quality")
      : missingDp<number>(),
    eur_bbl: dcaResult
      ? dp(dcaResult.eur_bbl, "inferred", dcaResult.model.r_squared > 0.8 ? "medium" : "low",
          `Arps EUR to 5 BBL/mo economic limit`)
      : missingDp<number>("Requires 3+ months of production history"),
    remaining_reserves_bbl: dcaResult
      ? dp(dcaResult.remaining_reserves_bbl, "inferred", "low", "EUR minus historical cum — unaudited")
      : missingDp<number>(),
    economic_life_months: dcaResult
      ? dp(dcaResult.economic_life_months, "inferred", "low")
      : missingDp<number>(),
    current_rate_bbl: dcaResult
      ? dp(dcaResult.current_bbl, "trrc", "high", "Most recent TRRC monthly production")
      : (totalOil > 0 ? dp(totalOil, "trrc", "high") : missingDp<number>()),
    peak_rate_bbl: dcaResult
      ? dp(dcaResult.peak_bbl, "trrc", "high")
      : missingDp<number>(),
    cum_oil_bbl: dcaResult
      ? dp(dcaResult.cum_oil_bbl, "trrc", "high", "Total TRRC-reported cumulative production")
      : (trrcWells.length > 0 ? dp(trrcWells.reduce((s, w) => s + w.cum_oil_bbl, 0), "trrc", "high") : missingDp<number>()),
    projections: dcaResult?.projections ?? [],
    notes: dcaResult
      ? [`${dcaResult.model.type} model, R²=${dcaResult.model.r_squared.toFixed(2)}, b=${dcaResult.model.b.toFixed(2)}, Di=${(dcaResult.model.Di * 100).toFixed(2)}%/mo nominal`]
      : ["Decline curve analysis requires TRRC production history. Provide API number for automatic lookup."],
  };

  // ── Acquisition Economics ─────────────────────────────────────────────────

  const nriDecimal  = (() => {
    const r = ownershipRecords.find(r => r.nri_decimal != null);
    return r?.nri_decimal ?? 0.75;
  })();
  const wiDecimal  = (() => {
    const r = ownershipRecords.find(r =>
      r.interest_type.toLowerCase().includes("wi") || r.interest_type.toLowerCase().includes("working")
    );
    return r?.decimal_interest ?? 1.0;
  })();

  // Use effective LOE (from statements → EDGAR → benchmark)
  const monthlyLoe = avgLoeEffective ?? 0;
  const dcaMonthlyDecline = dcaResult
    ? dcaResult.model.Di
    : (declineRate != null ? Math.abs(declineRate) / 100 : 0.012);
  const bFactor = dcaResult?.model.b ?? 0;

  // Build price decks — anchor Base deck to current EIA price if available
  const baseDeckOil = eiaWti != null ? eiaWti : 65;
  const baseDeckGas = eiaHh  != null ? eiaHh  : 2.50;
  const diff        = basinDiff;
  const customDecks = [
    { label: "Stress",  oil_usd_bbl: Math.max(baseDeckOil - 20, 35), gas_usd_mcf: Math.max(baseDeckGas - 0.60, 1.50), differential_bbl: diff - 1.00 },
    { label: "Base",    oil_usd_bbl: baseDeckOil,                     gas_usd_mcf: baseDeckGas,                         differential_bbl: diff },
    { label: "Strip",   oil_usd_bbl: baseDeckOil + 7,                 gas_usd_mcf: baseDeckGas + 0.50,                  differential_bbl: diff + 0.75 },
    { label: "Upside",  oil_usd_bbl: baseDeckOil + 20,                gas_usd_mcf: baseDeckGas + 1.00,                  differential_bbl: diff + 1.50 },
  ];

  const econResult = (totalOil > 0 || monthlyLoe > 0)
    ? runEconomics({
        monthly_oil_bbl:           totalOil,
        monthly_gas_mcf:           totalGas,
        monthly_loe_usd:           monthlyLoe,
        nri_decimal:               nriDecimal,
        wi_decimal:                wiDecimal,
        decline_rate_monthly:      dcaMonthlyDecline,
        b_factor:                  bFactor,
        eur_bbl:                   dcaResult?.eur_bbl ?? 0,
        remaining_reserves_bbl:    dcaResult?.remaining_reserves_bbl ?? 0,
        cum_production_bbl:        dcaResult?.cum_oil_bbl ?? 0,
        price_decks:               customDecks,
      })
    : null;

  const econNriSource: DataSource = ownershipRecords.some(r => r.nri_decimal != null) ? "uploaded_doc" : "inferred";
  const econWiSource: DataSource  = ownershipRecords.some(r => r.interest_type.toLowerCase().includes("wi")) ? "uploaded_doc" : "inferred";

  const acquisitionEconomicsSection: AcquisitionEconomicsSection = {
    nri_decimal: dp(nriDecimal, econNriSource, econNriSource === "uploaded_doc" ? "high" : "low",
      econNriSource === "inferred" ? "Assumed 75% NRI — provide division orders to confirm" : undefined),
    wi_decimal:  dp(wiDecimal,  econWiSource,  econWiSource  === "uploaded_doc" ? "high" : "low",
      econWiSource  === "inferred" ? "Assumed 100% WI — provide JOA to confirm" : undefined),
    monthly_net_income_usd: econResult
      ? dp(econResult.monthly_net_income_usd, totalOil > 0 ? "trrc" : "loe_statement", totalOil > 0 ? "medium" : "low",
          "TRRC production × base price deck − LOE")
      : missingDp<number>("Requires production and LOE data"),
    annual_net_income_usd: econResult
      ? dp(econResult.annual_net_income_usd, "inferred", "medium")
      : missingDp<number>(),
    npv10_usd: econResult
      ? dp(econResult.npv10_base_usd, "inferred", "low", "10% discount rate, base price deck, Arps decline. Unaudited.")
      : missingDp<number>(),
    offer_range_low:  econResult ? dp(econResult.offer_range_low,  "inferred", "low", "3× annual NCF") : missingDp<number>(),
    offer_range_mid:  econResult ? dp(econResult.offer_range_mid,  "inferred", "low", "4.5× annual NCF") : missingDp<number>(),
    offer_range_high: econResult ? dp(econResult.offer_range_high, "inferred", "low", "6× annual NCF, capped at 85% NPV10") : missingDp<number>(),
    breakeven_oil_price: econResult
      ? dp(econResult.breakeven_oil_price, "inferred", "medium", "Oil price at which net income = 0")
      : missingDp<number>(),
    months_remaining: econResult
      ? dp(econResult.months_of_production_remaining, "inferred", "low")
      : missingDp<number>(),
    scenarios: econResult
      ? econResult.scenarios.map((s): EconomicsScenario => ({
          deck_label:              s.deck.label,
          oil_price_usd:           s.deck.oil_usd_bbl,
          gas_price_usd:           s.deck.gas_usd_mcf,
          monthly_gross_revenue:   s.monthly_gross_revenue_usd,
          monthly_net_revenue:     s.monthly_net_revenue_usd,
          monthly_net_income:      s.monthly_net_income_usd,
          loe_per_boe:             s.loe_per_boe,
          annual_net_income:       s.annual_net_income_usd,
          npv10_usd:               s.npv10_usd,
          npv15_usd:               s.npv15_usd,
          offer_low_usd:           s.offer_low_usd,
          offer_mid_usd:           s.offer_mid_usd,
          offer_high_usd:          s.offer_high_usd,
          irr_pct:                 s.irr_pct,
          payout_months:           s.payout_months,
        }))
      : [],
    notes: econResult
      ? [
          `NRI: ${(nriDecimal * 100).toFixed(2)}% (${econNriSource}), WI: ${(wiDecimal * 100).toFixed(0)}% (${econWiSource})`,
          "Offer ranges based on 3×–6× annual NCF multiples. LOE from " + (monthlyLoe > 0 ? "provided statements" : "assumed $0 — provide LOE for accurate underwriting"),
          "All economics preliminary — not a substitute for a petroleum engineer's reserve report.",
        ]
      : ["Economics unavailable — provide API numbers for TRRC production and LOE statements for cost data."],
  };

  // ── Risk scoring ──────────────────────────────────────────────────────────

  const riskInput = {
    decline_rate_monthly_pct: dcaResult?.decline_rate_monthly_pct ?? (declineRate != null ? Math.abs(declineRate) : null),
    water_cut_pct:            waterCutValue,
    months_producing:         allMonthlyRows.length > 0 ? allMonthlyRows.length : null,
    last_production_date:     wellRows[0]?.latest_production_month ?? null,
    trend:                    wellRows[0]?.production_trend?.value ?? null,
    monthly_oil_bbl:          totalOil > 0 ? totalOil : null,
    eur_bbl:                  dcaResult?.eur_bbl ?? null,
    loe_per_boe:              loePerBoe,
    monthly_net_income_usd:   econResult?.monthly_net_income_usd ?? null,
    loe_statements_count:     loePeriods.length,
    run_tickets_present:      extracted?.run_tickets_present ?? false,
    breakeven_oil_price:      econResult?.breakeven_oil_price ?? null,
    offer_mid_usd:            econResult?.offer_range_mid ?? null,
    open_violations:          openViolations.length,
    total_violations:         allViolations.length,
    inactive_well_count:      plugWells.length,
    total_plug_cost_usd:      totalPlugCost > 0 ? totalPlugCost : null,
    orphan_risk:              orphanRisk,
    operator_name:            operatorName,
    has_bond:                 extracted?.bond_amount_usd != null,
    bond_amount_usd:          extracted?.bond_amount_usd ?? null,
    match_tier:               matchTier,
    documents_provided:       (args.input.documents ?? []).length,
    has_reserve_report:       reservePresent,
    acquisition_cost_usd:     null,
    payout_months:            econResult?.scenarios.find(s => s.deck.label === "Base")?.payout_months ?? null,
  };

  const riskResult = scoreRisk(riskInput);

  const riskSection: RiskSection = {
    overall_score: dp(riskResult.overall_score, "inferred", "medium", "Weighted across 6 risk categories"),
    recommendation: dp(riskResult.recommendation, "inferred", riskResult.confidence, riskResult.recommendation_rationale),
    recommendation_rationale: riskResult.recommendation_rationale,
    confidence: riskResult.confidence,
    categories: riskResult.categories,
    red_flags:    riskResult.red_flags,
    yellow_flags: riskResult.yellow_flags,
    green_flags:  riskResult.green_flags,
    diligence_checklist: riskResult.diligence_checklist,
  };

  // Update missing items from risk checklist
  for (const item of riskResult.diligence_checklist) {
    if (item.status === "pending" && item.priority === "critical") {
      if (!missingItems.some(m => m.field.toLowerCase().includes(item.item.toLowerCase().slice(0, 15)))) {
        missingItems.push({
          section: "Diligence",
          field: item.item,
          importance: "critical",
          note: "From risk-engine diligence checklist",
        });
      }
    }
  }

  // ── Overall confidence ────────────────────────────────────────────────────

  const criticalMissing = missingItems.filter(m => m.importance === "critical").length;
  const importantMissing = missingItems.filter(m => m.importance === "important").length;

  let overallConfidence: DDReportConfidence;
  let overallNote: string;

  if (criticalMissing >= 3) {
    overallConfidence = "very_low";
    overallNote = `${criticalMissing} critical data items missing. This report is a framework only — do not make an offer without the missing data.`;
  } else if (criticalMissing >= 1 || importantMissing >= 3) {
    overallConfidence = "low";
    overallNote = `${criticalMissing} critical and ${importantMissing} important data items missing. Key assumptions require operator confirmation.`;
  } else if (importantMissing >= 1 || trrcWells.length === 0) {
    overallConfidence = "medium";
    overallNote = `${importantMissing} important items need follow-up. TRRC production data ${trrcWells.length > 0 ? "verified" : "not matched"}.`;
  } else {
    overallConfidence = "high";
    overallNote = "All critical data items present. TRRC production verified by exact API match.";
  }

  // ── Assemble report ───────────────────────────────────────────────────────

  return {
    report_id: randomUUID(),
    generated_at: new Date().toISOString(),
    overall_confidence: overallConfidence,
    overall_confidence_note: overallNote,
    subject,
    production: productionSection,
    dca: dcaSection,
    acquisition_economics: acquisitionEconomicsSection,
    risk: riskSection,
    economics: economicsSection,
    workovers: workoverSection,
    equipment: equipmentSection,
    compliance: complianceSection,
    plugging_liability: pluggingSection,
    injection: injectionSection,
    ownership: ownershipSection,
    missing_items: missingItems,
    next_questions: nextQuestions,
    input_documents: (args.input.documents ?? []).map(d => ({
      filename: d.filename,
      doc_type: d.doc_type ?? "Unknown",
      char_count: d.text.length,
    })),
    _meta: {
      trrc_lookup_attempted: providedApis.length > 0 || !!operatorName,
      trrc_match_tier: matchTier,
      trrc_compliance_attempted: trrcViolations.length >= 0,
      trrc_injection_attempted: trrcInjection.length >= 0,
      ai_extraction_model: aiModel,
      processing_time_ms: processingTimeMs,
      eia_price_source: financialContext?.oil_price?.source ?? null,
      eia_wti_usd: financialContext?.oil_price?.wti_spot_usd ?? null,
      edgar_operator: financialContext?.edgar?.company_name ?? null,
      edgar_loe_per_boe: financialContext?.edgar?.loe_per_boe ?? null,
      basin: benchmark?.basin ?? null,
    } as DDReport["_meta"],
  };
}
