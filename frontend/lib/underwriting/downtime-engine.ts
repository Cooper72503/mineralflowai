/**
 * Downtime / Risk Engine
 *
 * Analyzes monthly production history to:
 *   1. Detect consecutive zero-production periods
 *   2. Classify the probable cause of each downtime event
 *   3. Compute a volatility score and normalized (median) production rate
 *   4. Generate plain-English underwriting notes
 *
 * No external calls — all logic is deterministic from the production rows.
 */

export type DowntimePeriodClassification =
  | "workover"          // 1-2 months, ≥70% production recovery after restart
  | "major_workover"    // 3-6 months, moderate recovery
  | "regulatory"        // TRRC violation on file during the downtime window
  | "mechanical"        // 7-12 months, partial or low recovery
  | "abandonment_risk"  // >12 months offline
  | "current_offline"   // most recent period — still offline at end of data
  | "unknown";          // cannot classify from available data

export type DowntimePeriod = {
  start_period: string;               // "YYYY-MM"
  end_period: string;                 // "YYYY-MM"
  duration_months: number;
  classification: DowntimePeriodClassification;
  classification_rationale: string;
  /** How well production recovered after restart (% of pre-downtime rate) */
  recovery_rate_pct: number | null;
  pre_downtime_rate_bbl: number | null;
  post_downtime_rate_bbl: number | null;
  is_current: boolean;                // still offline at end of the data set
};

export type DowntimeAnalysisResult = {
  total_zero_months: number;
  total_months_analyzed: number;
  /** Zero months as % of total months in data set */
  downtime_pct: number;
  periods: DowntimePeriod[];
  /** Median of non-zero months — removes start-up spikes and outliers */
  normalized_rate_bbl: number | null;
  /** 0–10 volatility score based on coefficient of variation of non-zero months */
  volatility_score: number;
  longest_downtime_months: number;
  current_offline: boolean;
  production_consistency: "consistent" | "intermittent" | "erratic";
  underwriting_notes: string[];
};

// ─── Statistical helpers ──────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function periodLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// ─── Period classifier ────────────────────────────────────────────────────────

function classifyPeriod(
  duration: number,
  recoveryPct: number | null,
  hasViolation: boolean,
  isCurrent: boolean,
): { classification: DowntimePeriodClassification; rationale: string } {
  if (isCurrent) {
    if (duration > 12) return {
      classification: "abandonment_risk",
      rationale: `Well has been offline for ${duration} months with no restart — potential abandonment or severe mechanical failure.`,
    };
    if (hasViolation) return {
      classification: "regulatory",
      rationale: "Well is currently offline with a TRRC violation on file — possible regulatory or compliance shutdown.",
    };
    return {
      classification: "current_offline",
      rationale: `Well has been offline for ${duration} month(s) as of the most recent reporting period.`,
    };
  }

  if (hasViolation) return {
    classification: "regulatory",
    rationale: "Downtime window coincides with a TRRC violation — likely regulatory action or compliance-ordered shutdown.",
  };

  if (duration > 12) return {
    classification: "abandonment_risk",
    rationale: `${duration}-month downtime with no restart — indicates possible well abandonment or uneconomic mechanical repair.`,
  };

  if (duration >= 7) {
    const rec = recoveryPct != null ? ` Production recovered to ${recoveryPct}% of pre-downtime rate.` : "";
    return {
      classification: "mechanical",
      rationale: `${duration}-month extended downtime — likely major mechanical failure (tubing, rod string, or downhole pump).${rec}`,
    };
  }

  if (duration >= 3) {
    const rec = recoveryPct != null ? ` Post-workover recovery: ${recoveryPct}%.` : "";
    return {
      classification: "major_workover",
      rationale: `${duration}-month downtime — consistent with major workover, stimulation treatment, or equipment overhaul.${rec}`,
    };
  }

  // 1–2 months
  if (recoveryPct != null && recoveryPct >= 70) return {
    classification: "workover",
    rationale: `${duration}-month downtime with ${recoveryPct}% production recovery — consistent with routine pump workover or fluid load remediation.`,
  };

  return {
    classification: "unknown",
    rationale: `${duration}-month downtime. Cause undetermined — request workover AFE or operator explanation.`,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function analyzeDowntime(
  monthlyRows: { year: number; month: number; oil_bbl: number }[],
  /** "YYYY-MM-DD" violation dates from TRRC — used to detect regulatory shutdowns */
  violationDates: string[] = [],
): DowntimeAnalysisResult {
  if (monthlyRows.length === 0) {
    return {
      total_zero_months: 0,
      total_months_analyzed: 0,
      downtime_pct: 0,
      periods: [],
      normalized_rate_bbl: null,
      volatility_score: 0,
      longest_downtime_months: 0,
      current_offline: false,
      production_consistency: "consistent",
      underwriting_notes: ["No production history available for downtime analysis."],
    };
  }

  const sorted = [...monthlyRows].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );

  const totalMonths = sorted.length;
  const zeroMonths  = sorted.filter(r => r.oil_bbl === 0).length;

  // ── Detect consecutive zero-production "runs" ─────────────────────────────

  const periods: DowntimePeriod[] = [];
  let inDowntime = false;
  let dtStart    = 0;

  for (let i = 0; i < sorted.length; i++) {
    const isZero = sorted[i].oil_bbl === 0;

    if (!inDowntime && isZero) {
      inDowntime = true;
      dtStart    = i;
    } else if (inDowntime && !isZero) {
      // Period ended at index i-1
      const startRow = sorted[dtStart];
      const endRow   = sorted[i - 1];
      const duration = i - dtStart;

      // Pre-downtime rate: avg of up to 3 producing months before the gap
      const preRows = sorted.slice(Math.max(0, dtStart - 3), dtStart).filter(r => r.oil_bbl > 0);
      const preRate = preRows.length > 0
        ? preRows.reduce((s, r) => s + r.oil_bbl, 0) / preRows.length
        : null;

      // Post-downtime rate: avg of up to 3 producing months after restart
      const postRows = sorted.slice(i, Math.min(sorted.length, i + 3)).filter(r => r.oil_bbl > 0);
      const postRate = postRows.length > 0
        ? postRows.reduce((s, r) => s + r.oil_bbl, 0) / postRows.length
        : null;

      const recoveryPct = preRate && preRate > 0 && postRate != null
        ? Math.round((postRate / preRate) * 100)
        : null;

      const startLabel = periodLabel(startRow.year, startRow.month);
      const endLabel   = periodLabel(endRow.year,   endRow.month);

      const hasViolation = violationDates.some(d => {
        const m = d.slice(0, 7);
        return m >= startLabel && m <= endLabel;
      });

      const { classification, rationale } = classifyPeriod(duration, recoveryPct, hasViolation, false);

      periods.push({
        start_period:            startLabel,
        end_period:              endLabel,
        duration_months:         duration,
        classification,
        classification_rationale: rationale,
        recovery_rate_pct:       recoveryPct,
        pre_downtime_rate_bbl:   preRate  != null ? Math.round(preRate)  : null,
        post_downtime_rate_bbl:  postRate != null ? Math.round(postRate) : null,
        is_current:              false,
      });

      inDowntime = false;
    }
  }

  // If still in downtime at end of data, that's a current offline period
  if (inDowntime) {
    const startRow = sorted[dtStart];
    const endRow   = sorted[sorted.length - 1];
    const duration = sorted.length - dtStart;
    const preRows  = sorted.slice(Math.max(0, dtStart - 3), dtStart).filter(r => r.oil_bbl > 0);
    const preRate  = preRows.length > 0
      ? preRows.reduce((s, r) => s + r.oil_bbl, 0) / preRows.length
      : null;

    const startLabel   = periodLabel(startRow.year, startRow.month);
    const hasViolation = violationDates.some(d => d.slice(0, 7) >= startLabel);
    const { classification, rationale } = classifyPeriod(duration, null, hasViolation, true);

    periods.push({
      start_period:            startLabel,
      end_period:              periodLabel(endRow.year, endRow.month),
      duration_months:         duration,
      classification,
      classification_rationale: rationale,
      recovery_rate_pct:       null,
      pre_downtime_rate_bbl:   preRate != null ? Math.round(preRate) : null,
      post_downtime_rate_bbl:  null,
      is_current:              true,
    });
  }

  // ── Normalized rate & volatility ──────────────────────────────────────────

  const nonZeroRates = sorted.filter(r => r.oil_bbl > 0).map(r => r.oil_bbl);
  const normalizedRate = nonZeroRates.length > 0 ? Math.round(median(nonZeroRates)) : null;

  // Coefficient of variation → 0–10 volatility score
  const cv = nonZeroRates.length >= 3
    ? stddev(nonZeroRates) / Math.max(median(nonZeroRates), 1)
    : 0;
  const volatilityScore = Math.min(10, Math.round(cv * 10));

  const downtimePct = (zeroMonths / totalMonths) * 100;

  let consistency: "consistent" | "intermittent" | "erratic";
  if (downtimePct < 10 && volatilityScore < 4)      consistency = "consistent";
  else if (downtimePct < 30 && volatilityScore < 7) consistency = "intermittent";
  else                                               consistency = "erratic";

  const currentOffline  = periods.some(p => p.is_current);
  const longestDowntime = periods.length > 0 ? Math.max(...periods.map(p => p.duration_months)) : 0;

  // ── Underwriting notes ────────────────────────────────────────────────────

  const notes: string[] = [];

  if (currentOffline) {
    notes.push("⚠️ Well is currently offline — production and revenue are zero until restart.");
  }
  if (longestDowntime > 12) {
    notes.push(`⚠️ Longest single downtime: ${longestDowntime} months — verify current well status with TRRC P-5 filing.`);
  }
  if (downtimePct > 30) {
    notes.push(`Well was offline ${downtimePct.toFixed(0)}% of the reported period — production consistency is a concern.`);
  }
  if (volatilityScore >= 7) {
    notes.push(`High production volatility (score ${volatilityScore}/10) — erratic output increases reserve estimation uncertainty.`);
  }
  const abandonment = periods.filter(p => p.classification === "abandonment_risk").length;
  if (abandonment > 0) {
    notes.push(`${abandonment} extended downtime period(s) detected — verify current well status before committing.`);
  }
  const regulatory = periods.filter(p => p.classification === "regulatory").length;
  if (regulatory > 0) {
    notes.push(`${regulatory} downtime period(s) coincide with TRRC violations — regulatory suspension risk on record.`);
  }
  if (notes.length === 0 && totalMonths >= 6) {
    notes.push("✓ Production history is consistent with minimal downtime — no significant operational concerns identified.");
  }

  return {
    total_zero_months:       zeroMonths,
    total_months_analyzed:   totalMonths,
    downtime_pct:            Math.round(downtimePct * 10) / 10,
    periods,
    normalized_rate_bbl:     normalizedRate,
    volatility_score:        volatilityScore,
    longest_downtime_months: longestDowntime,
    current_offline:         currentOffline,
    production_consistency:  consistency,
    underwriting_notes:      notes,
  };
}
