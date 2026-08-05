import { describe, it, expect } from "vitest";
import { scoreAnalog, type AnalogScoringInput } from "../analog-scoring";
import { matchFormations, normalizeFormation } from "../formation-normalization";

const sameFormationMatch = matchFormations(normalizeFormation("SPRABERRY (TREND AREA)"), normalizeFormation("SPRABERRY UNIT 4"));
const incompatibleMatch = matchFormations(normalizeFormation("SPRABERRY (TREND AREA)"), normalizeFormation("NEWARK, EAST (BARNETT SHALE)"));

const fullDataInput: AnalogScoringInput = {
  formationMatch: sameFormationMatch, distanceMiles: 1, searchRadiusMiles: 5,
  subjectLateralLengthFt: 10000, candidateLateralLengthFt: 10500,
  subjectCompletionYear: 2020, candidateCompletionYear: 2021,
  subjectTvdFt: 8000, candidateTvdFt: 8200,
};

describe("scoreAnalog — transparent, explainable, never a black box", () => {
  it("every dimension carries a human-readable fact string", () => {
    const result = scoreAnalog(fullDataInput);
    for (const d of result.dimensions) {
      expect(d.fact.length).toBeGreaterThan(0);
    }
  });

  it("scores an ideal analog (same formation, close, similar everything) near the top of the scale", () => {
    const result = scoreAnalog(fullDataInput);
    expect(result.totalScore).toBeGreaterThan(80);
  });

  it("scores an incompatible-formation candidate much lower than a same-formation one, all else equal", () => {
    const good = scoreAnalog(fullDataInput);
    const bad = scoreAnalog({ ...fullDataInput, formationMatch: incompatibleMatch });
    expect(bad.totalScore).toBeLessThan(good.totalScore);
  });

  it("a well right at the search radius edge scores lower on distance than one at the center", () => {
    const close = scoreAnalog({ ...fullDataInput, distanceMiles: 0.1 });
    const far = scoreAnalog({ ...fullDataInput, distanceMiles: 4.9, searchRadiusMiles: 5 });
    expect(far.totalScore).toBeLessThan(close.totalScore);
  });

  it("redistributes weight, not a zero score, when a dimension's data is missing for one candidate — a well missing only lateral-length data scores on its OTHER real merits, not penalized to zero for that dimension", () => {
    const missingLateral = scoreAnalog({ ...fullDataInput, candidateLateralLengthFt: null });
    const lateralDim = missingLateral.dimensions.find(d => d.dimension === "lateralLength")!;
    expect(lateralDim.available).toBe(false);
    expect(lateralDim.weightApplied).toBe(0);
    // Total weight across all AVAILABLE dimensions must still sum to 1 (excluding dataCompleteness which is always available).
    const appliedWeightSum = missingLateral.dimensions.filter(d => d.available && d.dimension !== "dataCompleteness").reduce((s, d) => s + d.weightApplied, 0) + missingLateral.dimensions.find(d => d.dimension === "dataCompleteness")!.weightApplied;
    expect(appliedWeightSum).toBeCloseTo(1, 5);
  });

  it("reports data completeness as the fraction of dimensions that had real data", () => {
    const partial = scoreAnalog({ ...fullDataInput, candidateLateralLengthFt: null, candidateTvdFt: null });
    const completenessDim = partial.dimensions.find(d => d.dimension === "dataCompleteness")!;
    expect(completenessDim.rawScore).toBeCloseTo(3 / 5, 4); // formation, distance, vintage available; lateral, depth missing
  });

  it("total score is always within [0, 100]", () => {
    const zero = scoreAnalog({ ...fullDataInput, formationMatch: incompatibleMatch, distanceMiles: 5, searchRadiusMiles: 5 });
    expect(zero.totalScore).toBeGreaterThanOrEqual(0);
    expect(zero.totalScore).toBeLessThanOrEqual(100);
    const max = scoreAnalog(fullDataInput);
    expect(max.totalScore).toBeLessThanOrEqual(100);
  });

  it("a distant but well-matched (same-formation) analog can outscore a close but incompatible-formation one — proves scoring is genuinely multi-factor, not distance-dominated", () => {
    const distantGoodMatch = scoreAnalog({
      ...fullDataInput, formationMatch: sameFormationMatch, distanceMiles: 4.5, searchRadiusMiles: 5, // far, but same formation
    });
    const closeBadMatch = scoreAnalog({
      ...fullDataInput, formationMatch: incompatibleMatch, distanceMiles: 0.1, searchRadiusMiles: 5, // very close, but wrong formation entirely
    });
    expect(distantGoodMatch.totalScore).toBeGreaterThan(closeBadMatch.totalScore);
  });

  it("still produces a valid score when every optional dimension is missing (formation + distance only)", () => {
    const minimal = scoreAnalog({
      formationMatch: sameFormationMatch, distanceMiles: 1, searchRadiusMiles: 5,
      subjectLateralLengthFt: null, candidateLateralLengthFt: null,
      subjectCompletionYear: null, candidateCompletionYear: null,
      subjectTvdFt: null, candidateTvdFt: null,
    });
    expect(minimal.totalScore).toBeGreaterThan(0);
    expect(Number.isFinite(minimal.totalScore)).toBe(true);
  });
});
