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
  diAnnualPct: number;      // di expressed as an annual effective decline %, for readability
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
const MAX_FORECAST_MONTHS = 480;         // 40-year cap so a near-flat fit can't forecast forever
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
export function fitArpsDecline(monthlyOilBbl: number[]): DeclineCurveFit | null {
  // Drop leading/trailing zero or null-equivalent months (ramp-up, reporting
  // gaps) — Arps decline is only meaningful once a well is on a stabilized
  // decline trend, not during flowback/ramp-up.
  const cleaned = monthlyOilBbl.filter(v => v > 0);
  if (cleaned.length < 6) return null; // need a real trend to fit against

  const months = cleaned.map((_, i) => i);
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

  const classification: DeclineCurveFit["classification"] =
    cleaned.length < 6 ? "Insufficient data"
    : diAnnualPct > 55 ? "Steep early-life (unconventional horizontal)"
    : diAnnualPct > 20 ? "Moderate"
    : "Flattening / late-life";

  return {
    qi: best.qi, di: best.di, b: best.b, diAnnualPct, rSquared,
    monthsOfHistory: cleaned.length, classification,
  };
}

/**
 * Integrates the fitted decline curve forward (numerically, monthly steps)
 * from the last real data point to a terminal economic rate, to estimate
 * EUR and remaining reserves.
 */
export function estimateEur(fit: DeclineCurveFit, cumulativeToDateBbl: number): EurEstimate {
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

  let forecastRemaining = 0;
  let t = lastMonth;
  let monthsToTerminal = 0;
  let rate = rateAt(t);
  let switchedToExponential = false;

  while (rate > TERMINAL_RATE_BBL_PER_MONTH && monthsToTerminal < MAX_FORECAST_MONTHS) {
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
    forecastRemaining += (rate + nextRate) / 2; // trapezoidal integration, monthly steps
    rate = nextRate;
    monthsToTerminal += 1;
  }

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
