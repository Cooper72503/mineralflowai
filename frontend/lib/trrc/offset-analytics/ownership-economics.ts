/**
 * Ownership-interest resolution — the guard against this engine's single
 * most important non-negotiable principle: "Do not compute owner-level
 * PV-10 from Net Mineral Acres alone." NMA tells you how much of the
 * minerals someone owns, not what fraction of REVENUE they're entitled to
 * — that also depends on the lease royalty fraction (for a royalty
 * owner) or the working/net-revenue interest split (for a WI owner), and
 * without one of those, "owner PV-10" is not a computable number, not a
 * number this engine should approximate.
 *
 * This directly replaces a real anti-pattern found in the Phase 0 audit:
 * archive/frontend/lib/underwriting/offset-intelligence-engine.ts computed
 * `nmaOwned = acreage * NRI * 8` — an assumed, hardcoded 1/8 royalty
 * baseline multiplier — and divided a computed PV10 by it to produce a
 * "value per NMA" AS IF that were real ownership data. It is not; 1/8 is
 * a common but far from universal royalty fraction, and treating it as a
 * default silently overstates or understates every non-1/8 owner's actual
 * economics.
 */

import type { WarningEntry } from "./types";

export type OwnershipResultType = "ROYALTY_OWNER_PV10" | "WORKING_INTEREST_OWNER_PV10" | "GROSS_TRACT_PROXY_VALUE" | "VALUE_PER_NET_MINERAL_ACRE" | "OWNER_PV10_UNAVAILABLE";

export interface OwnershipInputs {
  ownershipType: "ROYALTY_INTEREST" | "WORKING_INTEREST" | "UNKNOWN";
  netMineralAcres: number | null;
  grossTractAcres: number | null;
  /** Royalty owner path: fraction of the minerals under the tract this owner holds (e.g. NMA/grossAcres), 0-1. */
  mineralFraction: number | null;
  /** Royalty owner path: the lease's royalty fraction (e.g. 0.1875 for 3/16), 0-1. */
  leaseRoyaltyFraction: number | null;
  /** Working-interest owner path: net revenue interest, 0-1. */
  netRevenueInterest: number | null;
  /** Working-interest owner path: working interest (expense-bearing share), 0-1. */
  workingInterest: number | null;
}

export interface OwnershipResolution {
  resultType: OwnershipResultType;
  /** The fraction of gross revenue this owner is entitled to — null unless resultType is one of the *_PV10 types. NEVER populated from NMA alone. */
  revenueShareFraction: number | null;
  /** The fraction of gross expenses this owner bears — null for royalty owners (royalty is expense-free by definition) and for the two proxy/unavailable result types. */
  expenseShareFraction: number | null;
  missingInputs: string[];
  warnings: WarningEntry[];
}

function isValidFraction(v: number | null): v is number {
  return v !== null && v >= 0 && v <= 1;
}

export function resolveOwnership(inputs: OwnershipInputs): OwnershipResolution {
  const warnings: WarningEntry[] = [];

  if (inputs.ownershipType === "ROYALTY_INTEREST" && isValidFraction(inputs.mineralFraction) && isValidFraction(inputs.leaseRoyaltyFraction)) {
    const decimalRoyaltyInterest = inputs.mineralFraction * inputs.leaseRoyaltyFraction;
    return {
      resultType: "ROYALTY_OWNER_PV10",
      revenueShareFraction: decimalRoyaltyInterest,
      expenseShareFraction: 0, // royalty interests are, by definition, free of operating expenses and most deductions (severance tax is typically still borne — handled in proxy-valuation.ts, not here)
      missingInputs: [],
      warnings,
    };
  }

  if (inputs.ownershipType === "WORKING_INTEREST" && isValidFraction(inputs.netRevenueInterest) && isValidFraction(inputs.workingInterest)) {
    return {
      resultType: "WORKING_INTEREST_OWNER_PV10",
      revenueShareFraction: inputs.netRevenueInterest,
      expenseShareFraction: inputs.workingInterest,
      missingInputs: [],
      warnings,
    };
  }

  // Neither path had complete, valid inputs — figure out exactly what's missing so the caller (and the report) can say precisely why an owner PV-10 isn't available, not just "no."
  const missingInputs: string[] = [];
  if (inputs.ownershipType === "ROYALTY_INTEREST") {
    if (!isValidFraction(inputs.mineralFraction)) missingInputs.push("mineralFraction");
    if (!isValidFraction(inputs.leaseRoyaltyFraction)) missingInputs.push("leaseRoyaltyFraction");
  } else if (inputs.ownershipType === "WORKING_INTEREST") {
    if (!isValidFraction(inputs.netRevenueInterest)) missingInputs.push("netRevenueInterest");
    if (!isValidFraction(inputs.workingInterest)) missingInputs.push("workingInterest");
  } else {
    missingInputs.push("ownershipType");
  }

  if (inputs.grossTractAcres !== null && inputs.grossTractAcres > 0) {
    warnings.push({
      code: "OWNER_PV10_UNAVAILABLE_FALLBACK_TO_GROSS_TRACT",
      message: `Owner-level PV-10 requires ${missingInputs.join(" and ")}, which ${missingInputs.length > 1 ? "were" : "was"} not provided — falling back to a gross-tract proxy value. This is NOT this owner's actual entitlement.`,
      severity: "warning",
    });
    return { resultType: "GROSS_TRACT_PROXY_VALUE", revenueShareFraction: null, expenseShareFraction: null, missingInputs, warnings };
  }

  if (inputs.netMineralAcres !== null && inputs.netMineralAcres > 0) {
    warnings.push({
      code: "OWNER_PV10_UNAVAILABLE_FALLBACK_TO_PER_NMA",
      message: `Owner-level PV-10 requires ${missingInputs.join(" and ")}, which ${missingInputs.length > 1 ? "were" : "was"} not provided — falling back to a value-per-net-mineral-acre figure. This is NOT the same as this owner's total entitlement, which also depends on the (missing) royalty or working-interest fraction.`,
      severity: "warning",
    });
    return { resultType: "VALUE_PER_NET_MINERAL_ACRE", revenueShareFraction: null, expenseShareFraction: null, missingInputs, warnings };
  }

  warnings.push({ code: "OWNER_PV10_UNAVAILABLE", message: `Owner-level PV-10 cannot be computed and no acreage figure is available even for a proxy fallback. Missing: ${missingInputs.join(", ")}`, severity: "critical" });
  return { resultType: "OWNER_PV10_UNAVAILABLE", revenueShareFraction: null, expenseShareFraction: null, missingInputs, warnings };
}
