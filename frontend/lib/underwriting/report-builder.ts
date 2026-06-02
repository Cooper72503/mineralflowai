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
  DowntimeSection,
  BuyerQASection,
  FormationCompletionSection,
  WellCompletionData,
  OperatorProfileSection,
  ExecutiveSummarySection,
  OperationalTimelineEvent,
  DiligenceStatusItem,
  ProductionAudit,
} from "./types";
import type { DocumentExtractionResult } from "./document-extraction";
import type { NormalizedApi } from "./types";
import type { TrrcViolation } from "./trrc-compliance";
import type { TrrcInjectionRecord } from "./trrc-injection";
import type { TrrcInspectionRecord } from "@/lib/wells/trrc-inspection";
import type { TrrcCompletionRecord } from "@/lib/wells/trrc-completions";
import type { InspectionRecord } from "./types";
import { runDca } from "./decline-curve";
import { runEconomics, DEFAULT_PRICE_DECKS, buildSensitivityMatrix } from "./economics-engine";
import type { MonthlyCashFlowRow } from "./types";
import { scoreRisk } from "./risk-engine";
import { analyzeDowntime } from "./downtime-engine";
import { analyzeProductionIntelligence } from "./production-engine";
import type { StabilizedProductionProfile } from "./production-engine";
import { buildBuyerQA } from "./buyer-qa-engine";
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
  // water_bbl is null for TRRC rows — TRRC production reports do not include water volumes.
  monthly_rows?: { year: number; month: number; oil_bbl: number; gas_mcf: number; water_bbl: number | null }[];
};

// Number of post-restart transition months excluded from stabilized averages
// (mirrors RESTART_TRANSITION_MONTHS in production-engine.ts)
const RESTART_TRANSITION_MONTHS_AUDIT = 2;

// ─── Known TRRC source URLs (for audit trail) ─────────────────────────────────

const TRRC_URLS = {
  wellbore:    "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do",
  production:  "https://webapps2.rrc.texas.gov/EWA/specificLeaseQueryAction.do",
  violations:  "https://webapps2.rrc.texas.gov/EWA/violationsQueryAction.do",
  injection:   "https://webapps2.rrc.texas.gov/EWA/injectionQueryAction.do",
  ice:         "https://webapps2.rrc.texas.gov/PDA/ice/pdaIceHome.xhtml",
  completions: "https://webapps.rrc.texas.gov/CMPL/ewaSearchAction.do",
  permits:     "https://webapps2.rrc.texas.gov/EWA/drillingPermitsQueryAction.do",
} as const;

// ─── Helper: build a DataPoint ────────────────────────────────────────────────

function dp<T>(
  value: T | null,
  source: DataSource,
  confidence: DataConfidence,
  sourceDetail?: string,
  note?: string,
  sourceUrl?: string,
): DataPoint<T> {
  return {
    value,
    source,
    confidence,
    source_detail: sourceDetail,
    note,
    source_url:       sourceUrl,
    query_timestamp:  sourceUrl ? new Date().toISOString() : undefined,
  };
}

/**
 * The spec requires this EXACT phrase for every missing field.
 * "Not found in captured public records; request seller/operator or RRC imaged records."
 * Agents must never invent or infer a value to fill a missing field.
 */
const NOT_FOUND = "Not found in captured public records; request seller/operator or RRC imaged records.";

function missingDp<T>(note = NOT_FOUND): DataPoint<T> {
  return { value: null, source: "missing", confidence: "none", note };
}

// ─── API normalization ────────────────────────────────────────────────────────
//
// Accepts any of the common API number formats that users paste in:
//   "15101734"              (8-digit: county+well — assume Texas prefix "42")
//   "4215101734"            (10-digit, no hyphens)
//   "42-151-01734"          (10-digit, formatted)
//   "42151017340000"        (14-digit full UWI, no hyphens)
//   "42-151-01734-00-00"    (14-digit, formatted)
//
// Returns null when the input cannot be parsed into a valid API number.

function normalizeApiNumber(raw: string): NormalizedApi | null {
  const digits = raw.replace(/\D/g, "");

  let api10: string;
  if (digits.length >= 14) {
    api10 = digits.slice(0, 10);
  } else if (digits.length === 10) {
    api10 = digits;
  } else if (digits.length === 8) {
    // Missing leading state code — assume Texas (42)
    api10 = "42" + digits;
  } else {
    // 12-digit, 9-digit, etc — not a recognized format
    return null;
  }

  if (api10.length !== 10 || !/^\d{10}$/.test(api10)) return null;

  const stateCode  = api10.slice(0, 2);
  const countyCode = api10.slice(2, 5);
  const wellCode   = api10.slice(5, 10);

  return {
    raw_api:       raw,
    api_10:        api10,
    api_14:        api10 + "0000",
    api_formatted: `${stateCode}-${countyCode}-${wellCode}`,
    state_code:    stateCode,
    county_code:   countyCode,
  };
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
  /** ICE field inspection records from TRRC (separate from violation database) */
  trrcInspections?: TrrcInspectionRecord[];
  /** Completion packet data from TRRC completions query */
  trrcCompletions?: TrrcCompletionRecord[];
  financialContext?: FinancialContext;
  benchmark?: BasinBenchmark;
  /** User-supplied interest overrides — take precedence over doc extraction */
  nriOverride?: number;
  wiOverride?: number;
  processingTimeMs: number;
  aiModel: string;
  /** "quick" = preliminary triage scan; "full" = complete pipeline (default: "quick") */
  scanMode?: import("./types").ScanMode;
};

export function buildDDReport(args: BuildReportArgs): DDReport {
  const {
    input,
    extracted,
    trrcWells,
    trrcViolations,
    trrcInjection,
    trrcInspections = [],
    trrcCompletions = [],
    financialContext,
    benchmark,
    nriOverride,
    wiOverride,
    processingTimeMs,
    aiModel,
    scanMode = "quick",
  } = args;

  // Is this a Texas well? Used for severance tax rates.
  const resolvedState = (input.state ?? extracted?.state ?? "").toUpperCase().trim();
  const isTexasState  = resolvedState === "TX" || resolvedState === "TEXAS"
    || (input.api_numbers ?? []).some(a => a.replace(/\D/g, "").startsWith("42"));

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

  // ── Normalize all provided API numbers ───────────────────────────────────
  const normalizedApis: NormalizedApi[] = providedApis
    .map(a => normalizeApiNumber(a))
    .filter((n): n is NormalizedApi => n !== null);

  // ── Build match path for audit trail ─────────────────────────────────────
  const matchPath: string[] = [];

  if (providedApis.length > 0) {
    matchPath.push(
      `API input: ${providedApis.slice(0, 3).join(", ")}${providedApis.length > 3 ? ` (+${providedApis.length - 3})` : ""}`,
    );
    if (normalizedApis.length > 0) {
      matchPath.push(
        `Normalized: ${normalizedApis.map(n => n.api_formatted).slice(0, 3).join(", ")}`,
      );
    }
  }
  if (providedLeases.length > 0) {
    matchPath.push(`RRC lease provided: ${providedLeases.slice(0, 3).join(", ")}`);
  }

  if (trrcWells.length > 0) {
    const leaseSummary = trrcWells
      .map(w => `${w.well_name} (dist ${w.district_code}:${w.lease_number})`)
      .slice(0, 3)
      .join(", ");
    matchPath.push(`TRRC wellbore match: ${leaseSummary}`);
    const totalRows = trrcWells.flatMap(w => w.monthly_rows ?? []).length;
    matchPath.push(
      `Production query: ${totalRows} month${totalRows !== 1 ? "s" : ""} of lease-level TRRC data resolved`,
    );
  } else if (providedApis.length > 0) {
    matchPath.push(
      "TRRC wellbore match: no match — TRRC production lookup requires RRC lease number + district code",
    );
    matchPath.push(
      "Production query: skipped — provide RRC lease number (e.g. '06:123456') to enable",
    );
  } else if (providedLeases.length > 0) {
    matchPath.push("TRRC wellbore match: lease lookup attempted but no production data returned");
  } else if (operatorName && county) {
    matchPath.push(`Identity fallback: operator '${operatorName}' + ${county} County`);
  }

  if ((args.input.documents ?? []).length > 0) {
    const runTickets  = extracted?.run_tickets_present  ? "run tickets" : null;
    const purchaserSt = extracted?.purchaser_statements_present ? "purchaser statements" : null;
    const loeMonths   = (extracted?.loe_statements ?? []).length;
    const docParts = [runTickets, purchaserSt, loeMonths > 0 ? `${loeMonths} LOE periods` : null].filter(Boolean);
    if (docParts.length > 0) {
      matchPath.push(`Document extraction: ${docParts.join(", ")}`);
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
    normalized_apis: normalizedApis,
    match_path: matchPath,
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

    // Rolling averages
    const last3  = oilRows.slice(-3);
    const last6  = oilRows.slice(-6);
    const last12 = oilRows.slice(-12);
    const last24 = oilRows.slice(-24);
    const avg3   = last3.length  > 0 ? last3.reduce((s, r) => s + r.oil_bbl, 0) / last3.length  : null;
    const avg6   = last6.length  > 0 ? last6.reduce((s, r) => s + r.oil_bbl, 0) / last6.length  : null;
    const avg12  = last12.length > 0 ? last12.reduce((s, r) => s + r.oil_bbl, 0) / last12.length : null;
    const avg24  = last24.length >= 6 ? last24.reduce((s, r) => s + r.oil_bbl, 0) / last24.length : null;

    // Water cut from latest row.
    // CRITICAL: TRRC production reports do NOT include water disposition volumes.
    // water_bbl is null for TRRC rows — never compute water cut from a null/zero value.
    const latestRow = rows[rows.length - 1];
    let waterCut: number | null = null;
    if (latestRow && latestRow.water_bbl != null && latestRow.water_bbl > 0) {
      waterCut = (latestRow.water_bbl / (latestRow.oil_bbl + latestRow.water_bbl)) * 100;
    }

    const trrcSource = `TRRC Specific Lease Production Query — Lease ${w.lease_number ?? "?"}, District ${w.district_code ?? "?"}`;

    return {
      api: w.api,
      well_name: w.well_name,
      lease_number: w.lease_number,
      district_code: w.district_code,
      operator: w.operator,
      latest_monthly_oil_bbl: dp(w.latest_monthly_oil_bbl, "trrc", "high", trrcSource,
        "Most recent reported month — TRRC data may lag 3–5 months",
        TRRC_URLS.production),
      latest_monthly_gas_mcf: latestRow?.gas_mcf != null
        ? dp(latestRow.gas_mcf, "trrc", "high", trrcSource, undefined, TRRC_URLS.production)
        : missingDp<number>("Gas not reported on this lease"),
      latest_monthly_water_bbl: missingDp<number>(
        "TRRC production reports do not include water disposition volumes. Request water disposal records from operator."
      ),
      latest_production_month: w.latest_production_month,
      water_cut_pct: waterCut != null
        ? dp(waterCut, "trrc", "high", trrcSource)
        : missingDp<number>("Water volumes unavailable — request water disposition from operator"),
      three_month_avg_bbl:      avg3  != null ? dp(avg3,  "trrc", "high", trrcSource) : missingDp<number>(),
      six_month_avg_bbl:        avg6  != null ? dp(avg6,  "trrc", "high", trrcSource) : missingDp<number>(),
      twelve_month_avg_bbl:     avg12 != null ? dp(avg12, "trrc", "high", trrcSource) : missingDp<number>(),
      twenty_four_month_avg_bbl: avg24 != null ? dp(avg24, "trrc", "high", trrcSource) : missingDp<number>(),
      production_trend: dp(trend, "trrc", avg6 ? "medium" : "low", trrcSource),
      cum_oil_bbl: dp(w.cum_oil_bbl, "trrc", "high", trrcSource),
      formation: null,
      perforation_depth_ft: missingDp<number>("Not in TRRC production data"),
      monthly_history: rows.map(r => ({
        period: `${r.year}-${String(r.month).padStart(2, "0")}`,
        oil_bbl: r.oil_bbl,
        gas_mcf: r.gas_mcf ?? 0,
        water_bbl: r.water_bbl,
      })),
    };
  });

  // ── Doc-production fallback rows (when no TRRC match) ────────────────────
  // Build synthetic wellRows + monthly series from extracted production_months
  // so DCA and economics work even without an API match.
  let docMonthlyRows: { year: number; month: number; oil_bbl: number; gas_mcf: number; water_bbl: number | null }[] = [];

  if (trrcWells.length === 0 && extracted?.production_months && extracted.production_months.length > 0) {
    // Aggregate all wells per period
    const byPeriod = new Map<string, { oil: number; gas: number; water: number }>();
    for (const pm of extracted.production_months) {
      const existing = byPeriod.get(pm.period) ?? { oil: 0, gas: 0, water: 0 };
      existing.oil   += pm.oil_bbl   ?? 0;
      existing.gas   += pm.gas_mcf   ?? 0;
      existing.water += pm.water_bbl ?? 0;
      byPeriod.set(pm.period, existing);
    }
    const sortedPeriods = Array.from(byPeriod.entries()).sort(([a], [b]) => a.localeCompare(b));

    docMonthlyRows = sortedPeriods.map(([period, d]) => {
      const [yr, mo] = period.split("-").map(Number);
      return { year: yr, month: mo, oil_bbl: d.oil, gas_mcf: d.gas, water_bbl: d.water };
    });

    // Build one synthetic well row for the production table
    if (sortedPeriods.length > 0) {
      const [latestPeriod, latestData] = sortedPeriods[sortedPeriods.length - 1];
      const last6  = sortedPeriods.slice(-6).map(([, d]) => d.oil);
      const last12 = sortedPeriods.slice(-12).map(([, d]) => d.oil);
      const avg6   = last6.reduce((s, v) => s + v, 0)  / Math.max(last6.length, 1);
      const avg12  = last12.reduce((s, v) => s + v, 0) / Math.max(last12.length, 1);
      const cumOil = docMonthlyRows.reduce((s, r) => s + r.oil_bbl, 0);
      const wc     = latestData.oil + latestData.water > 0
        ? (latestData.water / (latestData.oil + latestData.water)) * 100 : null;

      let trend: "increasing" | "flat" | "declining" | "offline" = "offline";
      if (sortedPeriods.length >= 3) {
        const rec  = last6.slice(-3).reduce((s, v) => s + v, 0) / 3;
        const prev = sortedPeriods.slice(-6, -3).map(([, d]) => d.oil);
        const prevAvg = prev.length ? prev.reduce((s, v) => s + v, 0) / prev.length : 0;
        if (prevAvg > 0) {
          const pct = (rec - prevAvg) / prevAvg;
          trend = pct > 0.05 ? "increasing" : pct < -0.08 ? "declining" : "flat";
        } else { trend = rec > 0 ? "flat" : "offline"; }
      } else if (avg6 > 0) { trend = "flat"; }

      const docLast3  = sortedPeriods.slice(-3).map(([, d]) => d.oil);
      const docAvg3   = docLast3.reduce((s, v) => s + v, 0)  / Math.max(docLast3.length, 1);
      const docLast24 = sortedPeriods.slice(-24).map(([, d]) => d.oil);
      const docAvg24  = docLast24.length >= 6 ? docLast24.reduce((s, v) => s + v, 0) / docLast24.length : null;

      wellRows.push({
        api: providedApis[0] ?? "Unknown",
        well_name: leaseName ?? operatorName ?? "Subject Property (from docs)",
        lease_number: providedLeases[0] ?? null,
        district_code: null,
        operator: operatorName,
        latest_monthly_oil_bbl: dp(latestData.oil, "uploaded_doc", "medium", "Extracted from provided documents"),
        latest_monthly_gas_mcf: latestData.gas > 0
          ? dp(latestData.gas, "uploaded_doc", "medium") : missingDp<number>("Gas not reported in docs"),
        latest_monthly_water_bbl: latestData.water > 0
          ? dp(latestData.water, "uploaded_doc", "medium") : missingDp<number>("Water not reported in docs"),
        latest_production_month: latestPeriod,
        water_cut_pct: wc != null ? dp(wc, "uploaded_doc", "medium") : missingDp<number>(),
        three_month_avg_bbl:      dp(docAvg3, "uploaded_doc", "medium"),
        six_month_avg_bbl:        dp(avg6,    "uploaded_doc", "medium"),
        twelve_month_avg_bbl:     last12.length >= 3 ? dp(avg12, "uploaded_doc", "medium") : missingDp<number>(),
        twenty_four_month_avg_bbl: docAvg24 != null ? dp(docAvg24, "uploaded_doc", "medium") : missingDp<number>(),
        production_trend: dp(trend, "uploaded_doc", "low"),
        cum_oil_bbl: dp(cumOil, "uploaded_doc", "medium"),
        formation: null,
        perforation_depth_ft: missingDp<number>(),
        monthly_history: docMonthlyRows.map(r => ({
          period: `${r.year}-${String(r.month).padStart(2, "0")}`,
          oil_bbl: r.oil_bbl,
          gas_mcf: r.gas_mcf ?? 0,
          water_bbl: r.water_bbl,
        })),
      });
    }
  }

  // Aggregate production — prefer TRRC, fall back to doc data
  const totalOil = trrcWells.length > 0
    ? trrcWells.reduce((s, w) => s + w.latest_monthly_oil_bbl, 0)
    : (docMonthlyRows.length > 0 ? (docMonthlyRows[docMonthlyRows.length - 1]?.oil_bbl ?? 0) : 0);

  const totalGas = trrcWells.length > 0
    ? trrcWells.reduce((s, w) => {
        const r = w.monthly_rows?.[w.monthly_rows.length - 1];
        return s + (r?.gas_mcf ?? 0);
      }, 0)
    : (docMonthlyRows.length > 0 ? (docMonthlyRows[docMonthlyRows.length - 1]?.gas_mcf ?? 0) : 0);

  const totalWater = trrcWells.length > 0
    ? trrcWells.reduce((s, w) => {
        const r = w.monthly_rows?.[w.monthly_rows.length - 1];
        return s + (r?.water_bbl ?? 0);
      }, 0)
    : (docMonthlyRows.length > 0 ? (docMonthlyRows[docMonthlyRows.length - 1]?.water_bbl ?? 0) : 0);

  // Total BOE for LOE/BOE denominator (oil + gas/6)
  const totalBoe = totalOil + totalGas / 6;

  // Water cut — only use rows where water_bbl was actually measured (not null/zero).
  // TRRC rows always have null water_bbl, so waterCutValue falls through to doc extraction.
  const docWaterCut = extracted?.water_cut_pct ?? null;
  const trrcWaterCutRows = wellRows.filter(w =>
    w.water_cut_pct.value != null && w.water_cut_pct.source === "trrc"
  );
  const docWaterCutRows = wellRows.filter(w =>
    w.water_cut_pct.value != null && w.water_cut_pct.source === "uploaded_doc"
  );
  const waterCutValue =
    trrcWaterCutRows.length > 0
      ? trrcWaterCutRows.reduce((s, w) => s + (w.water_cut_pct.value ?? 0), 0) / trrcWaterCutRows.length
      : docWaterCutRows.length > 0
        ? docWaterCutRows.reduce((s, w) => s + (w.water_cut_pct.value ?? 0), 0) / docWaterCutRows.length
        : docWaterCut;
  const waterCutSource: DataSource =
    trrcWaterCutRows.length > 0 ? "trrc"
    : docWaterCutRows.length > 0 || docWaterCut != null ? "uploaded_doc"
    : "missing";

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

  const hasDocProd = docMonthlyRows.length > 0;
  const hasTrrc    = trrcWells.length > 0;
  const hasProd    = hasTrrc || hasDocProd;

  const productionSection: ProductionSection = {
    wells: wellRows,
    total_monthly_oil_bbl: hasTrrc
      ? dp(totalOil, "trrc", "high", "TRRC production aggregate")
      : hasDocProd
        ? dp(totalOil, "uploaded_doc", "medium", "Extracted from provided documents")
        : missingDp<number>("No production data — provide API number, RRC lease, or upload production documents"),
    total_monthly_gas_mcf: hasTrrc && totalGas > 0
      ? dp(totalGas, "trrc", "high", "TRRC production aggregate")
      : hasDocProd && totalGas > 0
        ? dp(totalGas, "uploaded_doc", "medium")
        : missingDp<number>(),
    total_monthly_water_bbl: hasTrrc && totalWater > 0
      ? dp(totalWater, "trrc", "high", "TRRC production aggregate")
      : hasDocProd && totalWater > 0
        ? dp(totalWater, "uploaded_doc", "medium")
        : missingDp<number>("Water volumes unavailable — TRRC does not report water disposition. Request from operator."),
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
    notes: !hasTrrc
      ? hasDocProd
        ? [
            `NOTE: Production data sourced from uploaded documents (${docMonthlyRows.length} months). For TRRC-verified production, provide exact API number and RRC lease number + district.`,
            "RRC oil production is lease-level; this exhibit supports underwriting but is not a formal well-level reserve-engineering decline curve.",
          ]
        : ["WARNING: No production data available. Provide an API number, RRC lease number, or upload production documents (LOE statements, run tickets, etc.)."]
      : [
          `LEASE-LEVEL DATA: RRC oil production is lease-level; this exhibit supports underwriting but is not a formal well-level reserve-engineering decline curve.${trrcWells.length > 0 ? ` Source: TRRC Specific Lease Production Query (${trrcWells.map(w => `Lease ${w.lease_number}, District ${w.district_code}`).join("; ")}).` : ""}`,
          "WATER: TRRC production reports do not include water disposition volumes. Water cut requires operator run tickets or division orders — do not compute from TRRC data alone.",
          "TRRC data may lag current operations by 3–5 months. Verify most-recent production with operator prior to offer.",
        ],
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

  if (avgLoe != null && totalBoe > 0) {
    loePerBoe = avgLoe / totalBoe;
  } else if (financialContext?.edgar?.loe_per_boe != null) {
    // Public company data from SEC EDGAR (company-level, not well-specific)
    loePerBoe      = financialContext.edgar.loe_per_boe;
    avgLoeEffective = totalOil > 0 ? loePerBoe * totalOil : null;
    loeSource       = "uploaded_doc"; // repurpose as external public source
    loeNote         = `SEC EDGAR 10-K (${financialContext.edgar.company_name}, FY${financialContext.edgar.fiscal_year}) — company average, not well-specific`;
  } else if (benchmark != null && totalBoe > 0) {
    // Basin benchmark fallback (EIA regional average)
    loePerBoe      = benchmark.loe_median_per_boe;
    avgLoeEffective = loePerBoe * totalBoe;
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
      ? dp(loePerBoe, loeSource,
          loeSource === "loe_statement"
            ? (loePeriods.length >= 12 ? "high" : "medium")
            : loeSource === "uploaded_doc" ? "medium" : "low",
          loeSource === "loe_statement"
            ? `Computed from ${loePeriods.length}-month avg LOE ÷ TRRC monthly production (BOE)`
            : loeNote)
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

  // Compliance lookup was actually attempted only when we had Texas identifiers to query.
  // (trrcViolations.length >= 0 was always true — that was a logic bug.)
  const trrcComplianceLookupAttempted = isTexasState && (providedApis.length > 0 || (operatorName !== null && county !== null));
  // trrcViolations having data (even 0 records returned) proves the query ran and got a response.
  // An empty array could mean "clean record" or "lookup timed out" — annotate accordingly.
  const complianceSearchedAndReturned = trrcViolations.length > 0;
  const complianceSource: DataSource = complianceSearchedAndReturned ? "trrc"
    : trrcComplianceLookupAttempted ? "inferred"
    : "missing";
  const complianceConfidence: DataConfidence = complianceSearchedAndReturned ? "medium"
    : trrcComplianceLookupAttempted ? "low"
    : "none";

  // ── Map ICE inspection records to InspectionRecord shape ─────────────────
  const mappedInspections: InspectionRecord[] = trrcInspections.map(r => ({
    api:              r.api,
    inspection_date:  r.inspection_date,
    inspection_type:  r.inspection_type,
    result:           r.result as InspectionRecord["result"],
    defect_summary:   r.defect_summary,
    notes:            r.notes,
  }));

  const mostRecentInspection = mappedInspections.length > 0
    ? mappedInspections.slice().sort((a, b) =>
        (b.inspection_date ?? "").localeCompare(a.inspection_date ?? "")
      )[0]
    : null;

  const hasNonCompliantInspection = mappedInspections.some(r => r.result === "non_compliant");

  const complianceSection: ComplianceSection = {
    violations: allViolations,
    inspection_records: mappedInspections,
    most_recent_inspection_date: mostRecentInspection?.inspection_date
      ? dp<string>(mostRecentInspection.inspection_date, "trrc", "high", "TRRC ICE inspection records", undefined, TRRC_URLS.ice)
      : missingDp<string>("No ICE inspection records found in public query — verify at TRRC PDA portal"),
    most_recent_inspection_result: mostRecentInspection
      ? dp<InspectionRecord["result"]>(
          mostRecentInspection.result,
          "trrc",
          mostRecentInspection.result !== "unknown" ? "high" : "low",
          `TRRC ICE inspection records (${TRRC_URLS.ice})`,
          mostRecentInspection.result === "non_compliant"
            ? `Non-compliant inspection on ${mostRecentInspection.inspection_date ?? "unknown date"}${mostRecentInspection.defect_summary ? ` — ${mostRecentInspection.defect_summary}` : ""}`
            : undefined,
        )
      : missingDp<InspectionRecord["result"]>("No ICE inspection records in public query — verify at TRRC EWA"),
    open_violation_count: trrcComplianceLookupAttempted
      ? dp(openViolations.length, complianceSource, complianceConfidence, "TRRC EWA violation search",
          !complianceSearchedAndReturned ? "No violations found in TRRC search — result unconfirmed (could be clean record or network timeout)" : undefined)
      : missingDp<number>("TRRC compliance lookup not attempted — provide API number or operator + county"),
    most_recent_violation_date: (() => {
      if (allViolations.length > 0) {
        const d = [...allViolations].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))[0]?.date;
        return d ? dp<string>(d, "trrc", "medium") : missingDp<string>("Violation date not parsed");
      }
      return missingDp<string>("No violations found");
    })(),
    rrc_good_standing: trrcComplianceLookupAttempted
      ? dp(openViolations.length === 0, complianceSource, complianceConfidence,
          complianceSearchedAndReturned ? "TRRC EWA violation search" : undefined,
          openViolations.length > 0
            ? `${openViolations.length} open violation(s)`
            : !complianceSearchedAndReturned
              ? "TRRC searched — no violations returned (unconfirmed; verify directly at TRRC EWA)"
              : undefined)
      : missingDp<boolean>("TRRC compliance not queried — provide API number to verify"),
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
    notes: [
      ...(mappedInspections.length > 0
        ? [`${mappedInspections.length} ICE inspection record(s) found. Most recent: ${mostRecentInspection?.inspection_date ?? "unknown date"} — ${mostRecentInspection?.result ?? "unknown"}.`]
        : ["ICE inspection records not found in public query. Verify field inspection history at TRRC EWA portal."]),
      ...(hasNonCompliantInspection
        ? [`⚠ Non-compliant inspection detected. Review defect details and confirm resolution with operator.`]
        : []),
    ],
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

  // ── SWD economics estimate ────────────────────────────────────────────────
  // Basin-aware disposal rate: Permian ~$0.60, Eagle Ford/Haynesville ~$0.45, default $0.50/bbl
  const disposalRatePerBbl = benchmark?.basin
    ? (benchmark.basin.toLowerCase().includes("permian") ? 0.60
      : benchmark.basin.toLowerCase().includes("eagle") ? 0.50
      : benchmark.basin.toLowerCase().includes("haynesville") ? 0.45
      : 0.50)
    : 0.50;

  // Conservative utilization: 60% of permitted capacity
  const estimatedDailyInjectionBwpd = totalCapacity * 0.60;
  const estimatedMonthlyDisposalBbl = estimatedDailyInjectionBwpd * 30;

  // Operating cost: ~30% of revenue (electricity, maintenance, chemicals)
  const estimatedMonthlyRevenue = estimatedMonthlyDisposalBbl * disposalRatePerBbl;
  const estimatedMonthlyCost    = estimatedMonthlyRevenue * 0.30;
  const estimatedMonthlyNI      = estimatedMonthlyRevenue - estimatedMonthlyCost;

  const swdEconomicsNotes: string[] = [];
  if (dedupedInjection.length > 0 && totalCapacity > 0) {
    swdEconomicsNotes.push(
      `Estimated at ${estimatedDailyInjectionBwpd.toFixed(0)} BWPD actual injection (60% of permitted ${totalCapacity.toFixed(0)} BWPD capacity).`,
    );
    swdEconomicsNotes.push(
      `Disposal rate of $${disposalRatePerBbl.toFixed(2)}/bbl used — verify against operator's disposal contracts.`,
    );
    swdEconomicsNotes.push(
      "Request actual injection volumes and disposal contracts to confirm SWD economics.",
    );
  }

  const injectionSection: InjectionSection = {
    wells: dedupedInjection,
    total_disposal_capacity_bwpd: totalCapacity > 0
      ? dp(totalCapacity, "trrc", "medium", "Sum of permitted max volumes")
      : missingDp<number>(),
    current_utilization_pct: missingDp<number>("Daily injection volumes not public — request from operator"),
    swd_disposal_revenue_monthly: dedupedInjection.length > 0 && totalCapacity > 0
      ? dp(Math.round(estimatedMonthlyRevenue), "inferred", "low",
          `Est. ${estimatedDailyInjectionBwpd.toFixed(0)} BWPD × $${disposalRatePerBbl.toFixed(2)}/bbl × 30 days`,
          "Inferred — verify with operator disposal contracts")
      : missingDp<number>("No injection wells with permitted capacity found"),
    swd_operating_cost_monthly: dedupedInjection.length > 0 && totalCapacity > 0
      ? dp(Math.round(estimatedMonthlyCost), "inferred", "low",
          "~30% of gross disposal revenue (electricity, maintenance, chemicals)",
          "Basin-average estimate only")
      : missingDp<number>(),
    swd_net_income_monthly: dedupedInjection.length > 0 && totalCapacity > 0
      ? dp(Math.round(estimatedMonthlyNI), "inferred", "low",
          "Gross disposal revenue minus estimated operating costs",
          "Inferred — confirm with LOE statement")
      : missingDp<number>(),
    swd_annual_net_income: dedupedInjection.length > 0 && totalCapacity > 0
      ? dp(Math.round(estimatedMonthlyNI * 12), "inferred", "low",
          "Monthly SWD net income × 12",
          "Inferred estimate only")
      : missingDp<number>(),
    swd_disposal_rate_per_bbl: dedupedInjection.length > 0 ? disposalRatePerBbl : null,
    swd_economics_notes: swdEconomicsNotes,
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

  // ── Production Intelligence Analysis ─────────────────────────────────────
  // Run the stabilization engine before DCA and economics.
  // This classifies each month (active/downtime/restart/flush/incomplete),
  // computes stabilized trailing rates excluding non-representative months,
  // detects restart events, and assigns a production confidence label.

  const trrcMonthlyRows = trrcWells.flatMap(w => w.monthly_rows ?? []);
  const allMonthlyRows  = trrcMonthlyRows.length > 0 ? trrcMonthlyRows : docMonthlyRows;
  const dcaDataSource   = trrcMonthlyRows.length > 0 ? "trrc" : "uploaded_doc";

  let prodIntel: StabilizedProductionProfile | null = null;
  if (allMonthlyRows.length >= 3) {
    prodIntel = analyzeProductionIntelligence(allMonthlyRows);
  }

  // Surface production intelligence warnings in the production section notes
  if (prodIntel?.warnings?.length) {
    productionSection.notes.push(...prodIntel.warnings);
  }

  // ── Production Audit ──────────────────────────────────────────────────────
  // Captures raw TRRC rows, identity resolution, and classification so every
  // divergence from run-statement values can be traced to its exact source.

  const auditNotes: string[] = [];

  // Determine raw rows and their source
  const auditRawRows = trrcMonthlyRows.length > 0
    ? trrcMonthlyRows.map(r => ({
        period: `${r.year}-${String(r.month).padStart(2, "0")}`,
        oil_bbl: r.oil_bbl,
        gas_mcf: r.gas_mcf ?? null,
        source: "trrc_actual" as const,
      }))
    : docMonthlyRows.map(r => ({
        period: `${r.year}-${String(r.month).padStart(2, "0")}`,
        oil_bbl: r.oil_bbl,
        gas_mcf: r.gas_mcf ?? null,
        source: "doc_extracted" as const,
      }));

  auditRawRows.sort((a, b) => a.period.localeCompare(b.period));

  const auditDateRange = auditRawRows.length > 0
    ? `${auditRawRows[0].period} → ${auditRawRows[auditRawRows.length - 1].period}`
    : null;

  // Build classified rows from prodIntel output
  const auditClassifiedRows = prodIntel
    ? prodIntel.classified_months.map(cm => ({
        period: cm.period,
        oil_bbl: cm.oil_bbl,
        gas_mcf: cm.gas_mcf,
        classification: cm.classification,
        classification_note: cm.classification_note,
        used_in_stabilized_avg: cm.classification === "active",
        used_in_dca: cm.classification === "active" || cm.classification === "flush",
      }))
    : auditRawRows.map(r => ({
        period: r.period,
        oil_bbl: r.oil_bbl,
        gas_mcf: r.gas_mcf,
        classification: "active" as const,
        classification_note: null,
        used_in_stabilized_avg: true,
        used_in_dca: true,
      }));

  // Resolution steps from subject identity
  const auditResolutionSteps = [...subject.match_path];
  if (trrcMonthlyRows.length === 0 && docMonthlyRows.length === 0) {
    auditResolutionSteps.push("⚠️ No production rows returned from any source");
  } else if (trrcMonthlyRows.length > 0) {
    auditResolutionSteps.push(
      `TRRC raw rows: ${trrcMonthlyRows.length} month(s) returned before classification`
    );
  }

  // Audit notes
  if (trrcWells.length > 0) {
    const leaseStr = trrcWells
      .map(w => `Dist ${w.district_code ?? "?"}:Lease ${w.lease_number ?? "?"}`)
      .join(", ");
    auditNotes.push(
      `Production is LEASE-LEVEL from TRRC (${leaseStr}). ` +
      "If multiple wells share this lease, TRRC reports their combined output — not per-well. " +
      "Run statements from the purchaser allocate royalties on a per-well basis, which may not match the TRRC lease aggregate."
    );
  }
  if (trrcMonthlyRows.length > 0 && docMonthlyRows.length === 0) {
    const gasRows = trrcMonthlyRows.filter(r => (r.gas_mcf ?? 0) > 0);
    if (gasRows.length > 0 && trrcMonthlyRows.filter(r => r.oil_bbl > 0).length === 0) {
      auditNotes.push(
        "⚠️ TRRC returned gas-only production. oil_bbl values shown are gas-converted to BOE (÷6). " +
        "Run-statement values in BBL reflect liquid condensate volumes which may differ significantly."
      );
    }
  }
  if (prodIntel && prodIntel.incomplete_months_excluded > 0) {
    auditNotes.push(
      `${prodIntel.incomplete_months_excluded} month(s) classified as INCOMPLETE (within TRRC 3-month lag window ` +
      "and below 55% of prior trend) were excluded from stabilized averages. " +
      "If these months have confirmed run statement values, the incomplete threshold may be too aggressive."
    );
  }
  if (prodIntel && prodIntel.restart_event_count > 0) {
    auditNotes.push(
      `${prodIntel.restart_event_count} restart event(s) detected. ` +
      `${RESTART_TRANSITION_MONTHS_AUDIT} post-restart transition month(s) per event are excluded from stabilized averages.`
    );
  }

  const resolvedLeases = trrcWells
    .map(w => [w.district_code, w.lease_number].filter(Boolean).join(":"))
    .filter(Boolean);
  const trrcDistricts = Array.from(new Set(trrcWells.map(w => w.district_code).filter((d): d is string => !!d)));

  const productionAudit: ProductionAudit = {
    input_apis: input.api_numbers ?? [],
    resolved_apis: subject.normalized_apis.map(n => n.api_formatted),
    resolved_leases: resolvedLeases,
    trrc_districts: trrcDistricts,
    resolution_steps: auditResolutionSteps,
    trrc_production_url: trrcMonthlyRows.length > 0 ? TRRC_URLS.production : null,
    raw_rows: auditRawRows,
    raw_row_count: auditRawRows.length,
    raw_date_range: auditDateRange,
    classified_rows: auditClassifiedRows,
    months_active:     auditClassifiedRows.filter(r => r.classification === "active").length,
    months_downtime:   auditClassifiedRows.filter(r => r.classification === "downtime").length,
    months_restart:    auditClassifiedRows.filter(r => r.classification === "restart").length,
    months_flush:      auditClassifiedRows.filter(r => r.classification === "flush").length,
    months_incomplete: auditClassifiedRows.filter(r => r.classification === "incomplete").length,
    stabilized_rate_bbl: prodIntel?.current_stabilized_bbl ?? null,
    stabilized_rate_basis: prodIntel?.current_stabilized_source ?? "raw last month",
    dca_input_row_count: (prodIntel?.dca_rows ?? []).length,
    notes: auditNotes,
  };

  // ── Stabilized rate for economics & DCA ──────────────────────────────────
  // Use the stabilized current rate (not raw last month) for all economic inputs.
  // Fall back to the raw totals if the production engine is not available.
  const stabilizedOil = prodIntel?.current_stabilized_bbl ?? totalOil;
  const stabilizedNote = prodIntel?.current_stabilized_source
    ? `Stabilized from production-engine: ${prodIntel.current_stabilized_source}`
    : "Raw TRRC total";

  // Downtime haircut for projected cash flows
  const downtimeHaircut = prodIntel != null ? prodIntel.downtime_pct / 100 : 0;

  // ── Decline Curve Analysis ────────────────────────────────────────────────
  // Use DCA-ready rows from production engine (calendar time indexed, active+flush only).
  // Falls back to raw rows if production engine unavailable.
  const dcaInputRows = prodIntel?.dca_rows ?? allMonthlyRows;
  const dcaResult = dcaInputRows.length >= 3 ? runDca(dcaInputRows) : null;

  const dcaSource = dcaDataSource as DataSource;
  const dcaSection: DcaSection = {
    model_type: dcaResult
      ? dp(dcaResult.model.type, dcaSource, "medium",
          `Arps DCA fit to ${dcaSource === "trrc" ? "TRRC" : "document"} production history`)
      : missingDp<"exponential"|"hyperbolic"|"harmonic">("Insufficient production history for DCA (need 3+ months)"),
    decline_rate_monthly_pct: dcaResult
      ? dp(dcaResult.decline_rate_monthly_pct, dcaSource, dcaResult.months_of_data >= 12 ? "high" : "medium",
          `${dcaResult.months_of_data} months of data, R²=${dcaResult.model.r_squared.toFixed(2)}`)
      : (declineRate != null
          ? dp(Math.abs(declineRate), dcaSource, "low", "Simple 6/12-month average — insufficient data for Arps fit")
          : missingDp<number>("No production data for decline analysis")),
    decline_rate_annual_pct: dcaResult
      ? dp(dcaResult.decline_rate_annual_pct, dcaSource, "medium")
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
    current_rate_bbl: (() => {
      if (prodIntel?.current_stabilized_bbl != null) {
        return dp(prodIntel.current_stabilized_bbl, dcaSource as DataSource,
          prodIntel.production_confidence === "VERIFIED" ? "high" : "medium",
          stabilizedNote);
      }
      if (dcaResult) {
        return dp(dcaResult.current_bbl, dcaSource as DataSource,
          dcaSource === "trrc" ? "medium" : "low",
          `Raw last-month TRRC production (stabilization unavailable)`);
      }
      return totalOil > 0
        ? dp(totalOil, dcaSource as DataSource, "low")
        : missingDp<number>();
    })(),
    peak_rate_bbl: dcaResult
      ? dp(dcaResult.peak_bbl, dcaSource as DataSource, "medium")
      : missingDp<number>(),
    cum_oil_bbl: dcaResult
      ? dp(dcaResult.cum_oil_bbl, dcaSource as DataSource, dcaSource === "trrc" ? "high" : "medium",
          `Total ${dcaSource === "trrc" ? "TRRC-reported" : "document-derived"} cumulative production`)
      : (hasTrrc ? dp(trrcWells.reduce((s, w) => s + w.cum_oil_bbl, 0), "trrc", "high")
          : hasDocProd ? dp(docMonthlyRows.reduce((s, r) => s + r.oil_bbl, 0), "uploaded_doc", "medium")
          : missingDp<number>()),
    projections: dcaResult?.projections ?? [],
    notes: (() => {
      const notes: string[] = [];
      // ── Decline-support disclaimer (spec-required) ─────────────────────────
      // Must always appear first. This prevents buyers from treating underwriting
      // exhibit output as a certified reserve-engineering study.
      notes.push(
        "DECLINE-SUPPORT EXHIBIT ONLY — This is not a formal reserve-engineering study, " +
        "certified decline-curve analysis, or reserve report. " +
        (dcaDataSource === "trrc"
          ? "Source: TRRC lease-level production data. Individual wellbore allocation is not available from TRRC."
          : "Source: document-extracted production data (not independently TRRC-verified).")
      );
      if (dcaResult) {
        const r2 = dcaResult.model.r_squared;
        notes.push(
          `${dcaResult.model.type.charAt(0).toUpperCase() + dcaResult.model.type.slice(1)} Arps model · R²=${r2.toFixed(2)} · b=${dcaResult.model.b.toFixed(2)} · Di=${(dcaResult.model.Di * 100).toFixed(2)}%/mo nominal`
        );
        if (prodIntel) {
          notes.push(
            `Production quality: ${prodIntel.production_confidence} · ` +
            `${prodIntel.active_months} active months · ` +
            `${prodIntel.downtime_pct.toFixed(1)}% downtime · ` +
            `${prodIntel.restart_event_count} restart event(s)`
          );
          if (prodIntel.incomplete_months_excluded > 0) {
            notes.push(`${prodIntel.incomplete_months_excluded} potentially-incomplete month(s) excluded from DCA fit`);
          }
          if (prodIntel.restart_detected && prodIntel.pre_restart_rate_bbl && prodIntel.post_restart_stable_rate_bbl) {
            notes.push(
              `Restart detected: pre=${prodIntel.pre_restart_rate_bbl} BBL/mo → post=${prodIntel.post_restart_stable_rate_bbl} BBL/mo ` +
              `(${prodIntel.restart_recovery_pct ?? "?"}% recovery). DCA anchored to post-restart trend.`
            );
          }
          if (r2 < 0.75) {
            notes.push(`⚠️ Low R² (${r2.toFixed(2)}) — decline curve fit quality is poor. EUR estimate has high uncertainty.`);
          }
        }
        if (dcaSource === "uploaded_doc") {
          notes.push("⚠️ DCA based on document-extracted production — provide API number for TRRC-verified curve.");
        }
      } else {
        notes.push("Decline curve analysis requires ≥ 3 months of production history. Provide API number or upload production documents.");
      }
      return notes;
    })(),
  };

  // ── Acquisition Economics ─────────────────────────────────────────────────

  // NRI/WI: user override → doc extraction → default
  const nriDecimal = nriOverride
    ?? ownershipRecords.find(r => r.nri_decimal != null)?.nri_decimal
    ?? 0.75;
  const wiDecimal  = wiOverride
    ?? ownershipRecords.find(r =>
        r.interest_type.toLowerCase().includes("wi") || r.interest_type.toLowerCase().includes("working")
       )?.decimal_interest
    ?? 1.0;

  // Texas severance tax rates (applied to gross revenue, WI-share basis)
  // Oil production tax: 4.6% | Gas production tax: 7.5%
  const sevTaxOil = isTexasState ? 0.046 : 0;
  const sevTaxGas = isTexasState ? 0.075 : 0;

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

  // Use stabilized production rate (not raw last-month) as the economics input.
  // This is the single most important correctness improvement: economics must reflect
  // the well's actual operating rate, not a noisy single-month or downtime-averaged rate.
  const econOil = stabilizedOil > 0 ? stabilizedOil : totalOil;
  const econGas = totalGas; // gas production — stabilize if available

  const econResult = (econOil > 0 || econGas > 0 || monthlyLoe > 0)
    ? runEconomics({
        monthly_oil_bbl:           econOil,
        monthly_gas_mcf:           econGas,
        monthly_loe_usd:           monthlyLoe,
        nri_decimal:               nriDecimal,
        wi_decimal:                wiDecimal,
        decline_rate_monthly:      dcaMonthlyDecline,
        b_factor:                  bFactor,
        eur_bbl:                   dcaResult?.eur_bbl ?? 0,
        remaining_reserves_bbl:    dcaResult?.remaining_reserves_bbl ?? 0,
        cum_production_bbl:        dcaResult?.cum_oil_bbl ?? (prodIntel?.cumulative_oil_bbl ?? 0),
        price_decks:               customDecks,
        state_tax_pct_oil:         sevTaxOil,
        state_tax_pct_gas:         sevTaxGas,
        // Ad valorem: ~1.2% of gross revenue (Texas county average)
        ad_valorem_pct:            isTexasState ? 0.012 : 0.008,
        // Transport: basin-specific, default $0.50/BBL
        transport_oil_per_bbl:     benchmark?.oil_differential_per_bbl != null
                                     ? Math.abs(benchmark.oil_differential_per_bbl) * 0.20  // ~20% of price diff
                                     : 0.50,
        transport_gas_per_mcf:     0.10,
        // Workover reserve: $2/BOE/year for conventional wells
        workover_reserve_per_boe_annual: 2.00,
        // Downtime haircut: apply the historical downtime percentage
        downtime_haircut:          downtimeHaircut,
      })
    : null;

  const econNriSource: DataSource = ownershipRecords.some(r => r.nri_decimal != null) ? "uploaded_doc" : "inferred";
  const econWiSource: DataSource  = ownershipRecords.some(r => r.interest_type.toLowerCase().includes("wi")) ? "uploaded_doc" : "inferred";

  // Build economics quality note
  const econQualityNote = (() => {
    const parts: string[] = [];
    if (prodIntel) {
      parts.push(`${prodIntel.production_confidence} production (${prodIntel.active_months} active months)`);
      if (downtimeHaircut > 0) parts.push(`${(downtimeHaircut * 100).toFixed(0)}% downtime haircut applied to projections`);
      if (stabilizedOil !== totalOil) parts.push(`stabilized rate ${stabilizedOil} BBL/mo used (not raw total ${totalOil} BBL/mo)`);
    }
    if (monthlyLoe > 0) parts.push(`LOE from ${loePeriods.length > 0 ? loePeriods.length + " months of statements" : "EDGAR/benchmark"}`);
    return parts.length > 0 ? parts.join(" · ") : "Base price deck, Arps decline";
  })();

  const acquisitionEconomicsSection: AcquisitionEconomicsSection = {
    nri_decimal: dp(nriDecimal, econNriSource, econNriSource === "uploaded_doc" ? "high" : "low",
      econNriSource === "inferred" ? "Assumed 75% NRI — provide division orders to confirm" : undefined),
    wi_decimal:  dp(wiDecimal,  econWiSource,  econWiSource  === "uploaded_doc" ? "high" : "low",
      econWiSource  === "inferred" ? "Assumed 100% WI — provide JOA to confirm" : undefined),
    monthly_net_income_usd: econResult
      ? dp(econResult.monthly_net_income_usd, econOil > 0 ? "trrc" : "loe_statement",
          prodIntel?.production_confidence === "VERIFIED" ? "medium" : "low",
          econQualityNote)
      : missingDp<number>("Requires production and LOE data"),
    annual_net_income_usd: econResult
      ? dp(econResult.annual_net_income_usd, "inferred", "medium")
      : missingDp<number>(),
    npv10_usd: econResult
      ? dp(econResult.npv10_base_usd, "inferred",
          dcaResult?.model.r_squared != null && dcaResult.model.r_squared > 0.8 ? "medium" : "low",
          "10% discount, base price deck, Arps decline, downtime-adjusted. Unaudited — not an engineered reserve report.")
      : missingDp<number>(),
    offer_range_low:  econResult ? dp(econResult.offer_range_low,  "inferred", "low", "Low: 2.5–3.5× stabilized annual NCF") : missingDp<number>(),
    offer_range_mid:  econResult ? dp(econResult.offer_range_mid,  "inferred", "low", "Mid: 4–5× annual NCF or 75–80% NPV10") : missingDp<number>(),
    offer_range_high: econResult ? dp(econResult.offer_range_high, "inferred", "low", "High: 5.5–7× annual NCF or 80–85% NPV10") : missingDp<number>(),
    breakeven_oil_price: econResult
      ? dp(econResult.breakeven_oil_price, "inferred", "medium", "Oil price at which net income = 0 (incl. transport, ad val, workover reserve)")
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
          monthly_severance_tax:   s.monthly_severance_tax_usd,
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
    // ── Sensitivity matrix (4×4 production × price, using stabilized rate) ──
    sensitivity_matrix: (econOil > 0 || econGas > 0)
      ? buildSensitivityMatrix(
          {
            monthly_oil_bbl:        econOil,
            monthly_gas_mcf:        econGas,
            monthly_loe_usd:        monthlyLoe,
            nri_decimal:            nriDecimal,
            wi_decimal:             wiDecimal,
            decline_rate_monthly:   dcaMonthlyDecline,
            b_factor:               bFactor,
            eur_bbl:                dcaResult?.eur_bbl ?? 0,
            remaining_reserves_bbl: dcaResult?.remaining_reserves_bbl ?? 0,
            cum_production_bbl:     dcaResult?.cum_oil_bbl ?? (prodIntel?.cumulative_oil_bbl ?? 0),
            price_decks:            customDecks,
            state_tax_pct_oil:      sevTaxOil,
            state_tax_pct_gas:      sevTaxGas,
            ad_valorem_pct:         isTexasState ? 0.012 : 0.008,
            transport_oil_per_bbl:  0.50,
            workover_reserve_per_boe_annual: 2.00,
            downtime_haircut:       downtimeHaircut,
          },
          [50, 75, 100, 125],
          customDecks,
        )
      : undefined,
    // ── Monthly cash flow schedule — 24 months, base deck, downtime-adjusted ─
    monthly_cash_flow_schedule: (() => {
      const baseScenario = econResult?.scenarios.find(s => s.deck.label === "Base");
      const cfs = baseScenario?.monthly_cash_flows;
      if (!cfs || cfs.length === 0) return undefined;
      const declineRateForSchedule = dcaMonthlyDecline;
      let cumNI = 0;
      const netOilPriceForSched = (baseDeckOil + diff);
      return cfs.slice(0, 24).map((cf, i): MonthlyCashFlowRow => {
        cumNI += cf;
        let qOil: number;
        if (bFactor <= 0.001) {
          qOil = econOil * Math.exp(-declineRateForSchedule * i);
        } else {
          qOil = econOil / Math.pow(1 + bFactor * declineRateForSchedule * i, 1 / bFactor);
        }
        const grossRev = qOil * netOilPriceForSched + (econGas > 0
          ? econGas * Math.exp(-declineRateForSchedule * i) * baseDeckGas
          : 0);
        return {
          month: i + 1,
          rate_bbl: Math.max(0, Math.round(qOil)),
          gross_revenue: Math.max(0, Math.round(grossRev)),
          net_income: cf,
          cumulative_net_income: Math.round(cumNI),
        };
      });
    })(),
    notes: econResult
      ? [
          `NRI: ${(nriDecimal * 100).toFixed(2)}% · WI: ${(wiDecimal * 100).toFixed(0)}% · ` +
          `Production basis: ${stabilizedOil} BBL/mo stabilized${downtimeHaircut > 0 ? ` (${(downtimeHaircut * 100).toFixed(0)}% downtime haircut)` : ""}`,
          "Cost stack (base deck, $/BOE): " + [
            monthlyLoe > 0 ? `LOE $${econResult.loe_per_boe.toFixed(2)}/BOE` : "LOE: provide statements",
            `transport ~$0.50/BBL`,
            isTexasState ? "sev tax 4.6% oil / 7.5% gas" : "",
            isTexasState ? "ad val ~1.2% revenue" : "",
            `workover reserve $2/BOE/yr`,
            `all-in $${econResult.total_cost_per_boe.toFixed(2)}/BOE`,
          ].filter(Boolean).join(" · "),
          ...(econResult.monthly_transport_usd > 0 || econResult.monthly_ad_valorem_usd > 0 ? [
            `Monthly cost breakdown: LOE $${Math.round(monthlyLoe * wiDecimal).toLocaleString()} · ` +
            `Transport $${econResult.monthly_transport_usd.toLocaleString()} · ` +
            `Ad val $${econResult.monthly_ad_valorem_usd.toLocaleString()} · ` +
            `Workover reserve $${econResult.monthly_workover_reserve_usd.toLocaleString()}`,
          ] : []),
          "Offer ranges calibrated to PE-backed WI acquisition multiples. All economics preliminary — not a substitute for a certified petroleum engineer reserve report.",
        ]
      : ["Economics unavailable — provide API numbers for TRRC production lookup and upload LOE statements for cost data."],
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

  // ── Downtime Analysis ─────────────────────────────────────────────────────

  const violationDatesForDowntime = allViolations
    .map(v => v.date)
    .filter((d): d is string => typeof d === "string");

  const downtimeResult = analyzeDowntime(allMonthlyRows, violationDatesForDowntime);

  // ── Downtime / Inspection cross-reference ────────────────────────────────
  //
  // The spec requires: "Flag any inspection occurring during or shortly before
  // zero-production or no-report months. Do not assume causation unless the source
  // explicitly states the reason for downtime. Use language: 'Public inspection record
  // may be relevant to downtime; operator confirmation required.'"
  //
  // We look ±90 days around each downtime period start for inspection records.
  const downtimeInspectionNotes: string[] = [];
  if (downtimeResult.periods.length > 0 && mappedInspections.length > 0) {
    for (const period of downtimeResult.periods) {
      // Convert YYYY-MM period strings to approximate Date objects
      const dtStart = new Date(period.start_period + "-01");
      const dtEnd   = new Date((period.end_period ?? period.start_period) + "-28");

      const nearbyInspections = mappedInspections.filter(ins => {
        if (!ins.inspection_date) return false;
        const insDate = new Date(ins.inspection_date);
        const windowStart = new Date(dtStart);
        windowStart.setDate(windowStart.getDate() - 90);
        const windowEnd   = new Date(dtEnd);
        windowEnd.setDate(windowEnd.getDate() + 30);
        return insDate >= windowStart && insDate <= windowEnd;
      });

      for (const ins of nearbyInspections) {
        const resultLabel = ins.result === "non_compliant" ? "NON-COMPLIANT" : ins.result === "compliant" ? "compliant" : "result unknown";
        const defect = ins.defect_summary ? ` (${ins.defect_summary})` : "";
        downtimeInspectionNotes.push(
          `Public inspection record may be relevant to downtime: ICE inspection on ${ins.inspection_date ?? "unknown date"} — ${resultLabel}${defect}` +
          ` near zero-production period ${period.start_period}–${period.end_period ?? period.start_period}.` +
          ` Operator confirmation required. Do not infer causation from this correlation alone.` +
          ` Source: TRRC ICE (${TRRC_URLS.ice})`
        );
      }
    }
  }

  const downtimeSection: DowntimeSection = {
    total_zero_months:   dp(downtimeResult.total_zero_months,   dcaSource, downtimeResult.total_months_analyzed > 0 ? "high" : "none", undefined, undefined, TRRC_URLS.production),
    total_months_analyzed: downtimeResult.total_months_analyzed,
    downtime_pct:        dp(downtimeResult.downtime_pct,        dcaSource, "medium", undefined, undefined, TRRC_URLS.production),
    periods:             downtimeResult.periods,
    normalized_rate_bbl: downtimeResult.normalized_rate_bbl != null
      ? dp(downtimeResult.normalized_rate_bbl, dcaSource, "medium", "Median of non-zero monthly production")
      : missingDp<number>("No positive production months"),
    volatility_score:    dp(downtimeResult.volatility_score,   "inferred", "medium", "Coefficient of variation × 10, capped at 10"),
    longest_downtime_months: dp(downtimeResult.longest_downtime_months, dcaSource, "medium"),
    current_offline:     dp(downtimeResult.current_offline,    dcaSource, downtimeResult.total_months_analyzed > 0 ? "high" : "none"),
    production_consistency: dp(downtimeResult.production_consistency, "inferred", "medium"),
    underwriting_notes: [
      ...downtimeResult.underwriting_notes,
      ...downtimeInspectionNotes,
      // If there are unexplained downtime periods, always add seller request note
      ...(downtimeResult.periods.length > 0 && downtimeInspectionNotes.length === 0
        ? [`${downtimeResult.periods.length} zero-production period(s) identified. Cause not determinable from TRRC public records alone. Request downtime explanation and workover records from seller/operator.`]
        : []),
    ],
  };

  // ── Buyer Q&A ─────────────────────────────────────────────────────────────

  const loeSourceTag: "loe_statement" | "edgar" | "benchmark" | "none" =
    loePeriods.length > 0 ? "loe_statement"
    : financialContext?.edgar != null ? "edgar"
    : benchmark != null ? "benchmark"
    : "none";

  const buyerQAItems = buildBuyerQA({
    match_tier:           matchTier,
    operator_name:        operatorName,
    run_tickets_present:  extracted?.run_tickets_present ?? false,
    trrc_matched:         trrcWells.length > 0,
    downtime:             downtimeResult,
    dca:                  dcaResult,
    production_trend:     wellRows[0]?.production_trend?.value ?? null,
    water_cut_pct:        waterCutValue,
    monthly_oil_bbl:      totalOil,
    monthly_gas_mcf:      totalGas,
    current_offline:      downtimeResult.current_offline,
    open_violations:      openViolations.length,
    total_violations:     allViolations.length,
    has_bond:             extracted?.bond_amount_usd != null,
    loe_per_boe:          loePerBoe,
    avg_monthly_loe_usd:  avgLoeEffective ?? null,
    loe_months_available: loePeriods.length,
    loe_source:           loeSourceTag,
    benchmark_loe_per_boe: benchmark?.loe_median_per_boe ?? null,
    monthly_net_income_usd: econResult?.monthly_net_income_usd ?? null,
    breakeven_oil_price:  econResult?.breakeven_oil_price ?? null,
    workover_count:       workoverEvents.length,
    last_workover_date:   lastWorkoverDate,
    has_abandonment_risk: downtimeResult.periods.some(p => p.classification === "abandonment_risk"),
  });

  const buyerQASection: BuyerQASection = { items: buyerQAItems };

  // ── Formation & Completion Section ────────────────────────────────────────
  //
  // Data priority:
  //   1. Uploaded document extraction (W-1, W-2, completion report) — highest confidence
  //   2. TRRC completions query (online packet if found)             — trrc source
  //   3. Missing — flag for document request                         — seller/operator
  //

  const completionData = extracted?.completion_data ?? null;

  // Build a lookup of TRRC completion data by API for fast access
  const trrcCompletionByApi = new Map<string, TrrcCompletionRecord>();
  for (const c of trrcCompletions) {
    trrcCompletionByApi.set(c.api, c);
  }
  // Also index by 8-digit form for matching
  for (const c of trrcCompletions) {
    const api8 = c.api.startsWith("42") ? c.api.slice(2) : c.api;
    trrcCompletionByApi.set(api8, c);
  }

  const wellCompletions: WellCompletionData[] = [];

  // Build one WellCompletionData entry per TRRC well, enriched by doc extraction
  const wellsForCompletion = trrcWells.length > 0 ? trrcWells : wellRows;

  for (const w of wellsForCompletion.slice(0, 5)) {
    const api    = "api" in w ? w.api : (providedApis[0] ?? "Unknown");
    const wName  = "well_name" in w ? (w as { well_name: string }).well_name : null;
    const trrcComp = trrcCompletionByApi.get(api) ??
      trrcCompletionByApi.get(api.startsWith("42") ? api.slice(2) : api) ??
      (trrcCompletions.length > 0 ? trrcCompletions[0] : null);

    // Formation: doc > TRRC completion > missing
    const formationValue = completionData?.formation_name ?? trrcComp?.formation ?? null;
    const formationSource: DataSource = completionData?.formation_name ? "uploaded_doc"
      : trrcComp?.formation ? "trrc"
      : "missing";
    const formationNote = !formationValue
      ? "Not found in uploaded docs or TRRC completions query — request W-2 or formation report from seller/operator"
      : trrcComp?.formation && !completionData?.formation_name
        ? "From TRRC completions query — confirm with W-2 or completion report"
        : undefined;

    // Completion date: doc > TRRC
    const compDateValue = completionData?.completion_date ?? trrcComp?.completion_date ?? null;
    const compDateSource: DataSource = completionData?.completion_date ? "uploaded_doc"
      : trrcComp?.completion_date ? "trrc"
      : "missing";

    // Total depth: doc > TRRC
    const depthValue = completionData?.total_depth_ft ?? trrcComp?.total_depth_ft ?? null;
    const depthSource: DataSource = completionData?.total_depth_ft ? "uploaded_doc"
      : trrcComp?.total_depth_ft ? "trrc"
      : "missing";

    // Lift type: doc > TRRC
    const liftValue = completionData?.artificial_lift_type ?? trrcComp?.lift_type ?? null;
    const liftSource: DataSource = completionData?.artificial_lift_type ? "uploaded_doc"
      : trrcComp?.lift_type ? "trrc"
      : "missing";

    const hasAnyCompletionData = !!(formationValue || compDateValue || depthValue || liftValue);

    wellCompletions.push({
      api,
      well_name: wName,
      formation_name: formationValue
        ? dp(formationValue, formationSource, formationSource === "trrc" ? "medium" : "high",
            formationSource === "trrc" ? "TRRC completions query" : "Extracted from completion/W-1 documents",
            formationNote)
        : missingDp<string>(formationNote ?? "Not found in captured public records; request seller/operator or RRC imaged records"),
      total_depth_ft: depthValue
        ? dp(depthValue, depthSource, depthSource === "trrc" ? "medium" : "high",
            depthSource === "trrc" ? "TRRC completions query" : undefined)
        : missingDp<number>("Not found in captured public records; request seller/operator or RRC imaged records"),
      completion_type: completionData?.completion_type
        ? dp(completionData.completion_type, "uploaded_doc", "high")
        : missingDp<"vertical"|"horizontal"|"deviated">("Not found in captured public records; request W-2 or completion report"),
      completion_date: compDateValue
        ? dp(compDateValue, compDateSource, compDateSource === "trrc" ? "medium" : "high",
            compDateSource === "trrc" ? "TRRC completions query" : undefined)
        : missingDp<string>("Not found in captured public records; request W-2 or completion report"),
      artificial_lift_type: liftValue
        ? dp(liftValue, liftSource, liftSource === "trrc" ? "medium" : "high",
            liftSource === "trrc" ? "TRRC completions query" : "From completion or workover records")
        : missingDp<string>("Not found in captured public records; request operator field data"),
      producing_zone: completionData?.producing_zone
        ? dp(completionData.producing_zone, "uploaded_doc", "high")
        : missingDp<string>("Not found in captured public records; request W-2 or completion report"),
      injection_zone: completionData?.injection_zone
        ? dp(completionData.injection_zone, "uploaded_doc", "high")
        : missingDp<string>("Not a disposal/injection well or data not provided"),
      perforations: completionData?.perforations ?? [],
      casing:       completionData?.casing ?? [],
      tubing:       completionData?.tubing ?? [],
      notes: hasAnyCompletionData
        ? (trrcComp?.packet_found === false ? ["TRRC online completion packet not found — some fields from text extraction only; request full W-2 from seller/operator or RRC imaged records."] : [])
        : ["No completion data found in uploaded documents or TRRC completions query. Request W-1 (Drilling Permit), W-2 (Completion Report), or completion packet from seller/operator or RRC imaged records."],
    });

    // Only need one completion record if it's the same data
    if (completionData) break;
  }

  // Primary formation summary — doc first, TRRC second
  const primaryFormation = completionData?.formation_name
    ?? trrcCompletions.find(c => c.formation)?.formation
    ?? null;
  const primaryFormationSource: DataSource = completionData?.formation_name ? "uploaded_doc"
    : primaryFormation ? "trrc"
    : "missing";

  const minDepth = completionData?.total_depth_ft
    ?? trrcCompletions.find(c => c.total_depth_ft)?.total_depth_ft
    ?? null;

  const liftTypes = Array.from(new Set(wellCompletions
    .map(w => w.artificial_lift_type.value)
    .filter((v): v is string => v != null)));

  const anyTrrcPacketFound = trrcCompletions.some(c => c.packet_found);
  const noCompletionData = !completionData && !anyTrrcPacketFound;

  const formationCompletionSection: FormationCompletionSection = {
    wells: wellCompletions,
    primary_formation: primaryFormation
      ? dp(primaryFormation, primaryFormationSource,
          primaryFormationSource === "trrc" ? "medium" : "high",
          primaryFormationSource === "trrc" ? "TRRC completions query" : "Extracted from uploaded documents")
      : missingDp<string>("Not found in captured public records; request W-2 or completion report from seller/operator"),
    depth_range: minDepth != null
      ? `${minDepth.toLocaleString()} ft TD`
      : null,
    lift_types_present: liftTypes,
    notes: noCompletionData
      ? ["No completion data found in uploaded documents or TRRC online completions query. Completion interval, spud date, completion date, formation reports, and workover records flagged as document gaps — request seller/operator or RRC imaged records (W-1, W-2, completion packet)."]
      : (anyTrrcPacketFound && !completionData)
        ? ["Formation and completion data sourced from TRRC online completions query. Confirm with W-2 or completion report for full perforation and casing details."]
        : [],
  };

  if (noCompletionData) {
    missingItems.push({
      section: "Formation & Completion",
      field: "Completion Data",
      importance: "important",
      note: "Not found in captured public records; request seller/operator or RRC imaged records",
    });
  }

  // ── Operator Profile Section ───────────────────────────────────────────────

  const opComplianceStatus = openViolations.length > 0 ? "open_violations"
    : allViolations.length > 5 ? "minor_history"
    : allViolations.length > 0 ? "minor_history"
    : trrcWells.length > 0 ? "clean"
    : "unknown";

  const opPublicCompany = financialContext?.edgar != null;

  let opAssessment: string;
  if (opComplianceStatus === "open_violations") {
    opAssessment = `${operatorName ?? "Operator"} has open TRRC violations — transfer of operatorship may be blocked. Resolve before LOI.`;
  } else if (opComplianceStatus === "minor_history" && !opPublicCompany) {
    opAssessment = `${operatorName ?? "Operator"} has a history of TRRC violations (all closed). Monitor for compliance patterns.`;
  } else if (opPublicCompany) {
    opAssessment = `${financialContext?.edgar?.company_name ?? operatorName ?? "Operator"} is a publicly traded company. SEC filings provide additional financial transparency. LOE benchmark: $${financialContext?.edgar?.loe_per_boe?.toFixed(2) ?? "?"}/BOE (company average).`;
  } else if (opComplianceStatus === "clean") {
    opAssessment = `${operatorName ?? "Operator"} has a clean TRRC compliance record with no violations on file.`;
  } else {
    opAssessment = `Operator identity not confirmed via TRRC match. Provide API number or RRC lease number to verify operator standing.`;
  }

  const operatorProfileSection: OperatorProfileSection = {
    name: operatorName
      ? dp(operatorName, trrcWells.length > 0 ? "trrc" : "uploaded_doc", trrcWells.length > 0 ? "high" : "medium",
          trrcWells.length > 0 ? `TRRC wellbore query (${TRRC_URLS.wellbore})` : "User-provided or document-extracted")
      : missingDp<string>("Operator name not provided — enter operator name or API number to enable TRRC compliance lookup"),
    compliance_status: dp(
      opComplianceStatus as "clean"|"minor_history"|"open_violations"|"unknown",
      trrcWells.length > 0 ? "trrc" : "missing",
      trrcWells.length > 0 ? "medium" : "none",
      `TRRC EWA violation search (${TRRC_URLS.violations})`,
      undefined,
      TRRC_URLS.violations,
    ),
    open_violations:   dp(openViolations.length, trrcWells.length > 0 ? "trrc" : "missing", trrcWells.length > 0 ? "medium" : "none", undefined, undefined, TRRC_URLS.violations),
    total_violations:  dp(allViolations.length,  trrcWells.length > 0 ? "trrc" : "missing", trrcWells.length > 0 ? "medium" : "none", undefined, undefined, TRRC_URLS.violations),
    bond_status:       extracted?.bond_amount_usd != null
      ? dp("confirmed" as const, "uploaded_doc", "high", "Bond certificate in provided documents")
      : dp("not_confirmed" as const, "missing", "none", "Bond certificate not provided"),
    bond_amount_usd:   extracted?.bond_amount_usd != null
      ? dp(extracted.bond_amount_usd, "uploaded_doc", "high")
      : missingDp<number>("Request operator's current RRC bond certificate"),
    public_company:    dp(opPublicCompany, financialContext?.edgar != null ? "uploaded_doc" : "missing", financialContext?.edgar != null ? "medium" : "none"),
    edgar_company_name: financialContext?.edgar?.company_name
      ? dp(financialContext.edgar.company_name, "uploaded_doc", "medium", "SEC EDGAR")
      : missingDp<string>(),
    edgar_loe_per_boe: financialContext?.edgar?.loe_per_boe != null
      ? dp(financialContext.edgar.loe_per_boe, "uploaded_doc", "low", `SEC EDGAR 10-K FY${financialContext.edgar.fiscal_year} — company avg`)
      : missingDp<number>(),
    assessment: opAssessment,
    notes: [
      ...(extracted?.operator_notes ?? []).slice(0, 5),
      ...(!operatorName ? ["Operator name not provided — enter operator name to enable compliance lookup."] : []),
    ],
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

  // ── Spec-required 14-item document gap checklist ──────────────────────────
  //
  // The spec requires EVERY underwriting package to include a buyer request checklist
  // with these 14 exact items, each assigned one of:
  //   "Confirmed" | "Partially confirmed" | "Not found in online public query" |
  //   "Seller/operator document required"
  //
  // Recommended next source is included with each missing item.
  {
    const hasFormation   = !!(completionData?.formation_name ?? trrcCompletions.find(c => c.formation)?.formation);
    const hasDepth       = !!(completionData?.total_depth_ft ?? trrcCompletions.find(c => c.total_depth_ft)?.total_depth_ft);
    const hasInterval    = !!(completionData?.perforations && completionData.perforations.length > 0) ||
                           !!(trrcCompletions.find(c => c.completion_interval));
    const hasSpudDate    = !!(trrcCompletions.find(c => c.spud_date));
    const hasCompDate    = !!(completionData?.completion_date ?? trrcCompletions.find(c => c.completion_date)?.completion_date);
    const hasProducingZone = !!(completionData?.producing_zone);
    const hasInjZone     = !!(completionData?.injection_zone) || dedupedInjection.length > 0;
    const hasStatus      = trrcWells.length > 0 || mappedInspections.length > 0;
    const hasOperator    = !!(operatorName);
    const hasProdHistory = trrcWells.length > 0 || docMonthlyRows.length > 0;
    const hasDeclineSupport = dcaResult != null || declineRate != null;
    const hasInspHistory = mappedInspections.length > 0 || allViolations.length > 0;
    const hasWorkover    = workoverEvents.length > 0;
    const hasDowntimeExpl = downtimeResult.periods.length === 0 || workoverEvents.some(e =>
      downtimeResult.periods.some(p => e.date && e.date >= p.start_period && e.date <= (p.end_period ?? p.start_period))
    );
    const hasSWD         = dedupedInjection.length > 0 || (extracted?.injection_well_mentions ?? []).length > 0;

    type SpecStatus = "Confirmed" | "Partially confirmed" | "Not found in online public query" | "Seller/operator document required";

    const specChecklist: { field: string; status: SpecStatus; importance: MissingItem["importance"]; source: string }[] = [
      {
        field: "Formation name",
        status: hasFormation ? "Confirmed" : anyTrrcPacketFound ? "Not found in online public query" : "Seller/operator document required",
        importance: "important",
        source: hasFormation ? (completionData?.formation_name ? "Extracted from uploaded documents" : "TRRC completions query") : "Request W-2 (Completion Report) or G-1 (Gas Completion Report) from seller/operator or RRC imaged records",
      },
      {
        field: "Total depth",
        status: hasDepth ? "Confirmed" : anyTrrcPacketFound ? "Not found in online public query" : "Seller/operator document required",
        importance: "important",
        source: hasDepth ? (completionData?.total_depth_ft ? "Extracted from uploaded documents" : "TRRC EWA drilling permit (W-1)") : "Request W-1 (Drilling Permit) or W-2 from seller/operator or RRC imaged records",
      },
      {
        field: "Completion interval",
        status: hasInterval ? "Confirmed" : anyTrrcPacketFound ? "Not found in online public query" : "Seller/operator document required",
        importance: "important",
        source: hasInterval ? "Extracted from uploaded documents" : "Request W-2 (Completion Report) — perforation intervals not in TRRC online query",
      },
      {
        field: "Spud date",
        status: hasSpudDate ? "Confirmed" : anyTrrcPacketFound ? "Not found in online public query" : "Seller/operator document required",
        importance: "nice_to_have",
        source: hasSpudDate ? "Extracted from uploaded documents" : "Request W-1 (Drilling Permit) from seller/operator or RRC imaged records",
      },
      {
        field: "Completion date",
        status: hasCompDate ? "Confirmed" : anyTrrcPacketFound ? "Partially confirmed" : "Seller/operator document required",
        importance: "important",
        source: hasCompDate ? (completionData?.completion_date ? "Extracted from uploaded documents" : "TRRC CMPL online query (W-2 submit date)") : "Request W-2 (Completion Report) from seller/operator or RRC imaged records",
      },
      {
        field: "Producing zone",
        status: hasProducingZone ? "Confirmed" : anyTrrcPacketFound ? "Not found in online public query" : "Seller/operator document required",
        importance: "important",
        source: hasProducingZone ? "Extracted from uploaded documents" : "Request W-2 (Completion Report) from seller/operator",
      },
      ...(hasSWD ? [{
        field: "Injection zone (SWD)",
        status: (hasInjZone ? "Confirmed" : "Seller/operator document required") as SpecStatus,
        importance: "important" as MissingItem["importance"],
        source: hasInjZone ? (dedupedInjection.length > 0 ? "TRRC injection permit lookup" : "Extracted from uploaded documents") : "Request injection permit and MIT test records from operator or TRRC",
      }] : []),
      {
        field: "Current well status",
        status: hasStatus ? "Confirmed" : "Not found in online public query",
        importance: "critical",
        source: hasStatus ? (trrcWells.length > 0 ? "TRRC wellbore query and production data" : "TRRC ICE inspection records") : "Request operator status report; verify at TRRC EWA wellbore query",
      },
      {
        field: "Operator of record",
        status: matchTier === "exact_api" || matchTier === "exact_rrc_lease" ? "Confirmed" : hasOperator ? "Partially confirmed" : "Seller/operator document required",
        importance: "critical",
        source: matchTier === "exact_api" || matchTier === "exact_rrc_lease" ? `TRRC wellbore query (${TRRC_URLS.wellbore})` : hasOperator ? "User-provided — not confirmed against TRRC P-5" : "Request operator name and RRC operator number from seller",
      },
      {
        field: "Production history",
        status: trrcWells.length > 0 ? (allMonthlyRows.length >= 24 ? "Confirmed" : "Partially confirmed") : docMonthlyRows.length > 0 ? "Partially confirmed" : "Seller/operator document required",
        importance: "critical",
        source: trrcWells.length > 0 ? `TRRC Specific Lease Production Query — ${allMonthlyRows.length} months (${TRRC_URLS.production})` : docMonthlyRows.length > 0 ? "Extracted from uploaded documents — provide RRC lease + district for TRRC verification" : "Request 24 months of production records from operator; provide RRC lease number + district for TRRC lookup",
      },
      {
        field: "Decline-support exhibit",
        status: hasDeclineSupport ? "Confirmed" : hasProdHistory ? "Partially confirmed" : "Seller/operator document required",
        importance: "important",
        source: hasDeclineSupport ? "Computed from available production history (decline-support only — not a certified reserve report)" : "Requires ≥3 months of verified production history; request from operator or provide RRC lease number",
      },
      {
        field: "Inspection history",
        status: mappedInspections.length > 0 ? "Confirmed" : trrcComplianceLookupAttempted ? "Not found in online public query" : "Seller/operator document required",
        importance: "important",
        source: mappedInspections.length > 0 ? `TRRC ICE inspection records (${TRRC_URLS.ice}) — ${mappedInspections.length} record(s)` : trrcComplianceLookupAttempted ? `TRRC ICE queried (${TRRC_URLS.ice}) — no records returned; verify directly at TRRC PDA portal` : "Provide API number to query TRRC ICE inspection records",
      },
      {
        field: "Last workover paperwork",
        status: workoverEvents.length > 0 ? "Confirmed" : "Seller/operator document required",
        importance: "important",
        source: workoverEvents.length > 0 ? "Extracted from uploaded documents" : "Request last 3 years of workover AFEs, pulling-unit tickets, and tubing invoices from seller/operator",
      },
      {
        field: "Downtime explanation",
        status: downtimeResult.periods.length === 0 ? "Confirmed"
          : hasDowntimeExpl ? "Partially confirmed"
          : "Seller/operator document required",
        importance: downtimeResult.periods.length > 0 ? "critical" : "nice_to_have",
        source: downtimeResult.periods.length === 0
          ? "No zero-production months identified in TRRC data — continuous production confirmed"
          : hasDowntimeExpl
            ? "Partial explanation from workover records — confirm all downtime periods with operator"
            : `${downtimeResult.periods.length} zero-production period(s) identified in TRRC. Request operator downtime statement and field notes for each period. Do not assume cause from inspection records alone.`,
      },
    ];

    // Add spec checklist items to missingItems for any unconfirmed fields
    for (const item of specChecklist) {
      if (item.status === "Not found in online public query" || item.status === "Seller/operator document required") {
        if (!missingItems.some(m => m.field.toLowerCase() === item.field.toLowerCase())) {
          missingItems.push({
            section: "Spec Document Gap Checklist",
            field: item.field,
            importance: item.importance,
            note: item.status === "Not found in online public query"
              ? `Not found in online public records query. ${item.source}`
              : `${NOT_FOUND} ${item.source}`,
          });
        }
      }
    }
  }

  // ── Executive Summary ─────────────────────────────────────────────────────

  // Asset description: synthesize a one-liner from available identity data
  const assetParts: string[] = [];
  if (trrcWells.length > 0) assetParts.push(`${trrcWells.length}-well`);
  const fmtType = totalGas > totalOil * 6 ? "gas" : totalOil > 0 ? "oil" : "mineral";
  assetParts.push(fmtType + " property");
  if (completionData?.formation_name) assetParts.push(completionData.formation_name);
  if (county) assetParts.push(`${county} County`);
  if (state) assetParts.push(state.toUpperCase());
  if (operatorName) assetParts.push(`(${operatorName})`);
  const assetDescription = assetParts.join(", ");

  // Top risks — gather from risk section + compliance + downtime
  const topRisks: string[] = [
    ...riskSection.red_flags.slice(0, 3),
    ...riskSection.yellow_flags.slice(0, 2),
    ...downtimeSection.underwriting_notes.filter(n => n.startsWith("⚠️")).slice(0, 2),
  ].slice(0, 5);

  const valueDrivers: string[] = [
    ...riskSection.green_flags.slice(0, 5),
  ].slice(0, 5);

  // Data completeness: full marks = 0 critical missing, partial for important
  const critMissing = missingItems.filter(m => m.importance === "critical").length;
  const impMissing  = missingItems.filter(m => m.importance === "important").length;
  const maxScore = 100;
  const completenessScore = Math.max(0, maxScore - critMissing * 20 - impMissing * 8);

  // Sources used
  const sourcesUsed: string[] = [];
  if (trrcWells.length > 0)           sourcesUsed.push(`TRRC production (${allMonthlyRows.length} months)`);
  if (trrcViolations.length >= 0)     sourcesUsed.push("TRRC compliance (violations)");
  if (trrcInspections.length > 0)     sourcesUsed.push(`TRRC ICE inspections (${trrcInspections.length})`);
  if (trrcCompletions.some(c => c.packet_found)) sourcesUsed.push("TRRC completions query");
  if (trrcInjection.length > 0)       sourcesUsed.push("TRRC injection permits");
  if ((args.input.documents ?? []).length > 0) sourcesUsed.push(`${args.input.documents?.length} uploaded document(s)`);
  if (financialContext?.edgar)         sourcesUsed.push("SEC EDGAR");
  if (financialContext?.oil_price)     sourcesUsed.push("EIA price data");
  if (benchmark)                       sourcesUsed.push(`${benchmark.basin} basin benchmark`);

  const executiveSummarySection: ExecutiveSummarySection = {
    asset_description:      assetDescription || "Unknown property",
    identity_confidence:    matchConfidence,
    match_tier:             matchTier,
    current_gross_rate_bbl: productionSection.total_monthly_oil_bbl,
    twelve_month_avg_bbl:   wellRows[0]?.twelve_month_avg_bbl ?? missingDp<number>(),
    production_trend:       productionSection.production_trend as DataPoint<"increasing"|"flat"|"declining"|"offline">,
    downtime_pct:           downtimeResult.total_months_analyzed > 0 ? downtimeResult.downtime_pct : null,
    monthly_net_income_usd: acquisitionEconomicsSection.monthly_net_income_usd,
    npv10_usd:              acquisitionEconomicsSection.npv10_usd,
    offer_range_low:        acquisitionEconomicsSection.offer_range_low,
    offer_range_high:       acquisitionEconomicsSection.offer_range_high,
    breakeven_oil_price:    acquisitionEconomicsSection.breakeven_oil_price,
    overall_risk_score:     riskSection.overall_score,
    recommendation:         riskSection.recommendation,
    recommendation_rationale: riskSection.recommendation_rationale,
    top_risks:              topRisks,
    value_drivers:          valueDrivers,
    data_completeness_score: completenessScore,
    critical_missing_count:  critMissing,
    important_missing_count: impMissing,
    processing_time_ms:      processingTimeMs,
    sources_used:            sourcesUsed,
  };

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

  // ── Operational timeline ──────────────────────────────────────────────────
  //
  // Correlates workovers, violations, downtime periods, and production changes
  // into a single chronological event stream — the "operational history" of the asset.

  const timelineEvents: OperationalTimelineEvent[] = [];

  // Workover events
  for (const ev of workoverSection.events) {
    if (!ev.date) continue;
    const period = ev.date;
    const isHeavy = ev.cost_usd != null && ev.cost_usd > 20_000;
    timelineEvents.push({
      period,
      event_type: isHeavy ? "major_workover" : "workover",
      well: ev.well,
      description: `${ev.type}${ev.result ? ` — ${ev.result}` : ""}${ev.cost_usd != null ? ` ($${ev.cost_usd.toLocaleString()})` : ""}`,
      severity: isHeavy ? "warning" : "info",
      source: ev.source,
      production_impact_bbl: null,
    });
  }

  // Violation events
  for (const v of complianceSection.violations) {
    if (v.date) {
      timelineEvents.push({
        period: v.date,
        event_type: "violation_opened",
        well: null,
        description: `Violation opened: ${v.type} — ${v.description.slice(0, 120)}`,
        severity: v.status === "open" ? "critical" : "warning",
        source: v.source,
        production_impact_bbl: null,
      });
    }
  }

  // Downtime start/end events
  for (const period of downtimeSection.periods) {
    const cls = period.classification as string;
    const severity: OperationalTimelineEvent["severity"] =
      cls === "abandonment_risk" || cls === "current_offline" ? "critical"
      : cls === "regulatory" || cls === "major_workover" ? "warning"
      : "info";

    timelineEvents.push({
      period: period.start_period,
      event_type: "downtime_start",
      well: null,
      description: `Production offline (${cls.replace(/_/g, " ")}) — ${period.classification_rationale}`,
      severity,
      source: "trrc",
      production_impact_bbl: period.pre_downtime_rate_bbl != null ? -(period.pre_downtime_rate_bbl) : null,
    });

    if (!period.is_current && period.end_period !== period.start_period) {
      timelineEvents.push({
        period: period.end_period,
        event_type: "downtime_end",
        well: null,
        description: `Production restarted after ${period.duration_months} month${period.duration_months !== 1 ? "s" : ""} offline${period.recovery_rate_pct != null ? ` — ${period.recovery_rate_pct}% recovery vs pre-downtime rate` : ""}`,
        severity: (period.recovery_rate_pct ?? 100) < 50 ? "warning" : "info",
        source: "trrc",
        production_impact_bbl: period.post_downtime_rate_bbl ?? null,
      });
    }
  }

  // Production change events from TRRC monthly rows
  // Detect month-over-month drops or recoveries >= 30% on producing months
  const tlMonthlyRows = allMonthlyRows
    .map(r => ({ period: `${r.year}-${String(r.month).padStart(2, "0")}`, oil_bbl: r.oil_bbl }))
    .sort((a, b) => a.period < b.period ? -1 : 1);

  if (tlMonthlyRows.length >= 3) {
    for (let i = 2; i < tlMonthlyRows.length; i++) {
      const prev = tlMonthlyRows[i - 1].oil_bbl;
      const curr = tlMonthlyRows[i].oil_bbl;
      if (prev <= 0 || curr <= 0) continue; // covered by downtime periods
      const changePct = (curr - prev) / prev;
      if (changePct <= -0.30) {
        timelineEvents.push({
          period: tlMonthlyRows[i].period,
          event_type: "production_drop",
          well: null,
          description: `Production dropped ${Math.abs(changePct * 100).toFixed(0)}% MoM (${Math.round(prev)} → ${Math.round(curr)} BBL/mo)`,
          severity: changePct <= -0.50 ? "warning" : "info",
          source: "trrc",
          production_impact_bbl: Math.round(curr - prev),
        });
      } else if (changePct >= 0.40 && prev > 10) {
        timelineEvents.push({
          period: tlMonthlyRows[i].period,
          event_type: "production_recovery",
          well: null,
          description: `Production recovered +${Math.abs(changePct * 100).toFixed(0)}% MoM (${Math.round(prev)} → ${Math.round(curr)} BBL/mo)`,
          severity: "info",
          source: "trrc",
          production_impact_bbl: Math.round(curr - prev),
        });
      }
    }
  }

  // Sort chronologically; null periods go to end
  timelineEvents.sort((a, b) => {
    if (!a.period && !b.period) return 0;
    if (!a.period) return 1;
    if (!b.period) return -1;
    return a.period < b.period ? -1 : a.period > b.period ? 1 : 0;
  });

  // ── Diligence Status Engine ───────────────────────────────────────────────
  //
  // Evaluates 12 core diligence categories and classifies each as:
  //   verified | partially_verified | missing | not_applicable
  //
  // This is the buyer-facing "what do I have vs. what do I still need" board.

  const diligenceStatus: DiligenceStatusItem[] = [];

  // 1. Operator Identity
  {
    const hasOperatorVerified = matchTier === "exact_api" || matchTier === "exact_rrc_lease";
    const hasOperatorName     = !!(operatorName ?? extracted?.operator_name);
    diligenceStatus.push({
      category:     "Operator Identity",
      tier:         hasOperatorVerified ? "verified" : hasOperatorName ? "partially_verified" : "missing",
      status_detail: hasOperatorVerified
        ? `Confirmed via TRRC — operator matched at ${matchTier.replace(/_/g, " ")} level`
        : hasOperatorName
          ? `Operator name provided (${operatorName ?? extracted?.operator_name}) but not confirmed against TRRC records`
          : "No operator name provided or resolved",
      source_label:   hasOperatorVerified ? `TRRC (${matchTier.replace(/_/g, " ")})` : hasOperatorName ? "User-provided / Document" : null,
      action_required: hasOperatorVerified ? null
        : hasOperatorName ? "Confirm operator name against TRRC P-5 operator record"
        : "Provide operator name or API number to resolve operator identity",
      urgency: hasOperatorVerified ? "informational" : "critical",
    });
  }

  // 2. API / Well Identification
  //
  // NOTE: This category evaluates whether a well identifier EXISTS in the submission.
  // It is NOT the same as "production was pulled" — that is Production History (#3).
  // Having an API number that couldn't be matched to TRRC production is still
  // "partially_verified" — the identifier is real, but additional resolution is needed.
  {
    const exactMatch  = matchTier === "exact_api";
    const leaseMatch  = matchTier === "exact_rrc_lease";
    const weakMatch   = matchTier === "operator_lease_county" || matchTier === "well_name_county";
    // API or lease provided by user even if TRRC didn't return production
    const apiPresent  = providedApis.length > 0;
    const leasePresent = providedLeases.length > 0;
    const anyIdentifier = apiPresent || leasePresent || !!(operatorName && county);

    const tier =
      exactMatch || leaseMatch ? "verified" as const
      : weakMatch              ? "partially_verified" as const
      : apiPresent             ? "partially_verified" as const  // API given but no TRRC hit yet
      : leasePresent           ? "partially_verified" as const  // Lease given but no TRRC hit yet
      : anyIdentifier          ? "partially_verified" as const  // Operator + county fallback
      : "missing" as const;

    const status_detail =
      exactMatch  ? `Exact 10-digit API match confirmed in TRRC — ${normalizedApis[0]?.api_formatted ?? providedApis[0] ?? ""}`
      : leaseMatch ? `Exact RRC lease match — lease ${providedLeases[0] ?? ""}`
      : weakMatch  ? `Matched via ${matchTier.replace(/_/g, " ")} — production attribution is approximate`
      : apiPresent ? `API provided (${normalizedApis[0]?.api_formatted ?? providedApis[0]}) — no TRRC production resolved; supply RRC lease number + district for production query`
      : leasePresent ? `RRC lease number provided (${providedLeases[0]}) — TRRC lookup returned no production data`
      : anyIdentifier ? `Operator '${operatorName ?? ""}' + ${county ?? ""} County provided — no TRRC well matched; add API number for exact match`
      : "No API number, RRC lease number, or operator/county provided — well cannot be identified";

    const source_label =
      exactMatch || leaseMatch ? "TRRC"
      : apiPresent   ? "User Input (API)"
      : leasePresent ? "User Input (RRC Lease)"
      : anyIdentifier ? "User Input (Operator/County)"
      : null;

    const action_required =
      exactMatch || leaseMatch ? null
      : weakMatch  ? "Provide 10-digit API number (42-XXX-XXXXX) to confirm exact well match"
      : apiPresent ? "Provide RRC lease number + district code (e.g. '06:123456') to enable TRRC production lookup"
      : leasePresent ? "Verify RRC lease number is correct; ensure district code is included (format: 'DD:NNNNNN')"
      : anyIdentifier ? "Add 10-digit API number (42-XXX-XXXXX) to enable exact TRRC well match"
      : "Provide API number (42-XXX-XXXXX) or RRC lease number + district to identify this well";

    const urgency =
      exactMatch || leaseMatch ? "informational" as const
      : weakMatch  ? "important" as const
      : apiPresent || leasePresent ? "important" as const  // identifier present, just not matched
      : "critical" as const;

    diligenceStatus.push({ category: "API / Well Identification", tier, status_detail, source_label, action_required, urgency });
  }

  // 3. Production History
  //
  // NOTE: This category evaluates whether actual production volumes exist.
  // It is decoupled from API identification — having an API but no production
  // returned is a different state from having NO identifier at all.
  {
    const trrcMonths    = trrcWells.flatMap(w => w.monthly_rows ?? []).length;
    const docMonths     = (extracted?.production_months ?? []).length;
    const hasRunTickets = extracted?.run_tickets_present    === true;
    const hasPurchStmts = extracted?.purchaser_statements_present === true;
    const totalDocMonths = Math.max(docMonths, 0);
    const totalMonths   = Math.max(trrcMonths, totalDocMonths);
    // API or lease was present in the submission (even if TRRC returned nothing)
    const identifierPresent = providedApis.length > 0 || providedLeases.length > 0;
    // Any form of document-based production evidence
    const hasDocEvidence = totalDocMonths > 0 || hasRunTickets || hasPurchStmts;

    const tier =
      trrcMonths >= 24 ? "verified" as const
      : trrcMonths >= 6  ? "partially_verified" as const
      : totalDocMonths >= 6 ? "partially_verified" as const
      : totalMonths > 0  ? "partially_verified" as const
      : hasDocEvidence   ? "partially_verified" as const   // run tickets / purchaser stmts present
      : identifierPresent ? "partially_verified" as const  // API given — production lookup needed, not absent
      : "missing" as const;

    const status_detail =
      trrcMonths >= 24
        ? `${trrcMonths} months of TRRC-verified lease-level production — ${trrcMonths >= 36 ? "36-month" : "24-month"} DCA basis`
      : trrcMonths >= 6
        ? `${trrcMonths} months of TRRC lease-level data — recommend 24+ months for reliable decline modeling`
      : totalDocMonths >= 6
        ? `${totalDocMonths} months from uploaded documents (not independently TRRC-verified)${hasRunTickets ? " — run tickets present" : ""}${hasPurchStmts ? " — purchaser statements present" : ""}`
      : totalMonths > 0
        ? `${totalMonths} month(s) available — insufficient for decline curve analysis`
      : hasRunTickets && hasPurchStmts
        ? "Run tickets and purchaser statements present — monthly volume data not parsed"
      : hasRunTickets
        ? "Run tickets present — monthly production data not fully parsed"
      : hasPurchStmts
        ? "Purchaser statements present — monthly production data not fully parsed"
      : identifierPresent
        ? `API/lease identifier provided — TRRC production requires RRC lease number + district code to query (Texas RRC does not index by API alone)`
      : "No production history available — provide API + RRC lease/district, or upload LOE statements / run tickets";

    const source_label =
      trrcMonths > 0  ? "TRRC (Lease-Level Production)"
      : totalDocMonths > 0 ? "Uploaded Document"
      : hasRunTickets || hasPurchStmts ? "Uploaded Document (Run Tickets / Purchaser Statements)"
      : null;

    const action_required =
      trrcMonths >= 24 ? null
      : trrcMonths >= 6 ? "Request additional records to extend to 24+ months"
      : totalDocMonths >= 6 ? "Provide RRC lease number + district to pull TRRC-verified production"
      : hasDocEvidence ? "Parse run ticket / purchaser statement monthly volumes; or add RRC lease + district for TRRC lookup"
      : identifierPresent
        ? "Provide RRC lease number + district code (e.g. '06:123456') — Texas TRRC production is queried by lease, not API"
      : "Upload 12+ months of production records (LOE statements, run tickets, purchaser statements)";

    const urgency =
      trrcMonths >= 12 ? "informational" as const
      : trrcMonths >= 6 ? "important" as const
      : identifierPresent ? "important" as const   // not critical — identifier is present, just needs lease
      : hasDocEvidence   ? "important" as const
      : "critical" as const;

    diligenceStatus.push({ category: "Production History", tier, status_detail, source_label, action_required, urgency });
  }

  // 4. Inspection / Compliance History
  {
    const complianceChecked = trrcViolations.length >= 0 && providedApis.length > 0;
    const hasViolations     = complianceSection.violations.length > 0;
    const openViolations    = complianceSection.violations.filter(v => v.status === "open").length;
    diligenceStatus.push({
      category: "Inspection & Compliance History",
      tier: complianceChecked && !openViolations ? "verified"
          : complianceChecked && openViolations  ? "partially_verified"
          : "missing",
      status_detail: complianceChecked && !openViolations && !hasViolations
        ? "TRRC compliance checked — no violations on record"
        : complianceChecked && openViolations > 0
          ? `TRRC compliance checked — ${openViolations} open violation(s) found, requires resolution`
          : complianceChecked && hasViolations
            ? `TRRC compliance checked — ${complianceSection.violations.length} historical violation(s), all closed`
            : "TRRC compliance check not run — no API number or operator provided",
      source_label: complianceChecked ? "TRRC" : null,
      action_required: !complianceChecked
        ? "Provide API number to run TRRC compliance and violation check"
        : openViolations > 0
          ? `Resolve ${openViolations} open violation(s) before or at closing — request cure plan from operator`
          : null,
      urgency: openViolations > 0 ? "critical" : !complianceChecked ? "important" : "informational",
    });
  }

  // 5. LOE Statements
  {
    const loeSrc       = economicsSection.loe_statements.length > 0;
    const loeInferred  = economicsSection.avg_monthly_loe_usd.source === "inferred";
    const loeMonths    = economicsSection.loe_months_available;
    diligenceStatus.push({
      category: "LOE Statements",
      tier: loeSrc && loeMonths >= 12 ? "verified"
          : loeSrc && loeMonths >= 3  ? "partially_verified"
          : loeInferred               ? "partially_verified"
          : "missing",
      status_detail: loeSrc && loeMonths >= 12
        ? `${loeMonths} months of verified LOE statements provided — cost structure confirmed`
        : loeSrc && loeMonths >= 3
          ? `${loeMonths} months of LOE statements provided — recommend 12+ months for reliable average`
          : loeInferred
            ? `LOE not provided — estimated from basin benchmarks ($${economicsSection.avg_monthly_loe_usd.value?.toLocaleString() ?? "—"}/mo inferred)`
            : "No LOE data available — all cost estimates are basin-average inferences only",
      source_label: loeSrc ? "Uploaded Document (Operator Provided)" : loeInferred ? "Basin Benchmark (Inferred)" : null,
      action_required: loeSrc && loeMonths >= 12 ? null
        : loeSrc ? "Request additional LOE statements to cover 12 full months"
        : "Request 12 months of signed LOE statements from operator before offer",
      urgency: loeSrc ? "informational" : loeInferred ? "important" : "critical",
    });
  }

  // 6. Water Cut Data
  {
    const wcVerified = productionSection.water_cut_pct.source === "trrc" && productionSection.water_cut_pct.value != null;
    const wcPresent  = productionSection.water_cut_pct.value != null;
    const wcPct      = productionSection.water_cut_pct.value;
    diligenceStatus.push({
      category: "Water Cut & Fluid Production",
      tier: wcVerified ? "verified"
          : wcPresent  ? "partially_verified"
          : "missing",
      status_detail: wcVerified
        ? `Water cut confirmed: ${wcPct?.toFixed(1) ?? "—"}% — disposal cost basis established`
        : wcPresent
          ? `Water cut estimated at ${wcPct?.toFixed(1) ?? "—"}% — from documents or inference, not TRRC-verified`
          : "Water cut unknown — disposal costs cannot be reliably estimated",
      source_label: wcVerified ? "TRRC" : wcPresent ? "Document / Inferred" : null,
      action_required: wcVerified ? null
        : wcPresent ? "Request monthly water production records to confirm disposal volumes"
        : "Request water production records — essential for accurate LOE and SWD economics",
      urgency: wcVerified ? "informational" : wcPresent ? "important" : "important",
    });
  }

  // 7. MIT Test Records (only relevant if SWD/injection wells present)
  {
    const hasSwd      = injectionSection.wells.length > 0;
    const mitCurrent  = injectionSection.wells.some(w => w.mit_status.value === "Current");
    const mitExpired  = injectionSection.wells.some(w => w.mit_status.value === "Expired");
    const mitUnknown  = injectionSection.wells.some(w => !w.mit_status.value || w.mit_status.value === "Unknown");
    diligenceStatus.push({
      category:     "MIT Test Records",
      tier:         !hasSwd      ? "not_applicable"
                  : mitCurrent   ? "verified"
                  : mitExpired   ? "partially_verified"
                  : "missing",
      status_detail: !hasSwd
        ? "No SWD / injection wells identified for this asset"
        : mitCurrent
          ? `MIT test current on ${injectionSection.wells.filter(w => w.mit_status.value === "Current").length} injection well(s)`
          : mitExpired
            ? "MIT test expired — SWD well may be out of compliance; must be renewed before transfer"
            : "MIT status unknown — request current MIT certificates for all injection wells",
      source_label: hasSwd ? "TRRC / Operator" : null,
      action_required: !hasSwd || mitCurrent ? null
        : mitExpired ? "Renew expired MIT test before closing — SWD wells cannot operate without current MIT"
        : "Request MIT certificates for all SWD wells and confirm current status with TRRC",
      urgency: !hasSwd ? "informational" : mitCurrent ? "informational" : "critical",
    });
  }

  // 8. Workover History & Invoices
  {
    const hasWorkovers     = workoverSection.events.length > 0;
    const hasCosts         = workoverSection.events.some(e => e.cost_usd != null);
    const recentWorkover   = workoverSection.last_workover_date.value;
    diligenceStatus.push({
      category: "Workover History & Invoices",
      tier: hasWorkovers && hasCosts    ? "partially_verified"
          : hasWorkovers                ? "partially_verified"
          : "missing",
      status_detail: hasWorkovers && hasCosts
        ? `${workoverSection.events.length} workover event(s) identified with cost data — historical repair trend established`
        : hasWorkovers
          ? `${workoverSection.events.length} workover event(s) identified but invoices/costs not provided`
          : "No workover history available — mechanical risk cannot be assessed",
      source_label: hasWorkovers
        ? workoverSection.events[0].source === "trrc" ? "TRRC" : "Uploaded Document (Operator Provided)"
        : null,
      action_required: hasWorkovers && hasCosts
        ? "Review workover invoices to verify scope — consider requesting engineer's assessment of recurring issues"
        : hasWorkovers
          ? "Request workover invoices and AFEs for all identified events — costs required for LOE modeling"
          : "Request 3-year workover history and invoices from operator",
      urgency: "important",
    });
  }

  // 9. Reserve Report
  {
    const reservePresent = productionSection.reserve_report_present.value;
    const pv10Present    = productionSection.reserve_pv10.value != null;
    diligenceStatus.push({
      category: "Reserve Report / PV10",
      tier: reservePresent && pv10Present ? "verified"
          : reservePresent               ? "partially_verified"
          : "missing",
      status_detail: reservePresent && pv10Present
        ? `Reserve report provided — PV10: $${(productionSection.reserve_pv10.value! / 1_000).toFixed(0)}K`
        : reservePresent
          ? "Reserve report referenced in documents but PV10 value not extracted"
          : "No reserve report provided — EUR and PV10 are model estimates only",
      source_label: reservePresent ? "Operator Provided" : null,
      action_required: reservePresent ? null
        : "Request SEC-standard reserve estimate (PV10) prepared by licensed petroleum engineer",
      urgency: reservePresent ? "informational" : "important",
    });
  }

  // 10. Disposal Contracts (only relevant if SWD wells present)
  {
    const hasSwd           = injectionSection.wells.length > 0;
    const disposalVerified = hasSwd && injectionSection.swd_disposal_revenue_monthly.source !== "inferred"
                              && injectionSection.swd_disposal_revenue_monthly.value != null;
    diligenceStatus.push({
      category:     "Disposal Contracts",
      tier:         !hasSwd         ? "not_applicable"
                  : disposalVerified ? "verified"
                  : hasSwd          ? "partially_verified"
                  : "missing",
      status_detail: !hasSwd
        ? "No SWD / injection wells — disposal contracts not applicable"
        : disposalVerified
          ? "Disposal contract rate confirmed from documents"
          : `Disposal rate estimated at $${injectionSection.swd_disposal_rate_per_bbl?.toFixed(2) ?? "—"}/BBL (basin benchmark — not operator-confirmed)`,
      source_label: disposalVerified ? "Operator Provided" : hasSwd ? "Basin Benchmark (Inferred)" : null,
      action_required: !hasSwd || disposalVerified ? null
        : "Request current disposal contracts for all SWD wells — rate and volume commitments affect SWD economics",
      urgency: !hasSwd || disposalVerified ? "informational" : "important",
    });
  }

  // 11. Formation & Completion Data
  {
    const hasFormation  = formationCompletionSection.primary_formation.value != null;
    const hasPerfs      = formationCompletionSection.wells.some(w => w.perforations.length > 0);
    const fromTrrc      = formationCompletionSection.primary_formation.source === "trrc";
    const trrcPacket    = trrcCompletions.some(c => c.packet_found);
    diligenceStatus.push({
      category: "Formation & Completion Data",
      tier: hasFormation && hasPerfs ? "verified"
          : hasFormation             ? "partially_verified"
          : trrcPacket               ? "partially_verified"
          : "missing",
      status_detail: hasFormation && hasPerfs
        ? `Formation and perforation data confirmed — ${formationCompletionSection.primary_formation.value}`
        : hasFormation
          ? `Formation identified (${formationCompletionSection.primary_formation.value}) via ${fromTrrc ? "TRRC completions query" : "uploaded documents"} — perforation details incomplete`
          : trrcPacket
            ? "TRRC completion packet found but formation/depth data not fully parsed — request W-2 for full details"
            : "Not found in captured public records; request seller/operator or RRC imaged records (W-1, W-2, completion packet)",
      source_label: hasFormation
        ? (fromTrrc ? "TRRC Completions Query" : "Uploaded Document (OCR)")
        : trrcPacket ? "TRRC Completions Query (partial)" : null,
      action_required: hasFormation && hasPerfs ? null
        : hasFormation || trrcPacket
          ? "Request full W-2 completion report from seller/operator or RRC imaged records for perforation, casing, and interval details"
          : "Not found in captured public records; request seller/operator or RRC imaged records — W-1 (Drilling Permit), W-2 (Completion Report), completion packet",
      urgency: hasFormation ? "informational" : "important",
    });
  }

  // 11b. Inspection & Compliance (ICE Field Records)
  {
    const hasInspections  = mappedInspections.length > 0;
    const nonCompliant    = mappedInspections.filter(r => r.result === "non_compliant");
    const mostRecentDate  = mostRecentInspection?.inspection_date ?? null;
    diligenceStatus.push({
      category: "Field Inspection Records (ICE)",
      tier: hasInspections && nonCompliant.length === 0 ? "verified"
          : hasInspections && nonCompliant.length > 0   ? "partially_verified"
          : "missing",
      status_detail: hasInspections && nonCompliant.length === 0
        ? `${mappedInspections.length} inspection record(s) found — all compliant. Most recent: ${mostRecentDate ?? "unknown date"}`
        : nonCompliant.length > 0
          ? `⚠ ${nonCompliant.length} non-compliant inspection(s) found (most recent: ${mostRecentDate ?? "unknown date"})${nonCompliant[0].defect_summary ? ` — ${nonCompliant[0].defect_summary}` : ""}`
          : "No ICE inspection records found in public query — verify field inspection history at TRRC EWA",
      source_label: hasInspections ? "TRRC ICE (Public Records)" : null,
      action_required: nonCompliant.length > 0
        ? "Review non-compliant inspection(s) and confirm resolution with operator — request deficiency correction documentation"
        : !hasInspections
          ? "Verify field inspection history directly at TRRC EWA portal (Inspection/ICE lookup by API)"
          : null,
      urgency: nonCompliant.length > 0 ? "critical" : "informational",
    });
  }

  // 12. Division Orders / Ownership Schedule
  {
    const hasOwnership = ownershipSection.records.length > 0;
    const hasWi        = ownershipSection.working_interest_decimal.value != null;
    const hasNri       = ownershipSection.nri_decimal.value != null;
    const hasOverrides = !!(args.nriOverride ?? args.wiOverride);
    diligenceStatus.push({
      category: "Division Orders / Ownership",
      tier: hasOwnership && hasWi && hasNri ? "verified"
          : hasOwnership || hasOverrides    ? "partially_verified"
          : "missing",
      status_detail: hasOwnership && hasWi && hasNri
        ? `Division orders on file — WI: ${((ownershipSection.working_interest_decimal.value ?? 0) * 100).toFixed(2)}%, NRI: ${((ownershipSection.nri_decimal.value ?? 0) * 100).toFixed(4)}%`
        : hasOwnership
          ? `Ownership records present but WI/NRI decimal not fully confirmed`
          : hasOverrides
            ? `WI/NRI provided as user input — not confirmed against division orders`
            : "No division orders or ownership schedule provided — WI/NRI are defaults only",
      source_label: hasOwnership ? "Operator Provided" : hasOverrides ? "User Input" : null,
      action_required: hasOwnership && hasWi && hasNri ? null
        : hasOwnership ? "Confirm WI and NRI decimals against current division orders and any JOA amendments"
        : "Request current division orders and ownership schedule — required to confirm buyer's interest before offer",
      urgency: hasOwnership ? "informational" : hasOverrides ? "important" : "critical",
    });
  }

  // ── IC Memo Narrative ─────────────────────────────────────────────────────
  //
  // Auto-generated 4-paragraph investment committee memo. No extra AI call —
  // synthesizes from verified data already present in the report sections.

  const fmt$ = (v: number) =>
    v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}MM`
    : v >= 1_000   ? `$${Math.round(v / 1_000)}K`
    : `$${Math.round(v)}`;

  const fmtBbl = (v: number) =>
    v >= 1_000 ? `${(v / 1_000).toFixed(1)}K BBL` : `${Math.round(v)} BBL`;

  // Paragraph 1 — Asset Description & Identity
  const p1Parts: string[] = [];
  p1Parts.push(
    `This report evaluates ${assetDescription || "the subject oil and gas property"}.`
  );
  if (matchTier === "exact_api" || matchTier === "exact_rrc_lease") {
    p1Parts.push(
      `Well identity was confirmed via exact ${matchTier === "exact_api" ? "API number" : "RRC lease number"} match against TRRC production records, providing high-confidence production data.`
    );
  } else if (matchTier === "no_match") {
    p1Parts.push(
      "Production data could not be independently verified against TRRC records — economics are based on operator-provided documents only."
    );
  }
  if (providedApis.length > 0) {
    p1Parts.push(`Well API: ${providedApis.slice(0, 3).join(", ")}${providedApis.length > 3 ? ` (+${providedApis.length - 3} more)` : ""}.`);
  }
  const para1 = p1Parts.join(" ");

  // Paragraph 2 — Production & Decline Analysis
  const p2Parts: string[] = [];
  if (totalOil > 0) {
    p2Parts.push(
      `Current gross production is approximately ${Math.round(totalOil)} BBL/month oil` +
      (totalGas > 0 ? ` and ${Math.round(totalGas)} MCF/month gas` : "") + "."
    );
  } else {
    p2Parts.push("No production data is available from TRRC or operator documents.");
  }
  if (dcaResult) {
    const drAnnual = dcaResult.decline_rate_annual_pct;
    p2Parts.push(
      `Arps decline curve analysis (${dcaResult.model.type}, R²=${dcaResult.model.r_squared.toFixed(2)}) ` +
      `indicates a nominal decline rate of ${drAnnual.toFixed(1)}% annually. ` +
      `Estimated Ultimate Recovery (EUR) is ${fmtBbl(dcaResult.eur_bbl)} (unaudited model estimate).`
    );
  } else if (declineRate != null) {
    p2Parts.push(`Observed production decline is approximately ${Math.abs(declineRate).toFixed(1)}%/month based on simple trend analysis.`);
  }
  if (waterCutValue != null) {
    const wcTier = waterCutValue > 80 ? "very high" : waterCutValue > 60 ? "high" : waterCutValue > 40 ? "moderate" : "low";
    p2Parts.push(`Water cut is ${waterCutValue.toFixed(1)}% (${wcTier}), which ${waterCutValue > 70 ? "materially increases disposal costs and warrants close monitoring" : "is within normal operating range"}.`);
  }
  if (downtimeResult.downtime_pct > 0) {
    p2Parts.push(`Historical downtime is ${downtimeResult.downtime_pct.toFixed(1)}% across ${downtimeResult.total_months_analyzed} months analyzed.`);
  }
  const para2 = p2Parts.join(" ");

  // Paragraph 3 — Economics
  const p3Parts: string[] = [];
  if (econResult) {
    const baseScen = econResult.scenarios.find(s => s.deck.label === "Base");
    const stressScen = econResult.scenarios.find(s => s.deck.label === "Stress");
    if (baseScen) {
      p3Parts.push(
        `At Base case pricing ($${(baseDeckOil + (basinDiff ?? -4)).toFixed(0)}/BBL net), monthly net income is estimated at ${fmt$(baseScen.monthly_net_income_usd)} ` +
        `(${fmt$(baseScen.annual_net_income_usd)}/yr annualized). ` +
        `NPV10 under the Base deck is ${fmt$(baseScen.npv10_usd)}.`
      );
    }
    if (stressScen) {
      p3Parts.push(
        `Under Stress case pricing ($${(stressScen.deck.oil_usd_bbl + stressScen.deck.differential_bbl).toFixed(0)}/BBL net), ` +
        `NPV10 compresses to ${fmt$(stressScen.npv10_usd)}.`
      );
    }
    p3Parts.push(
      `Estimated acquisition offer range: ${fmt$(econResult.offer_range_low)} – ${fmt$(econResult.offer_range_high)} ` +
      `(${fmt$(econResult.offer_range_mid)} midpoint at 4.5× annual NCF). ` +
      `Breakeven oil price: $${econResult.breakeven_oil_price.toFixed(2)}/BBL.`
    );
    if (loePerBoe != null) {
      p3Parts.push(`LOE is estimated at $${loePerBoe.toFixed(2)}/BOE ` +
        `(${loePeriods.length > 0 ? `${loePeriods.length}-month statement average` : benchmark ? `${benchmark.basin} basin benchmark` : "estimated"}).`);
    }
  } else {
    p3Parts.push("Economic analysis could not be completed — production and/or LOE data are required.");
  }
  const para3 = p3Parts.join(" ");

  // Paragraph 4 — Risk & Recommendation
  const p4Parts: string[] = [];
  const rec = riskResult.recommendation;
  const recLabel = rec === "pursue" ? "PURSUE" : rec === "review" ? "PROCEED WITH FURTHER REVIEW" : "PASS";
  p4Parts.push(`Risk assessment: ${recLabel}. ${riskResult.recommendation_rationale}`);
  if (riskResult.red_flags.length > 0) {
    p4Parts.push(`Key risk flags: ${riskResult.red_flags.slice(0, 3).join("; ")}.`);
  }
  if (riskResult.green_flags.length > 0) {
    p4Parts.push(`Supporting factors: ${riskResult.green_flags.slice(0, 2).join("; ")}.`);
  }
  const critMissingForNarrative = missingItems.filter(m => m.importance === "critical");
  if (critMissingForNarrative.length > 0) {
    p4Parts.push(
      `${critMissingForNarrative.length} critical diligence item(s) must be resolved before an offer can be submitted: ` +
      critMissingForNarrative.slice(0, 3).map(m => m.field).join(", ") + "."
    );
  }
  p4Parts.push(
    `Overall data confidence: ${overallConfidence.toUpperCase().replace("_", " ")}. ` +
    "This analysis is preliminary and should not substitute for a certified petroleum engineer's reserve report."
  );
  const para4 = p4Parts.join(" ");

  const underwritingNarrative = [para1, para2, para3, para4].filter(p => p.trim().length > 0);

  // ── Assemble report ───────────────────────────────────────────────────────

  return {
    report_id: randomUUID(),
    generated_at: new Date().toISOString(),
    scan_mode: scanMode,
    overall_confidence: overallConfidence,
    overall_confidence_note: overallNote,
    subject,
    executive_summary: executiveSummarySection,
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
    downtime: downtimeSection,
    buyer_qa: buyerQASection,
    formation_completion: formationCompletionSection,
    operator_profile: operatorProfileSection,
    operational_timeline: timelineEvents,
    diligence_status: diligenceStatus,
    underwriting_narrative: underwritingNarrative,
    missing_items: missingItems,
    next_questions: nextQuestions,
    input_documents: (args.input.documents ?? []).map(d => ({
      filename: d.filename,
      doc_type: d.doc_type ?? "Unknown",
      char_count: d.text.length,
    })),
    production_audit: productionAudit,
    _meta: {
      trrc_lookup_attempted: trrcWells.length > 0 || providedApis.length > 0 || !!operatorName,
      trrc_match_tier: matchTier,
      trrc_compliance_attempted: trrcComplianceLookupAttempted,
      trrc_injection_attempted: isTexasState && (providedApis.length > 0 || (operatorName !== null && county !== null)),
      production_confidence: prodIntel?.production_confidence ?? null,
      production_active_months: prodIntel?.active_months ?? null,
      production_downtime_pct: prodIntel?.downtime_pct ?? null,
      production_stabilized_bbl: prodIntel?.current_stabilized_bbl ?? null,
      production_restart_events: prodIntel?.restart_event_count ?? null,
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
