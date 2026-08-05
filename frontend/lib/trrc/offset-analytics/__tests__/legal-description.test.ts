import { describe, it, expect } from "vitest";
import { normalizeAbstractNumber, parseAliquot, parseTexasLegalDescription, parsePlssLegalDescription, parseLegalDescription } from "../legal-description";

describe("normalizeAbstractNumber", () => {
  it("normalizes every common abstract-number form to the same canonical value", () => {
    expect(normalizeAbstractNumber("A-123")).toBe("A-123");
    expect(normalizeAbstractNumber("A123")).toBe("A-123");
    expect(normalizeAbstractNumber("Abstract 123")).toBe("A-123");
    expect(normalizeAbstractNumber("Abstract No. 123")).toBe("A-123");
    expect(normalizeAbstractNumber("abstract no 123")).toBe("A-123");
  });

  it("preserves a letter suffix", () => {
    expect(normalizeAbstractNumber("Abstract 123A")).toBe("A-123A");
  });

  it("returns null for text with no abstract number", () => {
    expect(normalizeAbstractNumber("Section 4, Block 7")).toBeNull();
    expect(normalizeAbstractNumber(null)).toBeNull();
  });
});

describe("parseTexasLegalDescription", () => {
  it("extracts a full county + survey + abstract description", () => {
    const result = parseTexasLegalDescription(
      "Being 160 acres out of the John Smith Survey, Abstract No. 456, Midland County, Texas, Block 12, Section 4",
    );
    expect(result).not.toBeNull();
    expect(result!.jurisdiction).toBe("TX_LAND_GRID");
    expect(result!.county).toBe("Midland");
    expect(result!.canonicalAbstractNumber).toBe("A-456");
    expect(result!.surveyName).toMatch(/John Smith Survey/i);
    expect(result!.block).toBe("12");
    expect(result!.section).toBe("4");
    expect(result!.grossAcres).toBe(160);
    expect(result!.extractionConfidence).toBeGreaterThan(0.7);
  });

  it("returns a Texas description from abstract-only text (no block/section required)", () => {
    const result = parseTexasLegalDescription("A-789, Reeves County, Texas");
    expect(result).not.toBeNull();
    expect(result!.canonicalAbstractNumber).toBe("A-789");
    expect(result!.block).toBeNull();
    expect(result!.section).toBeNull();
  });

  it("returns null when neither an abstract number nor a survey name is present — not a hollow object", () => {
    expect(parseTexasLegalDescription("Some random text about a lease")).toBeNull();
    expect(parseTexasLegalDescription("")).toBeNull();
  });

  it("lower confidence when county is missing (abstract numbers repeat across counties)", () => {
    const withCounty = parseTexasLegalDescription("John Smith Survey, Abstract 456, Midland County");
    const withoutCounty = parseTexasLegalDescription("John Smith Survey, Abstract 456");
    expect(withoutCounty!.extractionConfidence).toBeLessThan(withCounty!.extractionConfidence);
  });
});

describe("parseAliquot", () => {
  it("parses a bare quarter call", () => {
    const result = parseAliquot("NE/4");
    expect(result).toEqual({ parts: [{ kind: "quarter", value: "NE" }], governmentLot: null, raw: "NE/4" });
  });

  it("parses a nested half-then-quarter call, outer to inner", () => {
    const result = parseAliquot("S/2 NW/4");
    expect(result!.parts).toEqual([
      { kind: "half", value: "S" },
      { kind: "quarter", value: "NW" },
    ]);
  });

  it("parses a quarter-quarter (40-acre) call", () => {
    const result = parseAliquot("SE/4 SE/4");
    expect(result!.parts).toEqual([
      { kind: "quarter", value: "SE" },
      { kind: "quarter", value: "SE" },
    ]);
  });

  it("parses a government lot with no aliquot parts", () => {
    const result = parseAliquot("Lot 3");
    expect(result).toEqual({ parts: [], governmentLot: 3, raw: "Lot 3" });
  });

  it("parses the spelled-out 'Quarter' and 'Half' forms", () => {
    expect(parseAliquot("Northeast Quarter")).toBeNull(); // spelled-out direction words aren't matched — only NE/NW/SE/SW tokens
    expect(parseAliquot("NE Quarter")!.parts).toEqual([{ kind: "quarter", value: "NE" }]);
    expect(parseAliquot("N Half")!.parts).toEqual([{ kind: "half", value: "N" }]);
  });

  it("returns null for text with nothing aliquot-shaped", () => {
    expect(parseAliquot("some unrelated text")).toBeNull();
  });
});

describe("parsePlssLegalDescription", () => {
  it("extracts township, range, section, meridian, and a nested aliquot", () => {
    const result = parsePlssLegalDescription("T140N R94W, 6th Principal Meridian, Section 4, S/2 NW/4");
    expect(result).not.toBeNull();
    expect(result!.townshipNumber).toBe(140);
    expect(result!.townshipDirection).toBe("N");
    expect(result!.rangeNumber).toBe(94);
    expect(result!.rangeDirection).toBe("W");
    expect(result!.section).toBe(4);
    expect(result!.principalMeridian).toMatch(/6th/);
    expect(result!.aliquot!.parts).toEqual([
      { kind: "half", value: "S" },
      { kind: "quarter", value: "NW" },
    ]);
  });

  it("returns null when township, range, or section is missing (not partially resolvable)", () => {
    expect(parsePlssLegalDescription("T140N R94W")).toBeNull(); // no section
    expect(parsePlssLegalDescription("Section 4, NE/4")).toBeNull(); // no township/range
  });

  it("rejects a section number outside the valid PLSS range 1-36", () => {
    expect(parsePlssLegalDescription("T140N R94W Section 99")).toBeNull();
  });

  it("still resolves with lower confidence when there's no aliquot call", () => {
    const result = parsePlssLegalDescription("Township 12 South, Range 5 East, Section 20");
    expect(result).not.toBeNull();
    expect(result!.aliquot).toBeNull();
    expect(result!.extractionConfidence).toBeLessThan(0.8);
  });
});

describe("parseLegalDescription — top-level dispatcher", () => {
  it("prefers Texas land-grid when both could theoretically match", () => {
    const result = parseLegalDescription("John Smith Survey, Abstract 456, Midland County, Texas");
    expect(result.jurisdiction).toBe("TX_LAND_GRID");
  });

  it("falls back to PLSS when there's no Texas abstract/survey", () => {
    const result = parseLegalDescription("T12S R5E Section 20, NE/4");
    expect(result.jurisdiction).toBe("PLSS");
  });

  it("falls back to an explicit UnparsedLegalDescription, retaining raw text and what was tried, when neither matches", () => {
    const result = parseLegalDescription("some vague description with no real identifiers");
    expect(result.jurisdiction).toBe("UNPARSED");
    if (result.jurisdiction === "UNPARSED") {
      expect(result.rawText).toBe("some vague description with no real identifiers");
      expect(result.parserWarnings.length).toBeGreaterThan(0);
      expect(result.parserConfidence).toBe(0);
    }
  });

  it("never throws on malformed or empty input", () => {
    expect(() => parseLegalDescription("")).not.toThrow();
    expect(() => parseLegalDescription("!!!@@@###")).not.toThrow();
    expect(() => parseLegalDescription("A".repeat(10000))).not.toThrow();
  });
});
