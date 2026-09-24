/**
 * Arps decline-curve analysis — the standard petroleum-engineering method for
 * estimating EUR (estimated ultimate recovery) and remaining reserves from a
 * production history:
 *
 *   Hyperbolic (0 < b <= 2):  q(t) = qi / (1 + b*Di*t)^(1/b)
 *   Exponential (b = 0):      q(t) = qi * exp(-Di*t)
 *
 * where qi = initial rate, Di = initial nominal decline rate (per month), b =
 * decline exponent (curvature). This module fits qi/Di/b to actual monthly
 * production, then integrates the fitted curve forward to a terminal rate to
 * get EUR.
 *
 * IMPORTANT CAVEAT, surfaced everywhere this is used: TRRC's public
 * production records are LEASE-level (allocated across every well on the
 * lease), not certified single-well data. This is a screening-grade
 * estimate from public regulatory filings, not a reserves report prepared
 * under SEC/SPE definitions — it does not replace a reservoir engineer's
 * certified evaluation.
 */

export interface DeclineCurveFit {
  qi: number;              // fitted initial rate, BBL/month
  di: number;               // fitted nominal decline rate, fraction/month
  b: number;                // hyperbolic exponent, 0 (exponential) to 2
  diAnnualPct: number;      // di expressed as an annual effective decline %, for readability — this is the INITIAL (t=0) rate
  // Effective annual decline measured from the LAST real data point forward
  // 12 months, i.e. D(t) = Di/(1+b*Di*t) evaluated at today, not t=0. For a
  // hyperbolic well (b>0) several years into its life this is meaningfully
  // lower than diAnnualPct — using the t=0 rate for a mature well
  // overstates how fast it will keep declining from here.
  currentAnnualDeclinePct: number;
  rSquared: number;         // goodness of fit, 0-1
  monthsOfHistory: number;
  classification: "Steep early-life (unconventional horizontal)" | "Moderate" | "Flattening / late-life" | "Insufficient data";
}

export interface EurEstimate {
  cumulativeToDate: number;      // BBL produced so far (sum of actual history)
  forecastRemaining: number;     // BBL forecast from last data point to terminal rate
  eur: number;                   // cumulativeToDate + forecastRemaining
  remainingReserves: number;     // = forecastRemaining (kept as a distinct, named field for report clarity)
  monthsToTerminal: number;      // months from last data point until the terminal rate is reached
  terminalRateBblPerMonth: number;
  economicLifeYears: number;     // monthsToTerminal / 12
}

const TERMINAL_RATE_BBL_PER_MONTH = 150; // ~5 BBL/day, a common stripper-well economic limit
export const MAX_FORECAST_MONTHS = 480;         // 40-year cap so a near-flat fit can't forecast forever
const TERMINAL_DECLINE_RATE_PER_MONTH = 0.08 / 12; // 8%/year — common for tight/unconventional reservoirs, converges faster than the looser 6%/year convention

/**
 * Fits qi/Di for a FIXED b via linear regression in transformed space:
 *   b > 0:  q(t)^-b = qi^-b + qi^-b * b * Di * t         (linear in t)
 *   b = 0:  ln(q(t)) = ln(qi) - Di * t                     (linear in t)
 * Returns the fit and its R² (computed in real, untransformed q-space so
 * different b values are comparable on the same footing).
 */
function fitForFixedB(months: number[], rates: number[], b: number): { qi: number; di: number; sse: number } | null {
  const n = months.length;
  if (n < 2) return null;

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    const t = months[i];
    const q = rates[i];
    const y = b === 0 ? Math.log(q) : Math.pow(q, -b);
    sumX += t; sumY += y; sumXY += t * y; sumXX += t * t;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  let qi: number, di: number;
  if (b === 0) {
    qi = Math.exp(intercept);
    di = -slope;
  } else {
    if (intercept <= 0) return null;
    qi = Math.pow(intercept, -1 / b);
    di = slope / (intercept * b);
  }
  if (!isFinite(qi) || !isFinite(di) || qi <= 0 || di <= 0) return null;

  // SSE in real q-space for fair comparison across b values
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const predicted = b === 0
      ? qi * Math.exp(-di * months[i])
      : qi * Math.pow(1 + b * di * months[i], -1 / b);
    sse += (rates[i] - predicted) ** 2;
  }
  return { qi, di, sse };
}

/**
 * Fits an Arps decline curve to a monthly oil-production series (BBL/month,
 * chronological order, oldest first). Grid-searches b (the parameter with
 * no closed-form solution) and does an exact linear-regression fit for
 * qi/Di at each candidate b.
 */
/**
 * Lease production is the sum of every well on the lease, so drilling an
 * infill well is a step change in the series, not a decline. Fitting Arps
 * across that step describes a well set that no longer exists and usually
 * produces no valid fit at all.
 *
 * Live case (CMC Buttercup 25-37 Unit, lease 59990, 2026-09-22): 34 reported
 * months ramp to ~41,000 BBL/mo, jump to 155,023 when new wells come online,
 * then decline cleanly for 20 months. The full series yields NO fit; the
 * post-step window fits at R2 = 0.99 (b = 0.7, 39.3%/yr current decline).
 * Every economics section read "insufficient data" for a well with a textbook
 * decline in it.
 *
 * This finds the most recent step change and returns the window after it.
 * Deliberately conservative: a series that already fits is left exactly as it
 * was, and a window is only adopted when it produces no-fit-to-fit or a
 * materially better fit. The window is always reported so the narrowed basis
 * is disclosed, never silent.
 */
const STEP_FACTOR = 1.8;             // a step must be this multiple of the recent level
const MIN_WINDOW_MONTHS = 8;         // months required after the step to fit it
const MATERIAL_R2_GAIN = 0.15;       // windowed fit must beat the full fit by this

export interface DeclineFitWindow {
  fit: DeclineCurveFit | null;
  startIndex: number;                // index into the supplied series
  monthsExcluded: number;
  reason: string | null;             // disclosure text when a window was applied
}

function qualifiesAsStep(monthly: number[], i: number): boolean {
  const value = monthly[i];
  if (!(value > 0)) return false;
  const prior = monthly.slice(Math.max(0, i - 3), i).filter(v => v > 0);
  if (prior.length === 0) return false;
  const priorLevel = prior.reduce((a, b) => a + b, 0) / prior.length;
  return priorLevel > 0 && value >= STEP_FACTOR * priorLevel;
}

function lastStepChangeIndex(monthly: number[]): number | null {
  for (let i = monthly.length - MIN_WINDOW_MONTHS; i >= 1; i--) {
    if (!qualifiesAsStep(monthly, i)) continue;
    // The three-month averaging window straddles the step, so the month
    // AFTER a peak can also clear the threshold. Walk back through the
    // contiguous qualifying run to the peak itself — that is the month the
    // new wells actually came online, and the correct forecast anchor.
    let peak = i;
    while (peak > 1 && qualifiesAsStep(monthly, peak - 1) && monthly[peak - 1] > monthly[peak]) peak--;
    return peak;
  }
  return null;
}

export function fitArpsDeclineWindowed(monthly: number[]): DeclineFitWindow {
  const full = fitArpsDecline(monthly);
  const step = lastStepChangeIndex(monthly);
  if (step === null) return { fit: full, startIndex: 0, monthsExcluded: 0, reason: null };

  const windowed = fitArpsDecline(monthly.slice(step));
  if (!windowed) return { fit: full, startIndex: 0, monthsExcluded: 0, reason: null };

  const better = full === null || windowed.rSquared >= full.rSquared + MATERIAL_R2_GAIN;
  if (!better) return { fit: full, startIndex: 0, monthsExcluded: 0, reason: null };

  return {
    fit: windowed,
    startIndex: step,
    monthsExcluded: step,
    reason: `Decline fit to the ${monthly.length - step} months since a production step change (reported volumes rose ${(monthly[step] / (monthly.slice(Math.max(0, step - 3), step).filter(v => v > 0).reduce((a, b) => a + b, 0) / Math.max(1, monthly.slice(Math.max(0, step - 3), step).filter(v => v > 0).length))).toFixed(1)}x), consistent with additional wells reporting on this lease. The ${step} earlier month(s) describe a different set of wells and are excluded from the forecast, not from the record.`,
  };
}

export function fitArpsDecline(monthlyOilBbl: number[]): DeclineCurveFit | null {
  // Ignore zero-rate observations in the logarithmic fit without compressing
  // calendar time. A currently shut-in series cannot establish a restart rate.
  if (monthlyOilBbl.some(v => !Number.isFinite(v) || v < 0) || !monthlyOilBbl.length || monthlyOilBbl[monthlyOilBbl.length - 1] === 0) return null;
  const points = monthlyOilBbl.map((q, t) => ({q, t})).filter(p => p.q > 0);
  const cleaned = points.map(p => p.q);
  if (cleaned.length < 6) return null;
  const months = points.map(p => p.t);
  const totalSumSq = cleaned.reduce((s, q) => {
    const mean = cleaned.reduce((a, b) => a + b, 0) / cleaned.length;
    return s + (q - mean) ** 2;
  }, 0);

  let best: { qi: number; di: number; b: number; sse: number } | null = null;
  for (let bCandidate = 0; bCandidate <= 2.0001; bCandidate += 0.05) {
    const b = Math.round(bCandidate * 100) / 100;
    const fit = fitForFixedB(months, cleaned, b);
    if (fit && (!best || fit.sse < best.sse)) {
      best = { qi: fit.qi, di: fit.di, b, sse: fit.sse };
    }
  }
  if (!best) return null;

  const rSquared = totalSumSq > 0 ? Math.max(0, 1 - best.sse / totalSumSq) : 0;
  const diAnnualPct = best.b === 0
    ? (1 - Math.exp(-best.di * 12)) * 100
    : (1 - Math.pow(1 + best.b * best.di * 12, -1 / best.b)) * 100;

  // Effective annual decline starting from the LAST real month, not t=0 —
  // q(t+12)/q(t) rather than the initial-rate formula above. For b=0
  // (exponential) these are identical, since nominal decline is constant;
  // for b>0 the curve has already flattened by the last data point, so
  // this is meaningfully lower for a mature well.
  const lastMonthIdx = monthlyOilBbl.length - 1;
  const qAt = (t: number) => best.b === 0 ? best.qi * Math.exp(-best.di * t) : best.qi * Math.pow(1 + best.b * best.di * t, -1 / best.b);
  const qNow = qAt(lastMonthIdx);
  const currentAnnualDeclinePct = qNow > 0 ? (1 - qAt(lastMonthIdx + 12) / qNow) * 100 : diAnnualPct;

  const classification: DeclineCurveFit["classification"] =
    cleaned.length < 6 ? "Insufficient data"
    : diAnnualPct > 55 ? "Steep early-life (unconventional horizontal)"
    : diAnnualPct > 20 ? "Moderate"
    : "Flattening / late-life";

  return {
    qi: best.qi, di: best.di, b: best.b, diAnnualPct, currentAnnualDeclinePct, rSquared,
    monthsOfHistory: monthlyOilBbl.length, classification,
  };
}

/**
 * Trailing average of active (non-zero) months only — excludes downtime,
 * restart transition, and incomplete/zero TRRC reports, unlike a flat
 * trailing-N average that would be dragged down by those months. Distinct
 * from the fitted Arps qi (which is the curve's initial rate, not a
 * literal recent average) and from report-builder.ts's recent12AvgOil
 * (which does NOT exclude zero months).
 */
export function stabilizedRate(monthlySeries: number[], trailingActiveMonths = 3): number | null {
  const active = monthlySeries.filter(v => v > 0);
  if (active.length === 0) return null;
  const window = active.slice(-trailingActiveMonths);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

export interface MonthlyForecastPoint {
  monthIndex: number;   // months since the start of the fitted history (lastMonth+1, +2, ...)
  rate: number;         // forecast volume for that month, same units as the series fitArpsDecline was fit on
}

/**
 * Forecasts the fitted decline curve forward, monthly, from the last real
 * data point to a terminal economic rate. Shared by estimateEur (which
 * integrates this into a single EUR/remaining-reserves number) and the
 * economics module (which needs the actual month-by-month volumes to
 * compute monthly cash flow, not just the total).
 */
export function forecastToTerminalRate(fit: DeclineCurveFit, terminalRatePerMonth = TERMINAL_RATE_BBL_PER_MONTH): MonthlyForecastPoint[] {
  const { qi, di, b } = fit;
  const lastMonth = fit.monthsOfHistory - 1;
  const rateAt = (t: number) => b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b);
  // Instantaneous nominal decline rate of the hyperbolic curve at time t —
  // for b > 1 this approaches zero as t grows, which means pure hyperbolic
  // decline can take an unrealistically long time (or never) to reach a
  // terminal rate. Standard practice: once the instantaneous decline rate
  // falls to a terminal exponential rate (commonly ~6%/year), switch the
  // forecast to exponential decline from that point rather than continuing
  // the hyperbolic curve indefinitely.
  const instantaneousDeclineAt = (t: number) => b === 0 ? di : di / (1 + b * di * t);

  const points: MonthlyForecastPoint[] = [];
  let t = lastMonth;
  let monthsElapsed = 0;
  let rate = rateAt(t);
  let switchedToExponential = false;

  while (rate > terminalRatePerMonth && monthsElapsed < MAX_FORECAST_MONTHS) {
    t += 1;
    let nextRate: number;
    if (switchedToExponential) {
      nextRate = rate * Math.exp(-TERMINAL_DECLINE_RATE_PER_MONTH);
    } else if (instantaneousDeclineAt(t) <= TERMINAL_DECLINE_RATE_PER_MONTH) {
      switchedToExponential = true;
      nextRate = rate * Math.exp(-TERMINAL_DECLINE_RATE_PER_MONTH);
    } else {
      nextRate = rateAt(t);
    }
    points.push({ monthIndex: t, rate: nextRate });
    rate = nextRate;
    monthsElapsed += 1;
  }

  return points;
}

/**
 * Integrates the fitted decline curve forward (numerically, monthly steps)
 * from the last real data point to a terminal economic rate, to estimate
 * EUR and remaining reserves.
 */
export function estimateEur(fit: DeclineCurveFit, cumulativeToDateBbl: number): EurEstimate {
  const lastMonth = fit.monthsOfHistory - 1;
  const points = forecastToTerminalRate(fit, TERMINAL_RATE_BBL_PER_MONTH);

  let forecastRemaining = 0;
  let priorRate = (fit.b === 0 ? fit.qi * Math.exp(-fit.di * lastMonth) : fit.qi * Math.pow(1 + fit.b * fit.di * lastMonth, -1 / fit.b));
  for (const p of points) {
    forecastRemaining += (priorRate + p.rate) / 2; // trapezoidal integration, monthly steps
    priorRate = p.rate;
  }
  const monthsToTerminal = points.length;

  const eur = cumulativeToDateBbl + forecastRemaining;
  return {
    cumulativeToDate: cumulativeToDateBbl,
    forecastRemaining,
    eur,
    remainingReserves: forecastRemaining,
    monthsToTerminal,
    terminalRateBblPerMonth: TERMINAL_RATE_BBL_PER_MONTH,
    economicLifeYears: monthsToTerminal / 12,
  };
}
