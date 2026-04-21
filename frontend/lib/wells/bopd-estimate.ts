/**
 * Estimates current monthly oil production (BBL) from cumulative totals.
 *
 * Uses an age-adjusted decline multiplier — not a reserve engineering calculation.
 * Returns null when the well is plugged/abandoned or has no cumulative data.
 * Tagged as estimated so callers can display appropriate disclaimers.
 */

export function estimateMonthlyOilFromCumulative(
  cumOilBbl: number | null,
  spudDate: string | null,
  status: string | null,
): number | null {
  if (!cumOilBbl || cumOilBbl <= 0) return null;

  // Don't estimate for inactive/plugged wells
  if (status && /plug|abandon|inactive|shut[- ]?in/i.test(status)) return null;

  // Months since spud — default 60 months (5 yrs) if spud date unknown
  let months = 60;
  if (spudDate) {
    const spudMs = new Date(spudDate).getTime();
    if (!isNaN(spudMs) && spudMs < Date.now()) {
      months = Math.max(6, Math.round((Date.now() - spudMs) / (30.44 * 24 * 3600 * 1000)));
    }
  }

  const avgMonthly = cumOilBbl / months;

  // Decline multiplier: current rate relative to historical average.
  // Based on exponential decline Di ≈ 1.5%/month (≈ 17% annual):
  //   current ≈ initial × e^(-Di×t), avg = initial × (1−e^(-Di×t))/(Di×t)
  //   → current/avg ≈ Di×t / (e^(Di×t)−1) × e^(-Di×t)
  // Simplified lookup by age bucket:
  let factor: number;
  if (months < 18)        factor = 1.40;  // early plateau / high initial
  else if (months < 36)   factor = 0.75;
  else if (months < 72)   factor = 0.45;
  else if (months < 120)  factor = 0.28;
  else if (months < 180)  factor = 0.18;
  else                     factor = 0.12;  // very mature

  const est = Math.round(avgMonthly * factor);
  if (est <= 0) return null;
  return Math.min(est, 3000); // cap at ~100 BOPD / well
}

/** Whether a well status string indicates active production. */
export function isActiveStatus(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  if (/plug|abandon|inactiv|shut[- ]?in|p&a|pa\b/i.test(s)) return false;
  if (/activ|produc|inject|permit|drill|complet/i.test(s)) return true;
  return false;
}
