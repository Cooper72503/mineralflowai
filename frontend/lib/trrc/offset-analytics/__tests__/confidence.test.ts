import { describe, it, expect } from "vitest";
import { computeConfidence, ownershipConfidenceScore, type ConfidenceDimensions } from "../confidence";

const allHigh: ConfidenceDimensions = {
  legalDescription: 0.9, geometry: 0.9, wellLocation: 0.9, geologicalMatch: 0.9,
  productionData: 0.9, declineFit: 0.9, ownership: 0.9, economics: 0.9,
};

describe("computeConfidence — overall is the MINIMUM dimension, not an average", () => {
  it("classifies a fully-high case as HIGH overall", () => {
    const result = computeConfidence(allHigh);
    expect(result.overall).toBe("HIGH");
  });

  it("one bad dimension (ownership) drags the overall rating down, not diluted by seven good ones", () => {
    const result = computeConfidence({ ...allHigh, ownership: 0 });
    expect(result.overall).toBe("INSUFFICIENT_DATA");
    // Proves this ISN'T an average — an average of 7×0.9 + 1×0 would still classify as HIGH/MODERATE.
    const naiveAverage = (0.9 * 7 + 0) / 8;
    expect(naiveAverage).toBeGreaterThan(0.45); // would be MODERATE or better under averaging — confirms the min-based approach is materially different
  });

  it("classifies zero as INSUFFICIENT_DATA specifically, distinct from LOW", () => {
    const result = computeConfidence({ ...allHigh, geometry: 0 });
    expect(result.overall).toBe("INSUFFICIENT_DATA");
  });

  it("classifies a low-but-nonzero dimension as LOW, not INSUFFICIENT_DATA", () => {
    const result = computeConfidence({ ...allHigh, declineFit: 0.2 });
    expect(result.overall).toBe("LOW");
  });

  it("classifies a moderate dimension correctly at the MODERATE tier", () => {
    const result = computeConfidence({ ...allHigh, productionData: 0.5 });
    expect(result.overall).toBe("MODERATE");
  });

  it("preserves every individual dimension score in the result, not just the overall classification", () => {
    const result = computeConfidence(allHigh);
    expect(result.dimensions).toEqual(allHigh);
  });
});

describe("ownershipConfidenceScore", () => {
  it("scores a real owner interest (royalty or WI) high", () => {
    expect(ownershipConfidenceScore("ROYALTY_OWNER_PV10")).toBeGreaterThan(0.8);
    expect(ownershipConfidenceScore("WORKING_INTEREST_OWNER_PV10")).toBeGreaterThan(0.8);
  });

  it("scores the proxy fallbacks meaningfully lower than a real owner interest", () => {
    expect(ownershipConfidenceScore("GROSS_TRACT_PROXY_VALUE")).toBeLessThan(0.5);
    expect(ownershipConfidenceScore("VALUE_PER_NET_MINERAL_ACRE")).toBeLessThan(0.5);
  });

  it("scores OWNER_PV10_UNAVAILABLE as exactly zero", () => {
    expect(ownershipConfidenceScore("OWNER_PV10_UNAVAILABLE")).toBe(0);
  });
});
