/**
 * Arps Decline Curve Analysis (DCA) Engine
 *
 * Fits exponential, hyperbolic, and harmonic decline models to historical
 * monthly production data and selects the best-fit model.
 *
 * References: Arps (1945), SPE-9292
 */

export type ArpsModel = {
  type: "exponential" | "hyperbolic" | "harmonic";
  qi: number;        // initial rate (BBL/month) at t=0 of the fitted window
  Di: number;        // nominal decline rate per month (fractional, positive = declining)
  b: number;         // Arps b-factor (0=exponential, 1=harmonic, between=hyperbolic)
  r_squared: number; // coefficient of determination (0–1)
  sse: number;       // sum of squared errors
};

export type DcaResult = {
  model: ArpsModel;
  decline_rate_monthly_pct: number;   // effective monthly decline %
  decline_rate_annual_pct: number;    // effective annual decline %
  eur_bbl: number;                    // estimated ultimate recovery to economic limit
  remaining_reserves_bbl: number;     // EUR minus historical cumulative
  economic_life_months: number;       // months until economic limit from today

  /**
   * Instantaneous nominal decline rate at the end of the production history.
   *
   * For exponential: same as model.Di.
   * For hyperbolic/harmonic: Di / (1 + b·Di·t_current) — declines over time.
   *
   * ALWAYS use this (not model.Di) as the forward-projection decline rate.
   * Using model.Di (the t=0 rate) overstates future decline speed by up to 3×
   * for mature hyperbolic wells, compressing offer ranges incorrectly.
   */
  effective_Di_at_current: number;

  // 60-month forward projection from current date (uses terminal-decline-switch curve)
  projections: { month: number; rate_bbl: number }[];

  // Probabilistic remaining reserves (parameter variation on Di)
  // P90 = conservative (Di × 1.5), P50 = base case, P10 = optimistic (Di × 0.65)
  // Industry-standard for SEC-methodology probabilistic reserve estimation.
  p10_remaining_bbl: number;
  p50_remaining_bbl: number;
  p90_remaining_bbl: number;

  // Input data stats
  months_of_data: number;
  avg_12mo_bbl: number;
  avg_6mo_bbl: number;
  peak_bbl: number;
  current_bbl: number;
  cum_oil_bbl: number;
};

// ─── Arps rate equations ──────────────────────────────────────────────────────

function expRate(qi: number, Di: number, t: number): number {
  return qi * Math.exp(-Di * t);
}

function hypRate(qi: number, Di: number, b: number, t: number): number {
  if (b <= 0.001) return expRate(qi, Di, t);
  const denom = Math.pow(1 + b * Di * t, 1 / b);
  return denom > 0 ? qi / denom : 0;
}

function harmRate(qi: number, Di: number, t: number): number {
  return qi / (1 + Di * t);
}

// ─── R² and SSE helpers ───────────────────────────────────────────────────────

function calcSseR2(
  observed: number[],
  predicted: number[],
): { sse: number; r_squared: number } {
  const mean = observed.reduce((s, v) => s + v, 0) / observed.length;
  let sst = 0, sse = 0;
  for (let i = 0; i < observed.length; i++) {
    sst += Math.pow(observed[i] - mean, 2);
    sse += Math.pow(observed[i] - (predicted[i] ?? 0), 2);
  }
  const r_squared = sst > 0 ? Math.max(0, 1 - sse / sst) : 0;
  return { sse, r_squared };
}

// ─── Exponential fit via log-linear regression ────────────────────────────────

function fitExponential(
  rates: number[],
  times: number[],
): ArpsModel {
  // ln(q) = ln(qi) - Di*t
  const logRates = rates.map(r => Math.log(Math.max(r, 0.01)));
  const n = rates.length;
  const sumT  = times.reduce((s, t) => s + t, 0);
  const sumLQ = logRates.reduce((s, v) => s + v, 0);
  const sumTT = times.reduce((s, t) => s + t * t, 0);
  const sumTLQ = times.reduce((s, t, i) => s + t * logRates[i], 0);

  const denom = n * sumTT - sumT * sumT;
  let Di = 0, qi = 1;
  if (Math.abs(denom) > 1e-10) {
    const slope = (n * sumTLQ - sumT * sumLQ) / denom;
    const intercept = (sumLQ - slope * sumT) / n;
    Di  = -slope;
    qi  = Math.exp(intercept);
  } else {
    qi = rates[0];
    Di = 0.001;
  }

  Di = Math.max(Di, 0.0001);
  qi = Math.max(qi, 0.1);

  const predicted = times.map(t => expRate(qi, Di, t));
  const { sse, r_squared } = calcSseR2(rates, predicted);

  return { type: "exponential", qi, Di, b: 0, r_squared, sse };
}

// ─── Hyperbolic fit via joint (qi, Di) gradient descent for each b ───────────
//
// qi is a FREE parameter — not hardcoded to rates[0].
// Fixing qi to rates[0] is a common shortcut but causes large errors when the
// first month is a flush event, a TRRC partial report, or a post-workover spike.
// Jointly optimizing qi and Di via coordinate gradient descent is robust to this.

function fitHyperbolic(
  rates: number[],
  times: number[],
): ArpsModel {
  const bCandidates = [0.3, 0.5, 0.8, 1.0, 1.2, 1.5];
  let best: ArpsModel | null = null;

  const ratesMean = rates.reduce((s, v) => s + v, 0) / rates.length;

  for (const b of bCandidates) {
    // Initialize qi at the geometric mean of the first 3 rates (more stable than rates[0])
    // Di initialized from a rough log-decline estimate
    const earlyRates = rates.slice(0, Math.min(3, rates.length));
    let qi = Math.max(
      earlyRates.reduce((p, v) => p * v, 1) ** (1 / earlyRates.length),
      ratesMean * 0.5,
    );
    let Di = 0.05;

    const learningRateQi = 0.005;
    const learningRateDi = 0.01;

    for (let iter = 0; iter < 80; iter++) {
      const predicted = times.map(t => hypRate(qi, Di, b, t));
      const eps = 1e-6;

      // Numerical gradients on both qi and Di
      const predQiP = times.map(t => hypRate(qi + qi * eps + 1e-4, Di, b, t));
      const predDiP = times.map(t => hypRate(qi, Di + Di * eps + 1e-6, b, t));
      const predDiM = times.map(t => hypRate(qi, Math.max(Di - Di * eps - 1e-6, 1e-6), b, t));

      let gradQi = 0, gradDi = 0;
      for (let i = 0; i < rates.length; i++) {
        const err = predicted[i] - rates[i];
        gradQi += 2 * err * (predQiP[i] - predicted[i]) / (qi * eps + 1e-4);
        gradDi += 2 * err * (predDiP[i] - predDiM[i]) / (2 * (Di * eps + 1e-6));
      }
      const n = rates.length;
      qi -= learningRateQi * gradQi / n;
      Di -= learningRateDi * gradDi / n;
      qi = Math.max(qi, 0.1);
      Di = Math.max(Di, 0.0001);
    }

    const predicted = times.map(t => hypRate(qi, Di, b, t));
    const { sse, r_squared } = calcSseR2(rates, predicted);

    // Penalise b > 1.2 to avoid over-fitting (industry standard)
    const penalty = b > 1.2 ? sse * (1 + (b - 1.2) * 0.5) : sse;

    if (!best || penalty < best.sse) {
      best = { type: "hyperbolic", qi, Di, b, r_squared, sse };
    }
  }

  return best!;
}

// ─── Harmonic fit (b = 1 specialisation) ─────────────────────────────────────

function fitHarmonic(
  rates: number[],
  times: number[],
): ArpsModel {
  // q = qi / (1 + Di*t)  →  1/q = 1/qi + Di/qi * t
  const invRates = rates.map(r => 1 / Math.max(r, 0.01));
  const n = rates.length;
  const sumT   = times.reduce((s, t) => s + t, 0);
  const sumIR  = invRates.reduce((s, v) => s + v, 0);
  const sumTT  = times.reduce((s, t) => s + t * t, 0);
  const sumTIR = times.reduce((s, t, i) => s + t * invRates[i], 0);

  const denom = n * sumTT - sumT * sumT;
  let Di = 0.05, qi = rates[0];
  if (Math.abs(denom) > 1e-10) {
    const slope     = (n * sumTIR - sumT * sumIR) / denom;
    const intercept = (sumIR - slope * sumT) / n;
    qi = Math.max(1 / Math.max(intercept, 1e-6), 0.1);
    Di = Math.max(slope * qi, 0.0001);
  }

  const predicted = times.map(t => harmRate(qi, Di, t));
  const { sse, r_squared } = calcSseR2(rates, predicted);
  return { type: "harmonic", qi, Di, b: 1, r_squared, sse };
}

// ─── Terminal decline constants ───────────────────────────────────────────────

/**
 * Nominal monthly decline rate at which we switch a hyperbolic/harmonic model
 * to exponential terminal decline.
 *
 * Industry standard (SPE): switch when Di_instantaneous falls to 5–10% annual
 * nominal. We use 8% annual = 0.00667/month — the practical industry midpoint.
 *
 * Using 5% annual is too conservative: when a well is still producing 20–30 BBL/month
 * at the switch point, a 5% annual terminal decline still projects 300+ months to
 * reach the 5-BBL economic limit — an unrealistically slow tail.
 *
 * Without this switch (no terminal limit):
 *   b=1.5, Di=0.10/month, qi=200 BBL → economic life ≈ 1,600 months (130 years)
 * With 8% annual terminal switch:
 *   same parameters → economic life ≈ 300–350 months (25–30 years) — realistic
 */
const TERMINAL_DI_MONTHLY = 0.006667; // 8% annual nominal / 12

/**
 * Compute the instantaneous nominal decline rate for a hyperbolic/harmonic model
 * at elapsed calendar time t.
 *   D_inst(t) = Di / (1 + b·Di·t)
 * For exponential (b≈0): D_inst = Di (constant).
 */
function instantaneousDi(Di: number, b: number, t: number): number {
  if (b <= 0.001) return Di;
  return Di / (1 + b * Di * t);
}

/**
 * Compute the elapsed time at which the instantaneous decline equals TERMINAL_DI.
 * Returns Infinity if Di is already ≤ TERMINAL_DI (no switch needed).
 *   t_sw = (Di/TERMINAL_DI - 1) / (b·Di)
 */
function terminalSwitchTime(Di: number, b: number): number {
  if (b <= 0.001 || Di <= TERMINAL_DI_MONTHLY) return Infinity;
  return (Di / TERMINAL_DI_MONTHLY - 1) / (b * Di);
}

/**
 * Rate at terminal switch time (the starting rate for the exponential terminal leg).
 */
function rateAtSwitchTime(model: ArpsModel, t_sw: number): number {
  if (model.type === "exponential") return expRate(model.qi, model.Di, t_sw);
  if (model.type === "harmonic")   return harmRate(model.qi, model.Di, t_sw);
  return hypRate(model.qi, model.Di, model.b, t_sw);
}

/**
 * Evaluate the rate at time t, applying the terminal decline switch.
 *
 * Before t_sw: use the original model (exp / hyp / harmonic).
 * At or after t_sw: exponential decline from q(t_sw) at TERMINAL_DI.
 */
function rateWithTerminalSwitch(model: ArpsModel, t_sw: number, q_sw: number, t: number): number {
  if (t < t_sw) {
    if (model.type === "exponential") return expRate(model.qi, model.Di, t);
    if (model.type === "harmonic")   return harmRate(model.qi, model.Di, t);
    return hypRate(model.qi, model.Di, model.b, t);
  }
  // Exponential terminal decline from q_sw
  return q_sw * Math.exp(-TERMINAL_DI_MONTHLY * (t - t_sw));
}

// ─── EUR integration ──────────────────────────────────────────────────────────

function calcEur(
  model: ArpsModel,
  startT: number,
  economicLimit: number,
  maxMonths = 600,
): { eur: number; lifeMonths: number } {
  const t_sw = terminalSwitchTime(model.Di, model.b);
  const q_sw = isFinite(t_sw) ? rateAtSwitchTime(model, t_sw) : 0;

  let cum = 0;
  for (let i = 0; i < maxMonths; i++) {
    const t = startT + i;
    const q = rateWithTerminalSwitch(model, t_sw, q_sw, t);
    if (q < economicLimit) return { eur: cum, lifeMonths: i };
    cum += q;
  }
  return { eur: cum, lifeMonths: maxMonths };
}

// ─── Effective decline rate conversion ───────────────────────────────────────

function nominalToEffectiveMonthly(Di: number, b: number): number {
  if (b <= 0.001) {
    // Exponential: effective = 1 - e^(-Di)
    return (1 - Math.exp(-Di)) * 100;
  }
  // Hyperbolic / harmonic: effective monthly decline at t=0
  return (1 - Math.pow(1 + b * Di, -1 / b)) * 100;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run Arps DCA on monthly production rows.
 *
 * Accepts rows with an optional `calendar_t` field. When present, calendar_t
 * (months elapsed from the first row in the original full series) is used as
 * the time axis. This correctly models calendar gaps — shut-in periods expand
 * the time axis instead of being silently removed, preventing artificially
 * steepened decline rates.
 *
 * Without calendar_t, falls back to sequential 0-indexed time (legacy behaviour).
 * Use the production-engine.ts `dca_rows` output for calendar-correct inputs.
 */
export function runDca(
  monthlyRows: { year: number; month: number; oil_bbl: number; calendar_t?: number }[],
  economicLimitBbl = 5,
): DcaResult | null {
  // Sort chronologically and filter to positive months
  const sorted = [...monthlyRows].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );
  const positive = sorted.filter(r => r.oil_bbl > 0);

  if (positive.length < 3) return null;

  const rates = positive.map(r => r.oil_bbl);
  // Use calendar_t when available (preserves gaps) — otherwise use sequential index
  const hasCalendarT = positive.every(r => r.calendar_t != null);
  const rawTimes = hasCalendarT
    ? positive.map(r => r.calendar_t!)
    : positive.map((_, i) => i);
  // Normalize times to start at 0 so qi is the initial rate at the start of the fit window
  const t0 = rawTimes[0];
  const times = rawTimes.map(t => t - t0);

  // Fit all three model families
  const expModel  = fitExponential(rates, times);
  const hypModel  = fitHyperbolic(rates, times);
  const harmModel = fitHarmonic(rates, times);

  // Select best by SSE (hyperbolic already penalised for b>1.2)
  const best = [expModel, hypModel, harmModel].reduce((a, b) =>
    a.sse <= b.sse ? a : b,
  );

  // Stats from input data
  const last12 = positive.slice(-12);
  const last6  = positive.slice(-6);
  const avg12  = last12.reduce((s, r) => s + r.oil_bbl, 0) / last12.length;
  const avg6   = last6.reduce((s, r) => s + r.oil_bbl, 0) / last6.length;
  const peak   = Math.max(...rates);
  const current = rates[rates.length - 1];
  const cum     = sorted.reduce((s, r) => s + r.oil_bbl, 0);

  // How far along the decline curve are we?
  const currentT = times[times.length - 1];

  // EUR from current time forward (with terminal decline switch)
  const { eur, lifeMonths } = calcEur(best, currentT, economicLimitBbl);
  const remaining = Math.max(eur, 0);

  // Probabilistic remaining reserves via Di perturbation (SEC standard approach)
  const { eur: eurP90 } = calcEur({ ...best, Di: best.Di * 1.5  }, currentT, economicLimitBbl);
  const { eur: eurP10 } = calcEur({ ...best, Di: best.Di * 0.65 }, currentT, economicLimitBbl);

  // Decline rate — report the EFFECTIVE rate (at t=0 of the fit window for display)
  const effectiveMonthlyPct = nominalToEffectiveMonthly(best.Di, best.b);
  const effectiveAnnualPct  = (1 - Math.pow(1 - effectiveMonthlyPct / 100, 12)) * 100;

  // Instantaneous nominal Di at the current end of history.
  // This is the correct decline rate to pass to the economics engine for forward projections.
  // Using model.Di (the t=0 historical rate) would overstate future decline speed
  // by up to 3× for mature hyperbolic wells.
  const effectiveDiAtCurrent = instantaneousDi(best.Di, best.b, currentT);

  // 60-month projections from current date — use terminal-decline-switch curve
  const t_sw = terminalSwitchTime(best.Di, best.b);
  const q_sw = isFinite(t_sw) ? rateAtSwitchTime(best, t_sw) : 0;
  const projections: { month: number; rate_bbl: number }[] = [];
  for (let i = 1; i <= 60; i++) {
    const t = currentT + i;
    const q = rateWithTerminalSwitch(best, t_sw, q_sw, t);
    projections.push({ month: i, rate_bbl: Math.max(0, q) });
  }

  return {
    model: best,
    decline_rate_monthly_pct:  Math.round(effectiveMonthlyPct * 100) / 100,
    decline_rate_annual_pct:   Math.round(effectiveAnnualPct * 100) / 100,
    eur_bbl:                   Math.round(eur + cum),
    remaining_reserves_bbl:    Math.round(remaining),
    economic_life_months:      lifeMonths,
    effective_Di_at_current:   effectiveDiAtCurrent,
    projections,
    p10_remaining_bbl: Math.round(Math.max(eurP10, 0)),
    p50_remaining_bbl: Math.round(remaining),
    p90_remaining_bbl: Math.round(Math.max(eurP90, 0)),
    months_of_data: positive.length,
    avg_12mo_bbl:   Math.round(avg12 * 10) / 10,
    avg_6mo_bbl:    Math.round(avg6 * 10) / 10,
    peak_bbl:       peak,
    current_bbl:    current,
    cum_oil_bbl:    cum,
  };
}
