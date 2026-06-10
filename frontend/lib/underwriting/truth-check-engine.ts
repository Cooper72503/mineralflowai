/**
 * RRC Truth-Check Engine
 *
 * Non-Negotiable requirement (Developer Handoff, June 2026):
 *   The system must not publish a diligence report until it has run an automated
 *   truth-check pass against the underlying evidence. If verified public records
 *   contradict the generated report, the product must correct, downgrade, or block
 *   the report.
 *
 * This engine:
 *   1. Aggregates all raw TRRC production rows and violation records.
 *   2. Extracts structured claims from the assembled report sections.
 *   3. Compares each claim against the raw evidence.
 *   4. Returns claim verdicts and blocking gates.
 *
 * Acceptance fixture (must pass):
 *   ODC /SAN ANDRES/ UNIT — API 42-165-02084, Lease 60509, District 8A
 *   The engine must detect the report is wrong if it claims:
 *     - Last production May 2023
 *     - Current rate 377 BBL/month
 *     - 0 zero months
 *     - 0 violations / clean TRRC compliance
 */

import type { ProductionSection, DcaSection, DowntimeSection, ComplianceSection, EconomicsSection, OfferGate } from "./types";
import type { TrrcViolation } from "./trrc-compliance";

// ─── Claim verdict vocabulary ─────────────────────────────────────────────────
//
// Matches the status vocabulary in the Developer Handoff spec exactly.

export type ClaimVerdict =
  | "true"                  // Claim matches raw evidence
  | "false"                 // Claim directly contradicted by raw evidence
  | "stale"                 // Raw evidence has newer data than the claim uses
  | "unsupported"           // No raw evidence exists to confirm or deny the claim
  | "contradicted"          // Claim diverges materially from raw evidence (>threshold)
  | "query_failed"          // The underlying data query failed — claim has no foundation
  | "parse_failed"          // Query ran but data could not be parsed
  | "verified_records_found"; // Compliance: records found — clean-compliance claim is blocked

// ─── Types ────────────────────────────────────────────────────────────────────

export type TruthCheckedClaim = {
  field: string;
  /** One-line description of the claim being evaluated */
  claim_label: string;
  /** What the report asserts */
  report_value: string | number | null;
  /** What the raw TRRC evidence shows */
  evidence_value: string | number | null;
  verdict: ClaimVerdict;
  /** Plain-English explanation of why this verdict was assigned */
  explanation: string;
  /** When true this verdict should suppress or downgrade downstream conclusions */
  blocking: boolean;
};

export type TruthCheckGate = {
  /** Stop showing production-backed conclusions (trend, current rate, BOPD) */
  block_production_claims: boolean;
  /** Stop showing "clean compliance" or "no violations" badge */
  block_clean_compliance: boolean;
  /** Stop showing NPV, offer range, payout, acquisition-grade label */
  block_economics: boolean;
  /** Stop showing offer recommendation */
  block_offer: boolean;
  /** Human-readable list of reasons for each active block */
  reasons: string[];
};

export type TruthCheckResult = {
  ran_at: string;               // ISO timestamp
  claims: TruthCheckedClaim[];
  gate: TruthCheckGate;
  /** "pass" = all claims verified; "warn" = stale/partial; "block" = contradicted/failed */
  overall_verdict: "pass" | "warn" | "block";
  /** One-sentence summary for the UI banner */
  summary: string;
};

// ─── Input ────────────────────────────────────────────────────────────────────

export type TruthCheckInput = {
  /** All raw TRRC monthly rows, aggregated across all wells on this lease */
  rawTrrcRows: {
    year: number;
    month: number;
    oil_bbl: number;
    gas_mcf: number | null;
  }[];
  /** Was the TRRC production query actually attempted? */
  trrcProductionQueryAttempted: boolean;
  /** Raw violations returned by the TRRC compliance lookup */
  rawViolations: TrrcViolation[];
  /** Was the TRRC violation query attempted? */
  trrcViolationQueryAttempted: boolean;
  /** Assembled report sections (read-only — truth-check does not mutate them) */
  reportProduction: ProductionSection;
  reportDca: DcaSection;
  reportDowntime: DowntimeSection;
  reportCompliance: ComplianceSection;
  reportEconomics: EconomicsSection;
  offerGate: OfferGate | null;
};

// ─── Internal analytics ───────────────────────────────────────────────────────

type ProductionAnalytics = {
  totalRows: number;
  nonzeroRows: number;
  zeroRows: number;
  lastNonzeroMonth: string | null;   // "YYYY-MM"
  firstNonzeroMonth: string | null;  // "YYYY-MM"
  threeMonthAvgOil: number | null;   // most recent 3 nonzero months
  twelveMonthAvgOil: number | null;
  zeroAtEndCount: number;            // consecutive zero months at tail
  totalOilBbl: number;
  totalGasMcf: number;
};

function analyzeRawRows(rows: TruthCheckInput["rawTrrcRows"]): ProductionAnalytics {
  if (rows.length === 0) {
    return {
      totalRows: 0, nonzeroRows: 0, zeroRows: 0,
      lastNonzeroMonth: null, firstNonzeroMonth: null,
      threeMonthAvgOil: null, twelveMonthAvgOil: null,
      zeroAtEndCount: 0, totalOilBbl: 0, totalGasMcf: 0,
    };
  }

  // Sort chronologically
  const sorted = [...rows].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month
  );

  const toMonthStr = (r: { year: number; month: number }) =>
    `${r.year}-${String(r.month).padStart(2, "0")}`;

  const nonzero = sorted.filter(r => r.oil_bbl > 0 || (r.gas_mcf ?? 0) > 0);
  const zeroes  = sorted.filter(r => r.oil_bbl === 0 && (r.gas_mcf ?? 0) === 0);

  // Last N nonzero months for rolling averages
  const last3  = nonzero.slice(-3).map(r => r.oil_bbl);
  const last12 = nonzero.slice(-12).map(r => r.oil_bbl);

  // Consecutive zeros at end of sorted series
  let zeroAtEndCount = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    if (r.oil_bbl === 0 && (r.gas_mcf ?? 0) === 0) zeroAtEndCount++;
    else break;
  }

  return {
    totalRows:        sorted.length,
    nonzeroRows:      nonzero.length,
    zeroRows:         zeroes.length,
    lastNonzeroMonth: nonzero.length > 0 ? toMonthStr(nonzero[nonzero.length - 1]) : null,
    firstNonzeroMonth: nonzero.length > 0 ? toMonthStr(nonzero[0]) : null,
    threeMonthAvgOil:  last3.length  > 0 ? last3.reduce((s, v) => s + v, 0) / last3.length   : null,
    twelveMonthAvgOil: last12.length > 0 ? last12.reduce((s, v) => s + v, 0) / last12.length : null,
    zeroAtEndCount,
    totalOilBbl: sorted.reduce((s, r) => s + r.oil_bbl, 0),
    totalGasMcf: sorted.reduce((s, r) => s + (r.gas_mcf ?? 0), 0),
  };
}

// ─── Month comparison helpers ─────────────────────────────────────────────────

/** "2023-05" → 2023 * 12 + 5 */
function monthIndex(m: string): number {
  const [y, mo] = m.split("-").map(Number);
  return (y || 0) * 12 + (mo || 0);
}

/** positive = a is later, negative = a is earlier */
function compareMonths(a: string, b: string): number {
  return monthIndex(a) - monthIndex(b);
}

// ─── Main truth-check function ────────────────────────────────────────────────

export function runTruthCheck(input: TruthCheckInput): TruthCheckResult {
  const {
    rawTrrcRows,
    trrcProductionQueryAttempted,
    rawViolations,
    trrcViolationQueryAttempted,
    reportProduction,
    reportDca,
    reportDowntime,
    reportCompliance,
    reportEconomics,
    offerGate,
  } = input;

  const claims: TruthCheckedClaim[] = [];
  const analytics = analyzeRawRows(rawTrrcRows);

  // ── 1. Production query status ────────────────────────────────────────────
  //
  // If the query was attempted but returned ZERO rows, every production claim
  // is unsupported. Flag this first — downstream claims inherit this verdict.

  const trrcHasRows = rawTrrcRows.length > 0;

  if (trrcProductionQueryAttempted && !trrcHasRows) {
    claims.push({
      field: "production_query",
      claim_label: "TRRC production query",
      report_value: "data available",
      evidence_value: "0 rows returned",
      verdict: "query_failed",
      explanation:
        "TRRC production query was attempted but returned zero rows. " +
        "All production-backed conclusions (current rate, trend, downtime) have no evidentiary foundation.",
      blocking: true,
    });
  }

  // ── 2. Last production month staleness ────────────────────────────────────
  //
  // If TRRC has data, the report's claimed last production date must match.
  // If TRRC's last nonzero month is LATER than the report's date, the report is stale.

  const reportLastMonth = reportProduction.last_production_date.value;

  if (trrcHasRows && analytics.lastNonzeroMonth) {
    if (!reportLastMonth) {
      claims.push({
        field: "last_production_month",
        claim_label: "Last production month",
        report_value: null,
        evidence_value: analytics.lastNonzeroMonth,
        verdict: "unsupported",
        explanation:
          `TRRC data shows production through ${analytics.lastNonzeroMonth} ` +
          "but the report has no last-production-date claim.",
        blocking: false,
      });
    } else if (compareMonths(analytics.lastNonzeroMonth, reportLastMonth) > 0) {
      // TRRC is more recent — the report's date is stale
      claims.push({
        field: "last_production_month",
        claim_label: "Last production month",
        report_value: reportLastMonth,
        evidence_value: analytics.lastNonzeroMonth,
        verdict: "stale",
        explanation:
          `Report claims last production was ${reportLastMonth}, but TRRC has production ` +
          `through ${analytics.lastNonzeroMonth}. The current-production claim is based on outdated data.`,
        blocking: true,
      });
    } else {
      claims.push({
        field: "last_production_month",
        claim_label: "Last production month",
        report_value: reportLastMonth,
        evidence_value: analytics.lastNonzeroMonth,
        verdict: "true",
        explanation: `Report's last production month (${reportLastMonth}) matches TRRC evidence.`,
        blocking: false,
      });
    }
  } else if (!trrcProductionQueryAttempted) {
    if (reportLastMonth && (reportProduction.last_production_date.source as string) === "seller_document") {
      claims.push({
        field: "last_production_month",
        claim_label: "Last production month",
        report_value: reportLastMonth,
        evidence_value: null,
        verdict: "unsupported",
        explanation:
          `Last production date (${reportLastMonth}) comes from seller documents only — ` +
          "not independently verified against TRRC.",
        blocking: false,
      });
    }
  }

  // ── 3. Current production rate accuracy ──────────────────────────────────
  //
  // Compare report's current rate against TRRC's 3-month average.
  // >20% divergence = contradicted. >40% = false.

  const reportRate = reportDca.current_rate_bbl.value;
  const RATE_TOLERANCE = 0.20;   // 20% — normal measurement/timing variance
  const RATE_CONTRADICTION = 0.40; // 40% — clearly wrong

  if (trrcHasRows && analytics.threeMonthAvgOil !== null) {
    const rawRate = analytics.threeMonthAvgOil;

    if (reportRate == null) {
      claims.push({
        field: "current_rate_bbl",
        claim_label: "Current rate (BBL/month)",
        report_value: null,
        evidence_value: Math.round(rawRate),
        verdict: "unsupported",
        explanation:
          `TRRC 3-month average is ${Math.round(rawRate)} BBL/mo but report has no current-rate claim.`,
        blocking: false,
      });
    } else {
      const divergence = rawRate > 0
        ? Math.abs(reportRate - rawRate) / rawRate
        : (reportRate > 0 ? 1 : 0);

      let verdict: ClaimVerdict;
      let explanation: string;

      if (rawRate === 0 && reportRate > 0) {
        verdict = "false";
        explanation =
          `Report claims current rate is ${Math.round(reportRate)} BBL/mo, but TRRC 3-month average ` +
          "is ZERO — the well appears to be offline or non-producing. This is a hard contradiction.";
      } else if (divergence > RATE_CONTRADICTION) {
        verdict = "contradicted";
        explanation =
          `Report claims ${Math.round(reportRate)} BBL/mo but TRRC 3-month avg is ` +
          `${Math.round(rawRate)} BBL/mo — a ${(divergence * 100).toFixed(0)}% divergence ` +
          "(threshold: 40%). Current-production claim is unreliable.";
      } else if (divergence > RATE_TOLERANCE) {
        verdict = "stale";
        explanation =
          `Report rate (${Math.round(reportRate)} BBL/mo) differs from TRRC 3-month avg ` +
          `(${Math.round(rawRate)} BBL/mo) by ${(divergence * 100).toFixed(0)}%. Possible timing lag.`;
      } else {
        verdict = "true";
        explanation =
          `Report rate (${Math.round(reportRate)} BBL/mo) consistent with TRRC 3-month avg ` +
          `(${Math.round(rawRate)} BBL/mo, ${(divergence * 100).toFixed(0)}% variance).`;
      }

      claims.push({
        field: "current_rate_bbl",
        claim_label: "Current rate (BBL/month)",
        report_value: Math.round(reportRate),
        evidence_value: Math.round(rawRate),
        verdict,
        explanation,
        blocking: verdict === "false" || verdict === "contradicted",
      });
    }
  } else if (trrcProductionQueryAttempted && !trrcHasRows) {
    // Query ran, zero rows — any rate claim is baseless
    if (reportRate != null && reportRate > 0) {
      claims.push({
        field: "current_rate_bbl",
        claim_label: "Current rate (BBL/month)",
        report_value: Math.round(reportRate),
        evidence_value: 0,
        verdict: "query_failed",
        explanation:
          `Report claims ${Math.round(reportRate)} BBL/mo but TRRC production query returned ` +
          "zero rows. This rate cannot be verified — it likely comes from seller documents only. " +
          "Do not use this rate for offer calculations.",
        blocking: true,
      });
    }
  }

  // ── 4. Zero-month / downtime detection ───────────────────────────────────
  //
  // If TRRC rows contain zero-production months, a report claim of "0 zero months"
  // or "0% downtime" is false and must block the downtime-clean claim.

  const reportZeroMonths   = reportDowntime.total_zero_months.value ?? 0;
  const reportDowntimePct  = reportDowntime.downtime_pct.value ?? 0;
  const evidenceZeroMonths = analytics.zeroRows;

  if (trrcHasRows && analytics.totalRows > 0) {
    if (reportZeroMonths === 0 && evidenceZeroMonths > 0) {
      claims.push({
        field: "zero_months",
        claim_label: "Zero-production months",
        report_value: 0,
        evidence_value: evidenceZeroMonths,
        verdict: "false",
        explanation:
          `Report claims 0 zero-production months but TRRC data contains ` +
          `${evidenceZeroMonths} month(s) with zero oil AND gas production. ` +
          "Downtime is understated — do not assert zero-downtime or full-production continuity.",
        blocking: true,
      });
    } else if (reportZeroMonths > 0 && evidenceZeroMonths === 0) {
      claims.push({
        field: "zero_months",
        claim_label: "Zero-production months",
        report_value: reportZeroMonths,
        evidence_value: 0,
        verdict: "stale",
        explanation:
          `Report records ${reportZeroMonths} zero months but TRRC rows show no zeros. ` +
          "Possible improvement since the report was built, or data window mismatch.",
        blocking: false,
      });
    } else {
      const verdictZ: ClaimVerdict =
        Math.abs(reportZeroMonths - evidenceZeroMonths) <= 1 ? "true" : "stale";
      claims.push({
        field: "zero_months",
        claim_label: "Zero-production months",
        report_value: reportZeroMonths,
        evidence_value: evidenceZeroMonths,
        verdict: verdictZ,
        explanation:
          verdictZ === "true"
            ? `Zero-month count consistent between report (${reportZeroMonths}) and TRRC evidence (${evidenceZeroMonths}).`
            : `Zero-month count diverges: report says ${reportZeroMonths}, TRRC shows ${evidenceZeroMonths}.`,
        blocking: false,
      });
    }

    // Consecutive zeros at tail = well is currently offline
    if (analytics.zeroAtEndCount >= 3 && reportDowntimePct === 0) {
      claims.push({
        field: "current_offline_status",
        claim_label: "Well currently online",
        report_value: "producing",
        evidence_value: `${analytics.zeroAtEndCount} consecutive zero months at end of data`,
        verdict: "false",
        explanation:
          `TRRC data ends with ${analytics.zeroAtEndCount} consecutive months of zero production. ` +
          "The report should not claim active/producing status or a positive current rate.",
        blocking: true,
      });
    }
  }

  // ── 5. Compliance / violations ────────────────────────────────────────────
  //
  // If the TRRC violation dataset contains records matching this lease/API,
  // a clean-compliance claim is blocked regardless of its source.
  //
  // If the violation query was never run, clean-compliance is also blocked
  // (cannot infer clean status from absence of a query).

  const reportSaysClean =
    reportCompliance.violations.length === 0 ||
    (reportCompliance.open_violation_count.value ?? 0) === 0;

  if (!trrcViolationQueryAttempted) {
    claims.push({
      field: "compliance_clean",
      claim_label: "TRRC clean compliance",
      report_value: "no violations",
      evidence_value: null,
      verdict: "query_failed",
      explanation:
        "Violation query was not run. Cannot assert clean compliance — absence of a query " +
        "is not evidence of no violations. Block clean-compliance and 'no violations' claims.",
      blocking: true,
    });
  } else if (rawViolations.length > 0) {
    const openCount = rawViolations.filter(v => v.status === "open").length;
    claims.push({
      field: "compliance_clean",
      claim_label: "TRRC clean compliance",
      report_value: reportSaysClean ? "no violations" : `${reportCompliance.open_violation_count.value ?? 0} open`,
      evidence_value: `${rawViolations.length} record(s), ${openCount} open`,
      verdict: "verified_records_found",
      explanation:
        `TRRC violation lookup returned ${rawViolations.length} record(s) ` +
        `(${openCount} open). ` +
        (reportSaysClean
          ? "Report's clean-compliance claim is BLOCKED — violation records exist."
          : "Violation records present — confirm count and status before close."),
      blocking: reportSaysClean,  // block only if the report was claiming clean status
    });
  } else {
    // Violation query ran, returned zero records — this IS verified clean
    claims.push({
      field: "compliance_clean",
      claim_label: "TRRC clean compliance",
      report_value: "no violations",
      evidence_value: "0 records found",
      verdict: "true",
      explanation:
        "TRRC violation lookup ran and returned zero records for this lease/API. " +
        "Clean-compliance claim is supported by official records.",
      blocking: false,
    });
  }

  // ── 6. LOE / ownership / economics validity ───────────────────────────────
  //
  // If LOE or ownership data is missing, suppress NPV, offer range, payout,
  // and acquisition-grade label.

  const loeEvidSrc: "seller_document" | "not_found" = reportEconomics.loe_statements.length > 0 ? "seller_document" : "not_found";
  const offerBlocked = offerGate != null && !offerGate.gate_open;

  if (loeEvidSrc === "not_found") {
    claims.push({
      field: "loe_economics_support",
      claim_label: "LOE / revenue support for economics",
      report_value: reportEconomics.avg_monthly_loe_usd.value != null
        ? `$${Math.round(reportEconomics.avg_monthly_loe_usd.value).toLocaleString()}/mo`
        : null,
      evidence_value: "not provided",
      verdict: "unsupported",
      explanation:
        "No LOE statements were provided. Economics computations (NPV, offer range, payout) " +
        "rely on basin-average inference, not verified cost data. " +
        "Suppress acquisition-grade label and offer recommendation.",
      blocking: true,
    });
  }

  if (offerBlocked && offerGate) {
    claims.push({
      field: "offer_gate",
      claim_label: "Offer recommendation gate",
      report_value: "offer enabled",
      evidence_value: `blocked (${offerGate.blocking_count} field(s))`,
      verdict: "unsupported",
      explanation: offerGate.gate_message,
      blocking: true,
    });
  }

  // ── Build gate decisions ──────────────────────────────────────────────────

  const blockingClaims = claims.filter(c => c.blocking);
  const reasons: string[] = blockingClaims.map(c => `[${c.field}] ${c.verdict}: ${c.explanation.split(".")[0]}.`);

  const productionBlocked = blockingClaims.some(c =>
    ["production_query", "current_rate_bbl", "current_offline_status"].includes(c.field)
  );
  const zeroMonthBlocked = blockingClaims.some(c => c.field === "zero_months");
  const complianceBlocked = blockingClaims.some(c => c.field === "compliance_clean");
  const economicsBlocked  = blockingClaims.some(c =>
    ["loe_economics_support", "offer_gate"].includes(c.field)
  ) || productionBlocked;

  const gate: TruthCheckGate = {
    block_production_claims: productionBlocked || zeroMonthBlocked,
    block_clean_compliance:  complianceBlocked,
    block_economics:         economicsBlocked,
    block_offer:             economicsBlocked || productionBlocked || offerBlocked,
    reasons,
  };

  // ── Overall verdict ───────────────────────────────────────────────────────

  const hasBlock = blockingClaims.length > 0;
  const hasWarn  = claims.some(c => c.verdict === "stale" || c.verdict === "unsupported");

  const overall_verdict: TruthCheckResult["overall_verdict"] = hasBlock ? "block" : hasWarn ? "warn" : "pass";

  const summary =
    overall_verdict === "pass"
      ? `All ${claims.length} truth-check claims verified against TRRC evidence — no contradictions found.`
      : overall_verdict === "warn"
        ? `Truth-check: ${claims.filter(c => c.verdict === "stale" || c.verdict === "unsupported").length} claim(s) stale or unsupported — review before advancing offer.`
        : `Truth-check BLOCKED: ${blockingClaims.length} claim(s) contradicted by TRRC evidence — ` +
          blockingClaims.slice(0, 2).map(c => c.field).join(", ") +
          (blockingClaims.length > 2 ? ` (+${blockingClaims.length - 2} more)` : "") + ".";

  return {
    ran_at: new Date().toISOString(),
    claims,
    gate,
    overall_verdict,
    summary,
  };
}
