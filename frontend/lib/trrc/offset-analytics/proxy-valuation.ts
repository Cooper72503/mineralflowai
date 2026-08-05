/**
 * Proxy economic model — the final synthesis: composite type curve
 * (composite-profile.ts) + development case (tract-scaling.ts) +
 * ownership resolution (ownership-economics.ts) + a real price deck
 * (reuses eia-pricing.ts's PriceDeck, already live in the Economic
 * Evaluation report section) -> risked and unrisked PV-10/PV-15.
 *
 * Cost math (severance tax rates, discount-rate compounding) reuses
 * economics.ts directly rather than re-deriving it — same statutory
 * rates, same monthly-discounting convention, so a reader comparing this
 * section against the subject well's own Section 5 Economic Evaluation
 * sees consistent methodology, not two different unexplained models.
 *
 * Risked and unrisked values are ALWAYS returned as separate fields.
 * Never collapsed into one number — a reader needs to see the risk
 * adjustment applied, not just its result.
 */

import { TX_SEVERANCE_TAX_OIL, monthlyDiscountRate } from "../economics";
import type { PriceDeck } from "../eia-pricing";
import type { TypeCurveMonth } from "./composite-profile";
import type { DevelopmentCase } from "./tract-scaling";
import type { OwnershipResolution } from "./ownership-economics";
import type { WarningEntry } from "./types";

export const DEFAULT_LOE_USD_PER_BOE = 12; // matches economics.ts's own generic default — same disclosed assumption, not a second, different guess

export interface ProxyValuationResult {
  unriskedPv10: number;
  unriskedPv15: number;
  riskedPv10: number;
  riskedPv15: number;
  wellCount: number;
  probabilityOfDevelopment: number;
  riskFactor: number;
  ownershipResultType: OwnershipResolution["resultType"];
  warnings: WarningEntry[];
}

/**
 * Computes one well's discounted cash flow from the P50 type curve,
 * shifted by its own development-timing offset, ownership-adjusted, net
 * of severance tax and a generic LOE assumption. Uses the type curve's P50
 * (median) month-by-month, per the spec's own default-baseline guidance
 * (composite-profile.ts).
 */
function singleWellPv(
  typeCurveMonths: TypeCurveMonth[],
  timingOffsetMonths: number,
  oilPriceUsdBbl: number,
  revenueShareFraction: number,
  expenseShareFraction: number,
  annualDiscountRate: number,
): number {
  const monthlyRate = monthlyDiscountRate(annualDiscountRate);
  let pv = 0;
  for (const month of typeCurveMonths) {
    const monthsFromNow = timingOffsetMonths + month.monthIndex;
    if (monthsFromNow <= 0) continue; // a well that already started before "now" in this simplified model contributes no forward-looking cash flow here
    const grossRevenue = month.p50 * oilPriceUsdBbl;
    const severance = grossRevenue * TX_SEVERANCE_TAX_OIL;
    const loe = month.p50 * DEFAULT_LOE_USD_PER_BOE;
    const netToOwner = (grossRevenue - severance) * revenueShareFraction - loe * expenseShareFraction;
    pv += netToOwner / Math.pow(1 + monthlyRate, monthsFromNow);
  }
  return pv;
}

export function computeProxyValuation(
  typeCurveMonths: TypeCurveMonth[],
  developmentCase: DevelopmentCase,
  ownership: OwnershipResolution,
  priceDeck: PriceDeck,
): ProxyValuationResult {
  // Deliberately does NOT copy ownership.warnings in here — service.ts
  // already pushes those into the final payload directly (they're the
  // ownership phase's own warnings, not this valuation phase's). Doing
  // both was a real bug: every ownership-fallback warning appeared twice
  // in the rendered report (found visually inspecting a real generated
  // PDF's Section 9 during Phase 22 verification).
  const warnings: WarningEntry[] = [];

  if (ownership.resultType !== "ROYALTY_OWNER_PV10" && ownership.resultType !== "WORKING_INTEREST_OWNER_PV10") {
    warnings.push({
      code: "PROXY_VALUATION_NOT_OWNER_LEVEL",
      message: `Ownership resolution returned ${ownership.resultType}, not a real owner interest — PV-10 below is a GROSS TRACT figure (100% revenue/expense share), not this specific owner's entitlement. See ownership-economics.ts's missingInputs for what would be needed to make this owner-specific.`,
      severity: "warning",
    });
  }
  // Gross-tract fallback uses 100% revenue share, 0% expense share (same
  // convention as a royalty owner's expense treatment) — a defensible,
  // clearly-labeled "if you owned the whole tract's revenue" proxy, not a
  // fabricated ownership fraction.
  const revenueShare = ownership.revenueShareFraction ?? 1.0;
  const expenseShare = ownership.expenseShareFraction ?? 0.0;

  if (typeCurveMonths.length === 0) {
    warnings.push({ code: "NO_TYPE_CURVE_FOR_VALUATION", message: "No composite type curve available — PV-10/PV-15 cannot be computed", severity: "critical" });
    return { unriskedPv10: 0, unriskedPv15: 0, riskedPv10: 0, riskedPv15: 0, wellCount: developmentCase.wellCount, probabilityOfDevelopment: developmentCase.probabilityOfDevelopment, riskFactor: developmentCase.riskFactor, ownershipResultType: ownership.resultType, warnings };
  }

  let unriskedPv10 = 0, unriskedPv15 = 0;
  for (const timingOffset of developmentCase.developmentTimingMonths) {
    unriskedPv10 += singleWellPv(typeCurveMonths, timingOffset, priceDeck.scenarios.base.oilUsdBbl, revenueShare, expenseShare, 0.10);
    unriskedPv15 += singleWellPv(typeCurveMonths, timingOffset, priceDeck.scenarios.base.oilUsdBbl, revenueShare, expenseShare, 0.15);
  }
  unriskedPv10 -= developmentCase.infrastructureDeductionUsd;
  unriskedPv15 -= developmentCase.infrastructureDeductionUsd;

  const combinedRiskFactor = developmentCase.probabilityOfDevelopment * developmentCase.riskFactor;
  const riskedPv10 = unriskedPv10 * combinedRiskFactor;
  const riskedPv15 = unriskedPv15 * combinedRiskFactor;

  return {
    unriskedPv10, unriskedPv15, riskedPv10, riskedPv15,
    wellCount: developmentCase.wellCount,
    probabilityOfDevelopment: developmentCase.probabilityOfDevelopment,
    riskFactor: developmentCase.riskFactor,
    ownershipResultType: ownership.resultType,
    warnings,
  };
}
