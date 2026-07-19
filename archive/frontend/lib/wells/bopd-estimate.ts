/**
 * NOTE: estimateMonthlyOilFromCumulative has been intentionally removed.
 *
 * Deriving a "current" monthly rate from cumulative production using a decline
 * multiplier is a mathematical estimate, not real production data. All BOPD
 * values shown in the app must come directly from state agency APIs.
 *
 * Real monthly production sources:
 *   Texas  → TRRC PDQ (/api/wells/production)
 *   Others → State GIS layers where a monthly/recent production field is
 *             returned directly (not derived).
 *
 * If no real monthly figure is available, latest_monthly_oil_bbl stays null
 * and the analysis cards will show "insufficient data" — which is honest.
 */

/** Whether a well status string indicates active production. */
export function isActiveStatus(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  if (/plug|abandon|inactiv|shut[- ]?in|p&a|pa\b/i.test(s)) return false;
  if (/activ|produc|inject|permit|drill|complet/i.test(s)) return true;
  return false;
}
