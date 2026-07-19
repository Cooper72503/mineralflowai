import { describe, expect, it } from "vitest";
import { normalizeCountyKey } from "@/lib/geology/permianCountyMap";
import {
  drillSnapshotFromDealInput,
  enrichDealScoreInputWithDrillDifficulty,
  estimateDrillDifficulty,
} from "./drillDifficultyEngine";

describe("estimateDrillDifficulty", () => {
  it("returns Unknown when county is missing", () => {
    const r = estimateDrillDifficulty({ county: null });
    expect(r.estimatedFormation).toBe("Unknown");
    expect(r.drillDifficulty).toBe("Unknown");
    expect(r.drillDifficultyScore).toBe(0);
    expect(r.estimatedDepthMin).toBeNull();
  });

  it("normalizes Midland County and maps Wolfcamp with Moderate difficulty", () => {
    const r = estimateDrillDifficulty({ county: "  Midland County " });
    expect(r.estimatedFormation).toBe("Wolfcamp");
    expect(r.drillDifficulty).toBe("Moderate");
    expect(r.drillDifficultyScore).toBe(5);
    expect(r.estimatedDepthMin).toBe(8000);
    expect(r.estimatedDepthMax).toBe(11000);
    expect(r.drillDifficultyReason).toContain("Midland");
    expect(r.drillDifficultyReason).toContain("Wolfcamp");
  });

  it("normalizes Reeves County to reeves for Permian map lookup", () => {
    const r = estimateDrillDifficulty({ county: "Reeves County" });
    expect(r.estimatedFormation).toBe("Bone Spring");
    expect(r.estimatedDepthMin).toBe(7000);
    expect(r.estimatedDepthMax).toBe(11000);
    expect(r.drillDifficulty).toBe("Moderate");
    expect(r.drillDifficultyScore).toBe(5);
  });

  it("normalizes REEVES and reeves to the same Bone Spring snapshot (+5 score)", () => {
    for (const county of ["REEVES", "reeves"]) {
      const r = estimateDrillDifficulty({ county });
      expect(r.estimatedFormation).toBe("Bone Spring");
      expect(r.estimatedDepthMin).toBe(7000);
      expect(r.estimatedDepthMax).toBe(11000);
      expect(r.drillDifficulty).toBe("Moderate");
      expect(r.drillDifficultyScore).toBe(5);
    }
  });

  it("normalizeCountyKey maps county variants to reeves", () => {
    expect(normalizeCountyKey("Reeves County")).toBe("reeves");
    expect(normalizeCountyKey("REEVES")).toBe("reeves");
    expect(normalizeCountyKey("reeves")).toBe("reeves");
  });

  it("normalizeCountyKey maps Dawson variants to dawson", () => {
    expect(normalizeCountyKey("Dawson")).toBe("dawson");
    expect(normalizeCountyKey("Dawson County")).toBe("dawson");
    expect(normalizeCountyKey("dawson")).toBe("dawson");
  });

  it("maps Dawson County to Spraberry regional snapshot (Moderate)", () => {
    for (const county of ["Dawson County", "Dawson", "dawson"]) {
      const r = estimateDrillDifficulty({ county });
      expect(r.estimatedFormation).toBe("Spraberry");
      expect(r.estimatedDepthMin).toBe(7000);
      expect(r.estimatedDepthMax).toBe(9500);
      expect(r.drillDifficulty).toBe("Moderate");
      expect(r.drillDifficultyScore).toBe(5);
      expect(r.drillDifficultyReason).toContain("Dawson");
    }
  });

  it("returns Unknown for unmapped county", () => {
    const r = estimateDrillDifficulty({ county: "Dallas" });
    expect(r.drillDifficulty).toBe("Unknown");
    expect(r.drillDifficultyScore).toBe(0);
  });
});

describe("enrichDealScoreInputWithDrillDifficulty", () => {
  it("mutates deal input with drill fields", () => {
    const input: Record<string, unknown> = { county: "reeves", state: "TX" };
    enrichDealScoreInputWithDrillDifficulty(input);
    expect(input.drill_difficulty).toBe("Moderate");
    expect(input.drill_difficulty_score).toBe(5);
    expect(typeof input.estimated_formation).toBe("string");
  });
});

describe("drillSnapshotFromDealInput", () => {
  it("fills defaults for empty input", () => {
    const s = drillSnapshotFromDealInput({});
    expect(s.estimated_formation).toBe("Unknown");
    expect(s.drill_difficulty_score).toBe(0);
  });
});
