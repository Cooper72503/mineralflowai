import { describe, expect, it } from "vitest";
import {
  buildDevelopmentSignalsSnapshot,
  detectDevelopmentSignals,
  extractDepthLimitFeetFromText,
  hasRegionalDrillFromDealInput,
} from "./detect-development-signals";

describe("extractDepthLimitFeetFromText", () => {
  it("parses depth limitation phrasing", () => {
    const t =
      "covering only depths from the surface down to but below the depth of 3200 feet below the surface";
    expect(extractDepthLimitFeetFromText(t)).toBe(3200);
  });

  it("returns null when no depth limit", () => {
    expect(extractDepthLimitFeetFromText("This is a generic conveyance with no depth language.")).toBeNull();
  });
});

describe("detectDevelopmentSignals", () => {
  const assignmentSample = `
    Assignment of Mineral Interest and Oil and Gas Lease
    Fisher County, Texas, 80 acres
    depth limitation covering only depths from the surface down to but below the depth of 3200 feet
    Wells Teagarden B2, L-1, L-2, L-3
    existing flowlines, water lines, pumps, and surface equipment
    Section 12, Block 33, H&TC Survey
  `;

  it("detects development signals on assignment-style text", () => {
    const r = detectDevelopmentSignals(assignmentSample, { county: "Fisher", state: "Texas" });
    expect(r.has_development_signals).toBe(true);
    expect(r.extracted_depth_limit_feet).toBe(3200);
    expect(r.referenced_wells.length).toBeGreaterThan(0);
    expect(r.has_infrastructure_language).toBe(true);
    expect(r.has_legal_development_context).toBe(true);
    expect(r.display_depth_label).toMatch(/3,200/);
  });

  it("returns no signals for plain non-mineral text", () => {
    const r = detectDevelopmentSignals("The parties agree to meet at 3pm on Tuesday.", {});
    expect(r.has_development_signals).toBe(false);
    expect(r.matched_signals.length).toBe(0);
  });
});

describe("buildDevelopmentSignalsSnapshot", () => {
  it("marks partial snapshot when county geology is unknown but document has signals", () => {
    const text =
      "Assignment ... below the depth of 3200 feet ... L-1 ... flowlines ... Section 5 ... oil and gas lease";
    const base = detectDevelopmentSignals(text, { county: "Fisher", state: "TX" });
    expect(base.has_development_signals).toBe(true);

    const dealInputUnknown = {
      estimated_formation: "Unknown",
      estimated_depth_min: null,
      estimated_depth_max: null,
      drill_difficulty: "Unknown",
      drill_difficulty_score: 0,
      drill_difficulty_reason: "Estimated from county-level Permian Basin geology mapping",
    };
    const snap = buildDevelopmentSignalsSnapshot(text, { county: "Fisher" }, dealInputUnknown);
    expect(snap.partial_snapshot).toBe(true);
  });

  it("keeps partial false for regional Midland lease when no extra document signals", () => {
    const text = "Oil and Gas Lease, Midland County, Texas, royalty 1/4.";
    const dealInputMapped = {
      estimated_formation: "Wolfcamp",
      estimated_depth_min: 8000,
      estimated_depth_max: 11000,
      drill_difficulty: "Moderate",
      drill_difficulty_score: 5,
      drill_difficulty_reason: "Midland County mapped to Wolfcamp regional depth range",
    };
    const snap = buildDevelopmentSignalsSnapshot(text, { county: "Midland" }, dealInputMapped);
    expect(snap.partial_snapshot).toBe(false);
  });
});

describe("hasRegionalDrillFromDealInput", () => {
  it("detects regional drill from snake_case merged fields", () => {
    expect(
      hasRegionalDrillFromDealInput({
        estimated_formation: "Wolfcamp",
        estimated_depth_min: 8000,
        estimated_depth_max: 11000,
        drill_difficulty: "Moderate",
      })
    ).toBe(true);
  });

  it("returns false when all unknown", () => {
    expect(
      hasRegionalDrillFromDealInput({
        estimated_formation: "Unknown",
        estimated_depth_min: null,
        estimated_depth_max: null,
        drill_difficulty: "Unknown",
      })
    ).toBe(false);
  });
});
