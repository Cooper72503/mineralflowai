import { describe, it, expect } from "vitest";
import { recordEvidence, recordCalculatedEvidence } from "../evidence";

describe("recordEvidence", () => {
  it("generates a unique id and preserves classification/source fields", () => {
    const e1 = recordEvidence({ fieldName: "offset_well_count_3mi", classification: "observed", source: "TRRC GIS", rawValue: "5", normalizedValue: "5" });
    const e2 = recordEvidence({ fieldName: "offset_well_count_3mi", classification: "observed", source: "TRRC GIS", rawValue: "5", normalizedValue: "5" });
    expect(e1.id).not.toBe(e2.id);
    expect(e1.classification).toBe("observed");
    expect(e1.transformationMethod).toBeNull();
  });

  it("defaults optional fields to null rather than undefined", () => {
    const e = recordEvidence({ fieldName: "x", classification: "inferred", source: "test" });
    expect(e.sourceUrlOrDocId).toBeNull();
    expect(e.rawValue).toBeNull();
    expect(e.normalizedValue).toBeNull();
    expect(e.confidence).toBeNull();
  });
});

describe("recordCalculatedEvidence", () => {
  it("stamps classification=calculated and preserves the transformation formula", () => {
    const e = recordCalculatedEvidence({
      fieldName: "median_12mo_oil_bbl_g1", source: "TRRC EWA production",
      rawValue: "{}", normalizedValue: "110000",
      transformationMethod: "Median of 12-month trailing oil production across 3 comparable wells.",
    });
    expect(e.classification).toBe("calculated");
    expect(e.transformationMethod).toContain("Median");
  });

  it("throws when transformationMethod is empty — a calculated value must never hide its formula", () => {
    expect(() => recordCalculatedEvidence({
      fieldName: "x", source: "test", transformationMethod: "",
    })).toThrow();
  });

  it("throws when transformationMethod is whitespace-only", () => {
    expect(() => recordCalculatedEvidence({
      fieldName: "x", source: "test", transformationMethod: "   ",
    })).toThrow();
  });
});
