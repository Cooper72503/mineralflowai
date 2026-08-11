import { describe, it, expect } from "vitest";
import { computeVshaleFromGammaRay, computeDensityPorosity, computeGrossNetThickness, assessPetrophysics } from "../petrophysics";

describe("computeVshaleFromGammaRay", () => {
  it("computes clamped linear shale volume from real gamma-ray baselines", () => {
    const result = computeVshaleFromGammaRay({
      gammaRay: [{ depthFt: 10000, value: 20 }, { depthFt: 10001, value: 60 }, { depthFt: 10002, value: 150 }],
      gammaRayCleanSand: 20, gammaRayShaleBaseline: 120,
    });
    expect(result).not.toBeNull();
    expect(result![0].vshale).toBe(0);
    expect(result![1].vshale).toBeCloseTo(0.4, 5);
    expect(result![2].vshale).toBe(1); // clamped, not 1.3
  });

  it("returns null rather than a fabricated number when baselines don't bracket a usable range", () => {
    const result = computeVshaleFromGammaRay({
      gammaRay: [{ depthFt: 10000, value: 50 }], gammaRayCleanSand: 100, gammaRayShaleBaseline: 100,
    });
    expect(result).toBeNull();
  });
});

describe("computeDensityPorosity", () => {
  it("computes density porosity from matrix/fluid density constants", () => {
    const result = computeDensityPorosity({
      bulkDensity: [{ depthFt: 10000, value: 2.4 }],
      matrixDensity: 2.65, fluidDensity: 1.0,
    });
    expect(result).not.toBeNull();
    expect(result![0].porosity).toBeCloseTo((2.65 - 2.4) / (2.65 - 1.0), 5);
  });

  it("returns null when matrix density does not exceed fluid density", () => {
    const result = computeDensityPorosity({ bulkDensity: [{ depthFt: 10000, value: 2.0 }], matrixDensity: 1.0, fluidDensity: 1.0 });
    expect(result).toBeNull();
  });
});

describe("computeGrossNetThickness", () => {
  it("computes gross/net/N:G from evenly-spaced samples within the interval", () => {
    const gammaRay = [
      { depthFt: 10000, value: 20 }, { depthFt: 10001, value: 20 }, { depthFt: 10002, value: 150 }, { depthFt: 10003, value: 20 },
    ];
    const result = computeGrossNetThickness({
      gammaRay, vshaleCutoff: 0.5, gammaRayCleanSand: 20, gammaRayShaleBaseline: 120,
      intervalTopFt: 10000, intervalBaseFt: 10003,
    });
    expect(result).not.toBeNull();
    expect(result!.grossThicknessFt).toBe(3);
    expect(result!.netThicknessFt).toBe(3); // 3 of 4 points pass the cutoff (spacing=1)
    expect(result!.netToGrossRatio).toBeCloseTo(1, 5);
  });

  it("returns null when fewer than 2 samples fall within the interval", () => {
    const result = computeGrossNetThickness({
      gammaRay: [{ depthFt: 10000, value: 20 }], vshaleCutoff: 0.5, gammaRayCleanSand: 20, gammaRayShaleBaseline: 120,
      intervalTopFt: 10000, intervalBaseFt: 10003,
    });
    expect(result).toBeNull();
  });
});

describe("assessPetrophysics — V1 honesty gate", () => {
  it("always returns the insufficient-data message when no log curves are available", () => {
    const result = assessPetrophysics(false);
    expect(result.available).toBe(false);
    expect(result.message).toContain("Insufficient data");
  });

  it("throws rather than fabricate an assessment if ever called claiming log curves are available (unreachable in V1)", () => {
    expect(() => assessPetrophysics(true)).toThrow();
  });
});
