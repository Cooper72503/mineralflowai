import { describe, it, expect } from "vitest";
import { selectTopAnalogs, DEFAULT_ANALOG_SELECTION_OPTIONS, type ScoredCandidate } from "../analog-selection";
import type { AnalogScoreResult } from "../analog-scoring";

function scored(api: string, score: number, lat = 31.5, lng = -97.5): ScoredCandidate {
  return { api, latitude: lat, longitude: lng, score: { totalScore: score, dimensions: [] } as AnalogScoreResult };
}

describe("selectTopAnalogs", () => {
  it("returns NO_VALID_ANALOGS when there are no candidates at all", () => {
    const result = selectTopAnalogs([]);
    expect(result.status).toBe("NO_VALID_ANALOGS");
    expect(result.selected).toEqual([]);
  });

  it("returns MANUAL_REVIEW_REQUIRED (not NO_VALID_ANALOGS) when candidates exist but none clear the score threshold — these are different findings", () => {
    const result = selectTopAnalogs([scored("1", 10), scored("2", 15)]);
    expect(result.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.selected).toEqual([]);
  });

  it("returns LIMITED_ANALOG_SET when fewer than the configured minimum qualify, without padding the set to reach a target count", () => {
    const result = selectTopAnalogs([scored("1", 90)], { ...DEFAULT_ANALOG_SELECTION_OPTIONS, minAnalogCount: 2 });
    expect(result.status).toBe("LIMITED_ANALOG_SET");
    expect(result.selected).toHaveLength(1);
  });

  it("returns SUFFICIENT_ANALOG_SET and does not require exactly 5 when fewer high-quality analogs exist", () => {
    const result = selectTopAnalogs(
      [scored("1", 90, 31.5, -97.5), scored("2", 85, 31.6, -97.6), scored("3", 80, 31.7, -97.7)],
      { ...DEFAULT_ANALOG_SELECTION_OPTIONS, minAnalogCount: 2 },
    );
    expect(result.status).toBe("SUFFICIENT_ANALOG_SET");
    expect(result.selected).toHaveLength(3);
  });

  it("caps at maxAnalogs even when many more qualify", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => scored(String(i), 90 - i, 31.5 + i * 0.5, -97.5)); // spread far apart so pad-clustering doesn't remove them
    const result = selectTopAnalogs(candidates);
    expect(result.selected).toHaveLength(5);
  });

  it("keeps only the highest-scored well from a tight cluster (same-pad overconcentration), not the first one encountered", () => {
    const candidates = [
      scored("low", 50, 31.5, -97.5),
      scored("high", 95, 31.5001, -97.5001), // essentially the same pad — within samePadRadiusMiles
    ];
    const result = selectTopAnalogs(candidates);
    expect(result.selected.map(c => c.api)).toEqual(["high"]);
    expect(result.rejectedForPadOverconcentration).toBe(1);
  });

  it("selects geographically diverse wells when they're far enough apart, even if scores are close", () => {
    const candidates = [scored("a", 90, 31.5, -97.5), scored("b", 89, 32.5, -98.5)];
    const result = selectTopAnalogs(candidates);
    expect(result.selected).toHaveLength(2);
  });

  it("every rejected candidate is accounted for in either rejectedForLowScore or rejectedForPadOverconcentration", () => {
    const candidates = [scored("low", 10), scored("high1", 90, 31.5, -97.5), scored("high2", 85, 31.5001, -97.5001)];
    const result = selectTopAnalogs(candidates);
    const totalRejected = result.rejectedForLowScore + result.rejectedForPadOverconcentration;
    expect(candidates.length - result.selected.length).toBe(totalRejected);
  });
});
