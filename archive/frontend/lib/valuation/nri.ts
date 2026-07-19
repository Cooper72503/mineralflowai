import type { DealValuationInput } from "./types";
import { logValuationDev } from "./normalize";

export type NriEstimate = {
  nri: number | null;
  nri_basis: string | null;
};

/**
 * Directional "net royalty acres" style proxy: acres × royalty × (ownership or 1).
 * Not title-confirmed NRI — screening only.
 */
export function estimateDirectionalNriProxy(input: DealValuationInput): NriEstimate {
  const acres = input.acreage;
  const roy = input.royalty_rate;

  if (acres == null || acres <= 0 || roy == null || roy <= 0 || roy > 1) {
    logValuationDev("nri_skip", { reason: "insufficient_acreage_or_royalty", acres, roy });
    return {
      nri: null,
      nri_basis: null,
    };
  }

  const own = input.ownership_percent;
  const ownershipFactor = own != null && own > 0 && own <= 1 ? own : 1;
  const composite = acres * roy * ownershipFactor;

  const basis =
    own != null && own > 0 && own < 1
      ? `Estimated NRI Proxy: directional net royalty acres–style composite (acres × royalty × ownership). Ownership from document signals — not title-confirmed.`
      : `Directional NRI Estimate: net royalty acres–style composite (acres × royalty); ownership not applied (not confirmed). Not title-confirmed NRI.`;

  logValuationDev("nri_computed", {
    acres,
    royalty_decimal: roy,
    ownership_applied: own != null && own > 0 && own <= 1,
    composite,
  });

  return {
    nri: Math.round(composite * 1000) / 1000,
    nri_basis: basis,
  };
}
