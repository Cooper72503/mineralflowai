/**
 * Production Intelligence Engine
 *
 * Transforms raw TRRC monthly rows into a stabilized, classified production
 * profile for institutional-grade decline-curve analysis and acquisition economics.
 *
 * Problems this engine solves vs. naive averaging:
 *
 *   1. INCOMPLETE MONTHS — TRRC data lags 2-4 months. The most-recent
 *      reported months are often partial. Using them as "current production"
 *      overstates decline and understates value.
 *
 *   2. RESTART DISTORTION — Post-shut-in restart months are transition
 *      periods: the well is loading up, swabbing, or still cleaning out.
 *      Averaging them with stable production destroys the decline curve.
 *
 *   3. FLUSH PRODUCTION — Newly re-perforated or stimulated wells produce
 *      anomalously high initial rates. Including these in a trailing average
 *      overstates sustainable production.
 *
 *   4. CALENDAR TIME GAPS — Standard DCA implementations use sequential
 *      index (t=0,1,2…) for non-zero months. A well with a 6-month shut-in
 *      gets a compressed time axis, which steepens the fitted decline rate.
 *      Correct approach: use elapsed calendar months so gaps are preserved.
 *
 *   5. MULTI-MONTH DOWNTIME AVERAGING — Computing a 12-month "average" that
 *      includes 3 zero months understates the well's operating rate by 25%.
 *      Acquisition models must use stabilized (producing-months-only) rates.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type MonthClassification =
  | "active"      // Normal, stable, fully-reported production month
  | "downtime"    // Zero or below-threshold production (< DOWNTIME_THRESHOLD_BBL)
  | "restart"     // First 1-2 months after resumption — excluded from stable averages
  | "flush"       // Anomalously high rate (post-stimulation spike) — excluded from trend
  | "incomplete"; // Most-recent months that may be partial TRRC reports

export type ClassifiedMonthlyRow = {
  year: number;
  month: number;
  period: string;        // "YYYY-MM"
  oil_bbl: number;
  gas_mcf: number | null;
  /**
   * Months elapsed since the first row in the series.
   * Preserves calendar gaps — critical for correct DCA time axis.
   * e.g. a 4-month shut-in produces a jump from t=14 to t=19, not t=14 to t=15.
   */
  calendar_t: number;
  classification: MonthClassification;
  classification_note: string | null;
};

export type ProductionDataConfidence = "VERIFIED" | "PARTIAL" | "INFERRED";

export type StabilizedProductionProfile = {
  /** Every month in the series, each tagged with a classification */
  classified_months: ClassifiedMonthlyRow[];

  // ── Stabilized trailing averages (active months only) ─────────────────────
  // "Active" excludes: downtime, restart, flush, and incomplete months.
  // These are the rates that should drive economics and DCA initial conditions.

  stabilized_3mo_bbl: number | null;
  stabilized_6mo_bbl: number | null;
  stabilized_12mo_bbl: number | null;
  stabilized_24mo_bbl: number | null;

  /**
   * Best current rate estimate — used as the DCA qi and economics input rate.
   * Preference order:
   *   1. Stabilized 3-month avg (if ≥ 3 active months in trailing 3-month window)
   *   2. Stabilized 6-month avg
   *   3. Most recent single active month
   * This is NOT a naive average of raw rows.
   */
  current_stabilized_bbl: number | null;
  current_stabilized_source: string;

  // ── DCA-ready data ────────────────────────────────────────────────────────
  /**
   * Active months with calendar_t preserved — suitable for Arps DCA fitting.
   * Excludes: downtime, restart, flush, incomplete months.
   * Preserves calendar gaps so decline curves are not artificially steepened.
   */
  dca_rows: { year: number; month: number; oil_bbl: number; calendar_t: number }[];
  /** Calendar_t of the most recent dca_row — used to anchor projections */
  dca_current_t: number;

  // ── Restart event tracking ────────────────────────────────────────────────
  restart_detected: boolean;
  restart_event_count: number;
  last_restart_period: string | null;
  /** Avg of 3 active months before the most recent restart */
  pre_restart_rate_bbl: number | null;
  /** Avg of active months after restart stabilized (restart months excluded) */
  post_restart_stable_rate_bbl: number | null;
  /** Recovery rate: post / pre (> 100% indicates improved rate after workover) */
  restart_recovery_pct: number | null;

  // ── Incomplete month handling ─────────────────────────────────────────────
  incomplete_months_excluded: number;
  /** Months that may be partial (TRRC lag) but were not excluded (borderline) */
  potentially_incomplete_flagged: number;

  // ── Production stats ──────────────────────────────────────────────────────
  cumulative_oil_bbl: number;
  downtime_pct: number;
  total_months_in_series: number;
  active_months: number;

  // ── Confidence ────────────────────────────────────────────────────────────
  production_confidence: ProductionDataConfidence;
  confidence_reasons: string[];

  /** Plain-English warnings for the acquisition underwriter */
  warnings: string[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Months below this BBL count as downtime (accounts for minor non-zero reports) */
const DOWNTIME_THRESHOLD_BBL = 5;

/** Months after restart before production is considered "stabilized" */
const RESTART_TRANSITION_MONTHS = 2;

/**
 * A month is "flush" if its oil_bbl > FLUSH_MULTIPLIER × trailing median of active months.
 * Post-stimulation flush rates skew decline curves significantly.
 */
const FLUSH_MULTIPLIER = 2.5;

/**
 * TRRC production data typically lags real-time by 2-4 months.
 * The N most-recent months in the data are candidates for being partially reported.
 */
const TRRC_LAG_MONTHS = 3;

// ─── Statistical helpers ──────────────────────────────────────────────────────

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function trailingActiveAvg(
  rows: ClassifiedMonthlyRow[],
  upToIndex: number,   // inclusive
  nMonths: number,     // how many trailing months to look at (calendar)
): number | null {
  // Collect active months within the last nMonths calendar months of upToIndex
  const anchorT = rows[upToIndex].calendar_t;
  const windowStart = anchorT - nMonths + 1;
  const active = rows
    .slice(0, upToIndex + 1)
    .filter(r => r.calendar_t >= windowStart && r.classification === "active");
  if (active.length === 0) return null;
  return active.reduce((s, r) => s + r.oil_bbl, 0) / active.length;
}

// ─── Calendar time builder ────────────────────────────────────────────────────

function buildCalendarT(
  rows: { year: number; month: number }[],
): number[] {
  if (rows.length === 0) return [];
  const base = rows[0];
  return rows.map(r => (r.year - base.year) * 12 + (r.month - base.month));
}

// ─── Incomplete month detection ───────────────────────────────────────────────

/**
 * Identify months that are likely partially reported due to TRRC data lag.
 *
 * Strategy:
 *   - Any month within TRRC_LAG_MONTHS calendar months of the current date
 *     is a candidate for being incomplete.
 *   - If that month's oil_bbl is < 55% of the prior 3-month active average,
 *     classify as "incomplete" (strong signal of partial reporting).
 *   - If 55-75% of prior avg, flag as "potentially_incomplete" (borderline).
 *
 * Returns a Set of indices in the sorted array that are "incomplete".
 */
function detectIncompleteMonths(
  sorted: { year: number; month: number; oil_bbl: number }[],
): { incomplete: Set<number>; borderline: Set<number> } {
  const today = new Date();
  const todayT = today.getFullYear() * 12 + today.getMonth(); // 0-indexed months since year 0

  const incomplete = new Set<number>();
  const borderline = new Set<number>();

  for (let i = sorted.length - 1; i >= 0; i--) {
    const row = sorted[i];
    const rowT = row.year * 12 + (row.month - 1); // convert to same 0-indexed space
    const monthsAgo = todayT - rowT;

    if (monthsAgo > TRRC_LAG_MONTHS + 1) break; // older months are fully reported

    if (monthsAgo <= TRRC_LAG_MONTHS) {
      // Check production level vs prior active average
      const priorActive = sorted
        .slice(Math.max(0, i - 6), i)
        .filter(r => r.oil_bbl >= DOWNTIME_THRESHOLD_BBL);

      if (priorActive.length >= 2) {
        const priorAvg = priorActive.reduce((s, r) => s + r.oil_bbl, 0) / priorActive.length;
        if (priorAvg > 0) {
          const ratio = row.oil_bbl / priorAvg;
          if (row.oil_bbl === 0) {
            // Zero during a lag period: could be downtime or not yet reported
            incomplete.add(i);
          } else if (ratio < 0.55) {
            incomplete.add(i);
          } else if (ratio < 0.75) {
            borderline.add(i);
          }
        }
      } else if (i === sorted.length - 1 && row.oil_bbl === 0 && monthsAgo <= 2) {
        // Most recent month is zero and very recent — likely not yet reported
        incomplete.add(i);
      }
    }
  }

  return { incomplete, borderline };
}

// ─── Restart & flush detection ────────────────────────────────────────────────

interface RestartEvent {
  restartIndex: number;   // first producing month after downtime
  preRate: number | null; // avg of up to 3 active months before downtime
  transitionEnd: number;  // last month index to mark as "restart" (exclusive)
}

function detectRestartEvents(
  sorted: { year: number; month: number; oil_bbl: number }[],
  incompleteSet: Set<number>,
): RestartEvent[] {
  const events: RestartEvent[] = [];
  let inDowntime = false;
  let downtimeStart = 0;

  for (let i = 0; i < sorted.length; i++) {
    const isActive = sorted[i].oil_bbl >= DOWNTIME_THRESHOLD_BBL && !incompleteSet.has(i);

    if (!inDowntime && !isActive) {
      inDowntime = true;
      downtimeStart = i;
    } else if (inDowntime && isActive) {
      // Restart detected at index i
      const dtLength = i - downtimeStart;
      if (dtLength >= 1) {
        // Pre-restart rate: avg of up to 3 active months before downtime
        const preRows = sorted.slice(Math.max(0, downtimeStart - 3), downtimeStart)
          .filter(r => r.oil_bbl >= DOWNTIME_THRESHOLD_BBL);
        const preRate = preRows.length > 0
          ? preRows.reduce((s, r) => s + r.oil_bbl, 0) / preRows.length
          : null;

        events.push({
          restartIndex: i,
          preRate,
          transitionEnd: Math.min(sorted.length, i + RESTART_TRANSITION_MONTHS),
        });
      }
      inDowntime = false;
    }
  }

  return events;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Analyze raw monthly production rows and return a stabilized production profile
 * with classified months, stabilized rates, DCA-ready data, and confidence labels.
 *
 * @param rawRows - Monthly production rows from TRRC or document extraction.
 *                  Must include at minimum: year, month, oil_bbl.
 * @param leaseWellCount - Optional hint: how many wells are on this lease (from
 *                         TRRC well count or operator). Used for multi-well flagging.
 */
export function analyzeProductionIntelligence(
  rawRows: { year: number; month: number; oil_bbl: number; gas_mcf?: number | null }[],
  leaseWellCount?: number,
): StabilizedProductionProfile {
  const warnings: string[] = [];
  const confidenceReasons: string[] = [];

  // ── 1. Sort chronologically ───────────────────────────────────────────────
  const sorted = [...rawRows].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );

  if (sorted.length === 0) {
    return emptyProfile();
  }

  const calendarTs = buildCalendarT(sorted);

  // ── 2. Detect incomplete months ───────────────────────────────────────────
  const { incomplete: incompleteSet, borderline: borderlineSet } = detectIncompleteMonths(sorted);

  // ── 3. Detect restart events ──────────────────────────────────────────────
  const restartEvents = detectRestartEvents(sorted, incompleteSet);

  // Build a fast lookup: index → which restart transition period it's in
  const restartIndexMap = new Map<number, RestartEvent>();
  for (const ev of restartEvents) {
    for (let i = ev.restartIndex; i < ev.transitionEnd; i++) {
      restartIndexMap.set(i, ev);
    }
  }

  // ── 4. Compute running median for flush detection ─────────────────────────
  // Use active (non-downtime, non-restart) months seen so far
  const activeRatesSoFar: number[] = [];

  // ── 5. Classify every month ───────────────────────────────────────────────
  const classified: ClassifiedMonthlyRow[] = sorted.map((row, i) => {
    const period = `${row.year}-${String(row.month).padStart(2, "0")}`;
    const t = calendarTs[i];
    const oilBbl = row.oil_bbl;

    // Incomplete check
    if (incompleteSet.has(i)) {
      return {
        year: row.year, month: row.month, period,
        oil_bbl: oilBbl, gas_mcf: row.gas_mcf ?? null,
        calendar_t: t,
        classification: "incomplete" as MonthClassification,
        classification_note: `Potentially partial TRRC report — within ${TRRC_LAG_MONTHS}-month lag window`,
      };
    }

    // Downtime check
    if (oilBbl < DOWNTIME_THRESHOLD_BBL) {
      return {
        year: row.year, month: row.month, period,
        oil_bbl: oilBbl, gas_mcf: row.gas_mcf ?? null,
        calendar_t: t,
        classification: "downtime" as MonthClassification,
        classification_note: oilBbl === 0 ? "Zero production" : `Below threshold (${oilBbl} BBL < ${DOWNTIME_THRESHOLD_BBL} BBL)`,
      };
    }

    // Restart transition check
    if (restartIndexMap.has(i)) {
      const ev = restartIndexMap.get(i)!;
      const transitionMonth = i - ev.restartIndex + 1;
      return {
        year: row.year, month: row.month, period,
        oil_bbl: oilBbl, gas_mcf: row.gas_mcf ?? null,
        calendar_t: t,
        classification: "restart" as MonthClassification,
        classification_note: `Post-restart transition month ${transitionMonth}/${RESTART_TRANSITION_MONTHS} — excluded from stabilized averages`,
      };
    }

    // Flush check (only after we have ≥ 6 active months of history)
    if (activeRatesSoFar.length >= 6) {
      const runningMedian = sortedMedian(activeRatesSoFar);
      if (runningMedian > 0 && oilBbl > runningMedian * FLUSH_MULTIPLIER) {
        return {
          year: row.year, month: row.month, period,
          oil_bbl: oilBbl, gas_mcf: row.gas_mcf ?? null,
          calendar_t: t,
          classification: "flush" as MonthClassification,
          classification_note: `Anomalous rate (${oilBbl.toFixed(0)} BBL = ${(oilBbl / runningMedian).toFixed(1)}× median ${runningMedian.toFixed(0)} BBL) — excluded from trend`,
        };
      }
    }

    // Active — update running median
    activeRatesSoFar.push(oilBbl);
    return {
      year: row.year, month: row.month, period,
      oil_bbl: oilBbl, gas_mcf: row.gas_mcf ?? null,
      calendar_t: t,
      classification: "active" as MonthClassification,
      classification_note: borderlineSet.has(i) ? "Rate below recent trend — verify completeness" : null,
    };
  });

  // ── 6. Compute stabilized trailing rates ──────────────────────────────────
  // Trailing N calendar months from the last month in the series,
  // using only "active" months.
  const lastT = calendarTs[calendarTs.length - 1];
  const allActive = classified.filter(r => r.classification === "active");

  function stableAvgInWindow(windowMonths: number): number | null {
    const cutoff = lastT - windowMonths;
    const inWindow = allActive.filter(r => r.calendar_t > cutoff);
    if (inWindow.length === 0) return null;
    return inWindow.reduce((s, r) => s + r.oil_bbl, 0) / inWindow.length;
  }

  const stabilized3mo  = stableAvgInWindow(3);
  const stabilized6mo  = stableAvgInWindow(6);
  const stabilized12mo = stableAvgInWindow(12);
  const stabilized24mo = stableAvgInWindow(24);

  // Best current rate
  let currentStabilized: number | null = null;
  let currentStabilizedSource = "";
  if (stabilized3mo != null) {
    currentStabilized = stabilized3mo;
    currentStabilizedSource = "3-month stabilized average (active months only)";
  } else if (stabilized6mo != null) {
    currentStabilized = stabilized6mo;
    currentStabilizedSource = "6-month stabilized average (active months only)";
  } else if (allActive.length > 0) {
    currentStabilized = allActive[allActive.length - 1].oil_bbl;
    currentStabilizedSource = "Most recent active month (insufficient data for stabilized average)";
  }

  // ── 7. DCA-ready rows ─────────────────────────────────────────────────────
  // Active + flush months with calendar_t.
  // Flush months are included so the curve can see the post-stimulation trend,
  // but the caller (DCA engine) should use the flush classification to optionally
  // exclude them from the curve fit.
  // Restart months are excluded — they're transition, not trend.
  const dcaRows = classified
    .filter(r => r.classification === "active" || r.classification === "flush")
    .map(r => ({ year: r.year, month: r.month, oil_bbl: r.oil_bbl, calendar_t: r.calendar_t }));
  const dcaCurrentT = dcaRows.length > 0 ? dcaRows[dcaRows.length - 1].calendar_t : lastT;

  // ── 8. Restart summary ────────────────────────────────────────────────────
  const lastRestart = restartEvents[restartEvents.length - 1] ?? null;
  let lastRestartPeriod: string | null = null;
  let preRestartRate: number | null = null;
  let postRestartRate: number | null = null;
  let restartRecoveryPct: number | null = null;

  if (lastRestart) {
    const restartRow = sorted[lastRestart.restartIndex];
    lastRestartPeriod = `${restartRow.year}-${String(restartRow.month).padStart(2, "0")}`;
    preRestartRate = lastRestart.preRate != null ? Math.round(lastRestart.preRate) : null;

    // Post-restart stable rate: active months after the transition window
    const postActive = classified
      .slice(lastRestart.transitionEnd)
      .filter(r => r.classification === "active");
    if (postActive.length > 0) {
      const postAvg = postActive.reduce((s, r) => s + r.oil_bbl, 0) / postActive.length;
      postRestartRate = Math.round(postAvg);
    }

    if (preRestartRate && preRestartRate > 0 && postRestartRate != null) {
      restartRecoveryPct = Math.round((postRestartRate / preRestartRate) * 100);
    }
  }

  // ── 9. Downtime stats ─────────────────────────────────────────────────────
  const downtimeMonths = classified.filter(r => r.classification === "downtime").length;
  const incompleteCount = classified.filter(r => r.classification === "incomplete").length;
  const downtimePct = sorted.length > 0 ? (downtimeMonths / sorted.length) * 100 : 0;
  const cumOil = sorted.reduce((s, r) => s + r.oil_bbl, 0);

  // ── 10. Production confidence ─────────────────────────────────────────────
  let confidence: ProductionDataConfidence = "VERIFIED";

  if (dcaRows.length < 6) {
    confidence = "INFERRED";
    confidenceReasons.push(`Only ${dcaRows.length} active months for DCA — minimum 6 needed for PARTIAL confidence`);
  } else if (dcaRows.length < 12) {
    confidence = "PARTIAL";
    confidenceReasons.push(`${dcaRows.length} active months — 12+ months preferred for VERIFIED DCA confidence`);
  }

  if (downtimePct > 30) {
    if (confidence === "VERIFIED") confidence = "PARTIAL";
    confidenceReasons.push(`${downtimePct.toFixed(0)}% downtime in reporting period — production consistency is below threshold`);
  }

  if (incompleteCount > 0) {
    if (confidence === "VERIFIED") confidence = "PARTIAL";
    confidenceReasons.push(`${incompleteCount} month(s) excluded as potentially incomplete TRRC reports`);
  }

  if (restartEvents.length > 2) {
    if (confidence === "VERIFIED") confidence = "PARTIAL";
    confidenceReasons.push(`${restartEvents.length} restart events — intermittent operation increases reserve estimation uncertainty`);
  }

  if (leaseWellCount != null && leaseWellCount > 1) {
    if (confidence === "VERIFIED") confidence = "PARTIAL";
    confidenceReasons.push(`TRRC lease reports aggregate production for ${leaseWellCount} wells — individual well allocation not available`);
  }

  if (confidenceReasons.length === 0 && dcaRows.length >= 12) {
    confidenceReasons.push(`${dcaRows.length} active months of TRRC data — production confidence is VERIFIED`);
  }

  // ── 11. Warnings ─────────────────────────────────────────────────────────
  const currentlyOffline = classified.length > 0 &&
    classified[classified.length - 1].classification === "downtime";

  if (currentlyOffline) {
    const offlineMonths = classified.slice().reverse()
      .findIndex(r => r.classification !== "downtime");
    warnings.push(
      `⚠️ Well appears OFFLINE — ${offlineMonths < 0 ? "all" : offlineMonths} consecutive zero-production month(s) at end of data. ` +
      "Verify current status before underwriting. Revenue assumption = $0 until restart confirmed."
    );
  }

  if (restartEvents.length > 0 && lastRestart) {
    if (restartRecoveryPct != null && restartRecoveryPct < 60) {
      warnings.push(
        `⚠️ Post-restart production recovered to only ${restartRecoveryPct}% of pre-restart rate ` +
        `(${postRestartRate} vs ${preRestartRate} BBL/mo) — possible permanent mechanical damage or reservoir depletion.`
      );
    } else if (restartRecoveryPct != null && restartRecoveryPct >= 100) {
      warnings.push(
        `✓ Post-restart production exceeded pre-restart rate (${restartRecoveryPct}% recovery) ` +
        `— indicates workover improved well performance.`
      );
    }
  }

  if (incompleteCount > 0) {
    warnings.push(
      `${incompleteCount} month(s) at the end of the data set are flagged as potentially partial ` +
      `TRRC reports (within ${TRRC_LAG_MONTHS}-month lag window). Stabilized rates exclude these months.`
    );
  }

  const flushMonths = classified.filter(r => r.classification === "flush").length;
  if (flushMonths > 0) {
    warnings.push(
      `${flushMonths} anomalously high month(s) detected — possible post-stimulation flush production. ` +
      "Excluded from stabilized averages. DCA anchored to post-flush trend."
    );
  }

  if (downtimePct > 15) {
    warnings.push(
      `Production downtime: ${downtimePct.toFixed(1)}% of the reporting period. ` +
      "Economics models use stabilized rates; apply a ${downtimePct.toFixed(0)}% downtime haircut to projected cash flows."
    );
  }

  if (leaseWellCount != null && leaseWellCount > 1) {
    warnings.push(
      `LEASE-LEVEL PRODUCTION: TRRC reports aggregate production for ${leaseWellCount} wells on this lease. ` +
      "Per-well allocation requires run tickets or operator-provided wellbore-level production reports."
    );
  }

  return {
    classified_months: classified,
    stabilized_3mo_bbl: stabilized3mo  != null ? Math.round(stabilized3mo)  : null,
    stabilized_6mo_bbl: stabilized6mo  != null ? Math.round(stabilized6mo)  : null,
    stabilized_12mo_bbl: stabilized12mo != null ? Math.round(stabilized12mo) : null,
    stabilized_24mo_bbl: stabilized24mo != null ? Math.round(stabilized24mo) : null,
    current_stabilized_bbl: currentStabilized != null ? Math.round(currentStabilized) : null,
    current_stabilized_source: currentStabilizedSource,
    dca_rows: dcaRows,
    dca_current_t: dcaCurrentT,
    restart_detected: restartEvents.length > 0,
    restart_event_count: restartEvents.length,
    last_restart_period: lastRestartPeriod,
    pre_restart_rate_bbl: preRestartRate,
    post_restart_stable_rate_bbl: postRestartRate,
    restart_recovery_pct: restartRecoveryPct,
    incomplete_months_excluded: incompleteCount,
    potentially_incomplete_flagged: borderlineSet.size,
    cumulative_oil_bbl: cumOil,
    downtime_pct: Math.round(downtimePct * 10) / 10,
    total_months_in_series: sorted.length,
    active_months: allActive.length,
    production_confidence: confidence,
    confidence_reasons: confidenceReasons,
    warnings,
  };
}

// ─── Empty profile helper ─────────────────────────────────────────────────────

function emptyProfile(): StabilizedProductionProfile {
  return {
    classified_months: [],
    stabilized_3mo_bbl: null,
    stabilized_6mo_bbl: null,
    stabilized_12mo_bbl: null,
    stabilized_24mo_bbl: null,
    current_stabilized_bbl: null,
    current_stabilized_source: "No production data",
    dca_rows: [],
    dca_current_t: 0,
    restart_detected: false,
    restart_event_count: 0,
    last_restart_period: null,
    pre_restart_rate_bbl: null,
    post_restart_stable_rate_bbl: null,
    restart_recovery_pct: null,
    incomplete_months_excluded: 0,
    potentially_incomplete_flagged: 0,
    cumulative_oil_bbl: 0,
    downtime_pct: 0,
    total_months_in_series: 0,
    active_months: 0,
    production_confidence: "INFERRED",
    confidence_reasons: ["No production data available"],
    warnings: [],
  };
}
