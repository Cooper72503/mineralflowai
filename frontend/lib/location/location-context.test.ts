import { describe, expect, it } from "vitest";
import {
  buildLocationContext,
  formatLegalDescriptionDisplay,
  inferApproximateAreaDescriptor,
  parseLegalDescriptionParts,
} from "./location-context";

describe("parseLegalDescriptionParts", () => {
  it("extracts section, block, survey, abstract when present", () => {
    const t =
      "Section 5, Block 22, H&GN RR Co Survey, Abstract A-1234, Reeves County, Texas";
    expect(parseLegalDescriptionParts(t)).toMatchObject({
      section: "5",
      block: "22",
      survey: expect.stringMatching(/Survey/i),
      abstract: "1234",
    });
  });

  it("extracts alphanumeric block ids like C-3", () => {
    const t = "Section 11, Block C-3, PSL Survey, Reeves County, TX";
    expect(parseLegalDescriptionParts(t)).toMatchObject({
      section: "11",
      block: "C-3",
      survey: expect.stringMatching(/PSL Survey/i),
    });
  });
});

describe("inferApproximateAreaDescriptor", () => {
  it("reads NE/4 as northeastern", () => {
    expect(inferApproximateAreaDescriptor("NE/4 of Section 12")).toBe("Northeastern");
  });

  it("reads northern phrasing", () => {
    expect(inferApproximateAreaDescriptor("Northern part of Reeves County")).toBe("Northern");
  });
});

describe("buildLocationContext", () => {
  it("combines directional hint with county", () => {
    const lc = buildLocationContext({
      county: "Reeves",
      state: "TX",
      legal_description: "NE/4 Section 5, Block 2, H&GN Survey",
      extracted_text: null,
      merged: { estimated_formation: "Wolfcamp", estimated_depth_min: 7000, estimated_depth_max: 9000 },
      development_signals: {
        has_development_signals: true,
        matched_signals: [],
        extracted_depth_limit_feet: null,
        referenced_wells: ["A-1", "B-2"],
        has_infrastructure_language: true,
        has_legal_development_context: true,
        partial_snapshot: false,
        formation_text_mention: null,
        display_depth_label: null,
        display_wells_note: null,
        display_infrastructure_note: null,
        display_context_note: null,
      },
    });
    expect(lc.approximate_area).toContain("Northeastern");
    expect(lc.approximate_area).toContain("Reeves County");
    expect(lc.parsed_legal_description).toContain("Section 5");
    expect(lc.parsed_legal_description).toContain("Reeves County");
    expect(lc.confidence).toBe("High");
  });

  it("falls back when county-area cannot be inferred", () => {
    const lc = buildLocationContext({
      county: "Midland",
      state: "TX",
      legal_description: "Various lands",
      extracted_text: null,
      merged: {},
      development_signals: null,
    });
    expect(lc.approximate_area).toBe("County area not confidently determined");
    expect(lc.nearby_activity_signal).toBe("Unknown");
    expect(lc.parsed_legal_description).toBe("Various lands");
  });
});

describe("formatLegalDescriptionDisplay", () => {
  it("formats structured parts with county and state", () => {
    const r = formatLegalDescriptionDisplay({
      county: "Reeves",
      state: "TX",
      legal_description: "Section 11, Block C-3, PSL Survey",
      extracted_text: null,
    });
    expect(r.display).toContain("Section 11");
    expect(r.display).toContain("Block C-3");
    expect(r.display).toContain("Reeves County");
    expect(r.display).toContain("TX");
  });

  it("uses raw legal field when structure is weak", () => {
    const r = formatLegalDescriptionDisplay({
      county: "Reeves",
      state: "TX",
      legal_description: "Various lands in the county",
      extracted_text: null,
    });
    expect(r.display).toBe("Various lands in the county");
  });
});
