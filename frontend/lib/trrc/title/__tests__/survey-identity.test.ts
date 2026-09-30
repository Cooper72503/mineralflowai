import { describe, it, expect } from "vitest";
import { hasSurveyIdentity } from "../ingest";

describe("a tract is proposed only from a real survey identity (live CMC BUTTERCUP OCR)", () => {
  it("accepts a section with its block or survey, or an abstract of three or more digits", () => {
    expect(hasSurveyIdentity({ sectionName: "25", blockNumber: "39" })).toBe(true);
    expect(hasSurveyIdentity({ sectionName: "36", surveyName: "T&P RR Co." })).toBe(true);
    expect(hasSurveyIdentity({ abstractNumber: "A-1174" })).toBe(true);
  });
  it("refuses OCR fragments: county names, contract text and one-digit abstracts", () => {
    expect(hasSurveyIdentity({})).toBe(false);
    expect(hasSurveyIdentity({ abstractNumber: "A-1" })).toBe(false);
    expect(hasSurveyIdentity({ abstractNumber: "A-8" })).toBe(false);
    expect(hasSurveyIdentity({ sectionName: "9" })).toBe(false);
  });
});
