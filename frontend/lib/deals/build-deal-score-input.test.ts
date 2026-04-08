import { describe, expect, it } from "vitest";
import { buildDealScoreInput, type ParsedFieldsForDealScore } from "./build-deal-score-input";
import { mergeStructuredFields } from "./dashboard-normalize";

const baseParsed = (): ParsedFieldsForDealScore => ({
  lessor: null,
  lessee: null,
  grantor: null,
  grantee: null,
  county: null,
  state: null,
  legal_description: null,
  effective_date: null,
  recording_date: null,
  royalty_rate: null,
  term_length: null,
  document_type: null,
  confidence_score: null,
});

describe("buildDealScoreInput county / state / acreage", () => {
  it("keeps location and acreage from merged baseline when lease parse confidence is low and columns are empty", () => {
    const text = `Stark County, North Dakota
24 acres
Twp 140N Range 94W`;
    const merged = mergeStructuredFields(
      {
        county: "Stark",
        state: "North Dakota",
        acreage: 24,
        legal_description: "Twp 140N Range 94W",
      },
      {}
    );

    const parsed: ParsedFieldsForDealScore = {
      ...baseParsed(),
      confidence_score: 0.4,
      county: null,
      state: null,
      legal_description: null,
      acreage: null,
    };

    const input = buildDealScoreInput({
      optionalBaseline: merged,
      parsed,
      doc: { county: null, state: null, document_type: "Mineral Deed" },
      extractedText: text,
    });

    expect(input.county).toBe("Stark");
    expect(input.state).toBe("North Dakota");
    expect(input.acreage).toBe(24);
  });

  it("parses acreage from full extracted text when legal_description omits it", () => {
    const parsed: ParsedFieldsForDealScore = {
      ...baseParsed(),
      confidence_score: 0.85,
      legal_description: "Twp 140N Range 94W Section 12",
      acreage: null,
      county: "Stark",
      state: "North Dakota",
    };

    const input = buildDealScoreInput({
      optionalBaseline: {},
      parsed,
      doc: { county: null, state: null, document_type: "Deed" },
      extractedText: `Stark County, North Dakota
Some header line
24 acres more or less
Twp 140N Range 94W`,
    });

    expect(input.acreage).toBe(24);
  });

  it("prefers first non-empty county across baseline, parsed, and document metadata", () => {
    const input = buildDealScoreInput({
      optionalBaseline: { county: "" },
      parsed: {
        ...baseParsed(),
        confidence_score: 0.9,
        county: "Stark",
        state: "North Dakota",
      },
      doc: { county: "Ward", state: "TX", document_type: null },
      extractedText: "",
    });

    expect(input.county).toBe("Stark");
  });
});
