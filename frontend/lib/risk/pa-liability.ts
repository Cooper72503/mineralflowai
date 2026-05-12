/**
 * P&A (Plug & Abandon) Liability Assessment
 *
 * Estimates plugging cost exposure from nearby wells based on well depth,
 * age, type, and current status. P&A liability is a critical risk in mineral
 * acquisitions — orphan well liability can exceed property value in old fields.
 *
 * Cost data sources:
 * - Interstate Oil and Gas Compact Commission (IOGCC) orphan well reports
 * - State plugging cost averages from Texas RRC, NDIC, OCC public data
 * - SPE-181328 and SPE-196127 plugging cost literature
 *
 * Depth-based cost estimates (2023-2024 averages, USD):
 *   Shallow   (<2,000 ft):   $15,000 – $40,000
 *   Medium    (2–5,000 ft):  $35,000 – $90,000
 *   Deep      (5–10,000 ft): $75,000 – $200,000
 *   Very deep (>10,000 ft):  $175,000 – $500,000
 *   Horizontal well:         +60% premium on base cost
 */

import type { NearbyWell } from "@/lib/wells/nearby-wells";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaLiabilityResult = {
  /** Total wells analyzed. */
  well_count: number;
  /** Wells that are inactive, shut-in, or plugging candidates. */
  at_risk_count: number;
  /** Already plugged/abandoned wells (liability realized). */
  plugged_count: number;
  /** Low-end total estimated plugging cost exposure (USD). */
  total_liability_low: number | null;
  /** High-end total estimated plugging cost exposure (USD). */
  total_liability_high: number | null;
  /** Average per-well cost. */
  avg_per_well_low: number | null;
  avg_per_well_high: number | null;
  /** Liability severity for risk scoring. */
  severity: "low" | "moderate" | "high" | "critical" | "unknown";
  /** Primary risk driver (why it's this severity). */
  primary_driver: string | null;
  summary: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Infer well depth from state + basin context.
 * Without actual depth data, uses basin-typical depth ranges.
 * Returns depth in feet.
 */
function inferDepthFromContext(state: string | null, status: string | null): { low: number; high: number } {
  const s = state?.toUpperCase() ?? "";
  // Permian, Bakken, Eagle Ford — deep horizontal wells
  if (["TX", "ND", "MT"].includes(s)) return { low: 8_000, high: 12_000 };
  // Anadarko, SCOOP/STACK
  if (s === "OK") return { low: 5_000, high: 9_000 };
  // Appalachian — wide range: shallow conventional to deep Marcellus/Utica
  if (["WV", "PA"].includes(s)) return { low: 1_500, high: 7_000 };
  if (s === "OH") return { low: 1_000, high: 5_000 };
  return { low: 3_000, high: 8_000 };
}

/** Estimate per-well plugging cost range from depth. */
function pluggingCostFromDepth(depth_low: number, depth_high: number): { low: number; high: number } {
  const mid = (depth_low + depth_high) / 2;
  if (mid < 2_000)       return { low: 15_000, high: 40_000 };
  if (mid < 5_000)       return { low: 35_000, high: 90_000 };
  if (mid < 10_000)      return { low: 75_000, high: 200_000 };
  return                        { low: 175_000, high: 500_000 };
}

function isAtRisk(status: string | null): boolean {
  if (!status) return true; // unknown = assume risk
  const s = status.toLowerCase();
  return /inactive|shut[- ]?in|temporary abandon|idle|orphan|ta\b|si\b/i.test(s);
}

function isPlugged(status: string | null): boolean {
  if (!status) return false;
  return /plug|abandon|p&a|pa\b/i.test(status.toLowerCase());
}

function isActive(status: string | null): boolean {
  if (!status) return false;
  return /activ|produc|inject/i.test(status.toLowerCase());
}

// ── Main function ──────────────────────────────────────────────────────────────

export function computePaLiability(args: {
  wells: NearbyWell[];
  state: string | null;
}): PaLiabilityResult {
  const { wells, state } = args;

  if (wells.length === 0) {
    return {
      well_count: 0,
      at_risk_count: 0,
      plugged_count: 0,
      total_liability_low: null,
      total_liability_high: null,
      avg_per_well_low: null,
      avg_per_well_high: null,
      severity: "unknown",
      primary_driver: null,
      summary: "No nearby well data available for P&A liability assessment.",
    };
  }

  let atRisk = 0;
  let plugged = 0;
  let active = 0;
  let totalLow = 0;
  let totalHigh = 0;

  const depth = inferDepthFromContext(state, null);
  const costPerWell = pluggingCostFromDepth(depth.low, depth.high);

  for (const w of wells) {
    if (isPlugged(w.status)) {
      plugged++;
      // Already plugged — liability already realized (not additive future exposure)
    } else if (isAtRisk(w.status)) {
      atRisk++;
      totalLow += costPerWell.low;
      totalHigh += costPerWell.high;
    } else if (isActive(w.status)) {
      active++;
      // Active wells: residual eventual P&A liability (discounted — far future)
      totalLow += costPerWell.low * 0.15;   // ~15% present value of future cost
      totalHigh += costPerWell.high * 0.15;
    } else {
      // Unknown status — conservatively treat as at-risk
      atRisk++;
      totalLow += costPerWell.low * 0.5;
      totalHigh += costPerWell.high * 0.5;
    }
  }

  const totalCount = wells.length;
  const avgLow = totalCount > 0 ? Math.round(totalLow / totalCount) : null;
  const avgHigh = totalCount > 0 ? Math.round(totalHigh / totalCount) : null;

  // Severity scoring
  let severity: PaLiabilityResult["severity"];
  let primaryDriver: string | null = null;
  const atRiskPct = totalCount > 0 ? atRisk / totalCount : 0;

  if (atRiskPct >= 0.5 && totalLow > 200_000) {
    severity = "critical";
    primaryDriver = `${atRisk} of ${totalCount} nearby wells are inactive/at-risk with estimated $${(totalLow / 1000).toFixed(0)}k–$${(totalHigh / 1000).toFixed(0)}k total plugging exposure`;
  } else if (atRiskPct >= 0.3 || totalLow > 100_000) {
    severity = "high";
    primaryDriver = `${atRisk} at-risk wells detected in proximity — significant plugging liability`;
  } else if (atRiskPct >= 0.1 || totalLow > 30_000) {
    severity = "moderate";
    primaryDriver = `${atRisk} potentially inactive well${atRisk !== 1 ? "s" : ""} within search area`;
  } else {
    severity = "low";
    primaryDriver = active > 0 ? "Majority of nearby wells are active — residual future P&A liability only" : null;
  }

  const liabStr = totalLow > 0
    ? `Estimated $${(totalLow / 1000).toFixed(0)}k–$${(totalHigh / 1000).toFixed(0)}k total exposure`
    : "Minimal near-term plugging exposure";

  const summary = `${totalCount} nearby well${totalCount !== 1 ? "s" : ""}: ${active} active, ${atRisk} at-risk, ${plugged} plugged. ${liabStr} (depth-based estimate).`;

  return {
    well_count: totalCount,
    at_risk_count: atRisk,
    plugged_count: plugged,
    total_liability_low: totalLow > 0 ? Math.round(totalLow) : null,
    total_liability_high: totalHigh > 0 ? Math.round(totalHigh) : null,
    avg_per_well_low: avgLow,
    avg_per_well_high: avgHigh,
    severity,
    primary_driver: primaryDriver,
    summary,
  };
}
