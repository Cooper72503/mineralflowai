import { describe, it, expect } from "vitest";
import { resolveOwnership, type OwnershipInputs } from "../ownership-economics";

const baseInputs: OwnershipInputs = {
  ownershipType: "UNKNOWN", netMineralAcres: null, grossTractAcres: null,
  mineralFraction: null, leaseRoyaltyFraction: null, netRevenueInterest: null, workingInterest: null,
};

describe("resolveOwnership — the core guard against a false owner PV-10", () => {
  it("THE critical case: NMA alone, with no royalty or WI fraction, can NEVER produce ROYALTY_OWNER_PV10 or WORKING_INTEREST_OWNER_PV10", () => {
    const result = resolveOwnership({ ...baseInputs, ownershipType: "ROYALTY_INTEREST", netMineralAcres: 40, grossTractAcres: 320 });
    expect(result.resultType).not.toBe("ROYALTY_OWNER_PV10");
    expect(result.resultType).not.toBe("WORKING_INTEREST_OWNER_PV10");
    expect(result.revenueShareFraction).toBeNull();
  });

  it("replicates the exact archived anti-pattern's inputs (NMA + a royalty fraction present, but no lease royalty fraction) and proves it does NOT compute a fabricated 1/8-assumed PV-10", () => {
    // The archived code assumed 1/8 (0.125) whenever it wasn't told otherwise.
    // Confirm this implementation never substitutes that assumption silently.
    const result = resolveOwnership({
      ...baseInputs, ownershipType: "ROYALTY_INTEREST",
      netMineralAcres: 40, grossTractAcres: 320, mineralFraction: 40 / 320, leaseRoyaltyFraction: null,
    });
    expect(result.resultType).toBe("GROSS_TRACT_PROXY_VALUE");
    expect(result.missingInputs).toContain("leaseRoyaltyFraction");
  });

  it("computes a real decimal royalty interest as mineralFraction × leaseRoyaltyFraction when both are genuinely provided", () => {
    const result = resolveOwnership({
      ...baseInputs, ownershipType: "ROYALTY_INTEREST",
      mineralFraction: 0.125, leaseRoyaltyFraction: 0.1875, // 1/8 mineral fraction, 3/16 royalty — both REAL, explicit inputs this time
    });
    expect(result.resultType).toBe("ROYALTY_OWNER_PV10");
    expect(result.revenueShareFraction).toBeCloseTo(0.125 * 0.1875, 6);
    expect(result.expenseShareFraction).toBe(0);
  });

  it("computes working-interest revenue/expense shares from NRI/WI when both are provided", () => {
    const result = resolveOwnership({
      ...baseInputs, ownershipType: "WORKING_INTEREST", netRevenueInterest: 0.75, workingInterest: 1.0,
    });
    expect(result.resultType).toBe("WORKING_INTEREST_OWNER_PV10");
    expect(result.revenueShareFraction).toBe(0.75);
    expect(result.expenseShareFraction).toBe(1.0);
  });

  it("falls back to GROSS_TRACT_PROXY_VALUE when gross tract acres is known but ownership fractions are not", () => {
    const result = resolveOwnership({ ...baseInputs, ownershipType: "ROYALTY_INTEREST", grossTractAcres: 320 });
    expect(result.resultType).toBe("GROSS_TRACT_PROXY_VALUE");
    expect(result.warnings.some(w => w.code === "OWNER_PV10_UNAVAILABLE_FALLBACK_TO_GROSS_TRACT")).toBe(true);
  });

  it("falls back to VALUE_PER_NET_MINERAL_ACRE when only NMA (no gross acres) is known", () => {
    const result = resolveOwnership({ ...baseInputs, ownershipType: "ROYALTY_INTEREST", netMineralAcres: 40 });
    expect(result.resultType).toBe("VALUE_PER_NET_MINERAL_ACRE");
    expect(result.warnings.some(w => w.code === "OWNER_PV10_UNAVAILABLE_FALLBACK_TO_PER_NMA")).toBe(true);
  });

  it("returns OWNER_PV10_UNAVAILABLE with a critical warning when there's no acreage figure at all", () => {
    const result = resolveOwnership(baseInputs);
    expect(result.resultType).toBe("OWNER_PV10_UNAVAILABLE");
    expect(result.warnings.some(w => w.severity === "critical")).toBe(true);
  });

  it("rejects an out-of-range fraction (e.g. 1.5) as invalid, not clamping it silently", () => {
    const result = resolveOwnership({ ...baseInputs, ownershipType: "ROYALTY_INTEREST", mineralFraction: 1.5, leaseRoyaltyFraction: 0.1875 });
    expect(result.resultType).not.toBe("ROYALTY_OWNER_PV10");
    expect(result.missingInputs).toContain("mineralFraction");
  });

  it("lists every missing input explicitly, not just a generic failure", () => {
    const result = resolveOwnership({ ...baseInputs, ownershipType: "WORKING_INTEREST" });
    expect(result.missingInputs).toEqual(["netRevenueInterest", "workingInterest"]);
  });
});
