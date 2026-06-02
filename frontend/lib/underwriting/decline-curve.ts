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

  // 60-month forward projection from current date
  projections: { month: number; rate_bbl: number }[];

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

// ─── Hyperbolic fit via grid search over b + Di ───────────────────────────────

function fitHyperbolic(
  rates: number[],
  times: number[],
): ArpsModel {
  const bCandidates = [0.3, 0.5, 0.8, 1.0, 1.2, 1.5];
  let best: ArpsModel | null = null;

  for (const b of bCandidates) {
    // For a given b, fit Di and qi via Levenberg-Marquardt (simplified Newton iterations)
    const qi0 = rates[0];
    let Di = 0.05;

    for (let iter = 0; iter < 50; iter++) {
      const predicted = times.map(t => hypRate(qi0, Di, b, t));
      const { sse } = calcSseR2(rates, predicted);

      // Numerical gradient on Di
      const eps = Di * 0.01 + 1e-6;
      const predP = times.map(t => hypRate(qi0, Di + eps, b, t));
      const predM = times.map(t => hypRate(qi0, Di - eps, b, t));
      let gradDi = 0;
      for (let i = 0; i < rates.length; i++) {
        const err = predicted[i] - rates[i];
        gradDi += 2 * err * (predP[i] - predM[i]) / (2 * eps);
      }
      Di -= 0.01 * gradDi / (rates.length || 1);
      Di = Math.max(Di, 0.0001);
    }

    const predicted = times.map(t => hypRate(qi0, Di, b, t));
    const { sse, r_squared } = calcSseR2(rates, predicted);

    // Penalise b > 1.2 to avoid over-fitting (industry standard)
    const penalty = b > 1.2 ? sse * (1 + (b - 1.2) * 0.5) : sse;

    if (!best || penalty < best.sse) {
      best = { type: "hyperbolic", qi: qi0, Di, b, r_squared, sse };
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

// ─── EUR integration ──────────────────────────────────────────────────────────

function calcEur(
  model: ArpsModel,
  startT: number,
  economicLimit: number,
  maxMonths = 600,
): { eur: number; lifeMonths: number } {
  let cum = 0;
  let t = startT;
  for (let i = 0; i < maxMonths; i++) {
    let q = 0;
    if (model.type === "exponential") q = expRate(model.qi, model.Di, t);
    else if (model.type === "harmonic") q = harmRate(model.qi, model.Di, t);
    else q = hypRate(model.qi, model.Di, model.b, t);
    if (q < economicLimit) return { eur: cum, lifeMonths: i };
    cum += q;
    t++;
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

  // EUR from current time forward
  const { eur, lifeMonths } = calcEur(best, currentT, economicLimitBbl);
  const remaining = Math.max(eur, 0);

  // Decline rate
  const effectiveMonthlyPct = nominalToEffectiveMonthly(best.Di, best.b);
  const effectiveAnnualPct  = (1 - Math.pow(1 - effectiveMonthlyPct / 100, 12)) * 100;

  // 60-month projections from current date (t = currentT, currentT+1, ...)
  const projections: { month: number; rate_bbl: number }[] = [];
  for (let i = 1; i <= 60; i++) {
    const t = currentT + i;
    let q = 0;
    if (best.type === "exponential") q = expRate(best.qi, best.Di, t);
    else if (best.type === "harmonic") q = harmRate(best.qi, best.Di, t);
    else q = hypRate(best.qi, best.Di, best.b, t);
    projections.push({ month: i, rate_bbl: Math.max(0, q) });
  }

  return {
    model: best,
    decline_rate_monthly_pct: Math.round(effectiveMonthlyPct * 100) / 100,
    decline_rate_annual_pct:  Math.round(effectiveAnnualPct * 100) / 100,
    eur_bbl:                  Math.round(eur + cum),
    remaining_reserves_bbl:   Math.round(remaining),
    economic_life_months:     lifeMonths,
    projections,
    months_of_data: positive.length,
    avg_12mo_bbl:   Math.round(avg12 * 10) / 10,
    avg_6mo_bbl:    Math.round(avg6 * 10) / 10,
    peak_bbl:       peak,
    current_bbl:    current,
    cum_oil_bbl:    cum,
  };
}
