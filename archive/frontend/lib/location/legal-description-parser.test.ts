import { describe, expect, it } from "vitest";
import {
  extractAcreageFromTexts,
  extractLegalDescriptionBlockFromText,
  inferCountyAndStateFromTexts,
  mergeLegalDescriptionParseResults,
  parseLegalDescription,
  parsePlssLegalDescription,
} from "./legal-description-parser";

describe("parsePlssLegalDescription / parseLegalDescription (PLSS)", () => {
  it("parses township, range, section, and quarter from multiline PLSS text", () => {
    const text = `Township 140 North
Range 94 West
Section 4 SE 1/4`;
    const plss = parsePlssLegalDescription(text);
    expect(plss).toMatchObject({
      plss_township: "140 North",
      plss_range: "94 West",
      section: "4",
      plss_aliquot: "SE 1/4",
    });
    const full = parseLegalDescription(text);
    expect(full.plss_township).toBe("140 North");
    expect(full.plss_range).toBe("94 West");
    expect(full.section).toBe("4");
    expect(full.plss_aliquot).toBe("SE 1/4");
  });

  it("parses comma-separated single-line PLSS (North Dakota style)", () => {
    const t = "Township 154 North, Range 100 West, Section 12, Stark County, North Dakota.";
    const r = parseLegalDescription(t);
    expect(r.plss_township).toBe("154 North");
    expect(r.plss_range).toBe("100 West");
    expect(r.section).toBe("12");
  });

  it("parses N 1/2 half-section aliquot when present", () => {
    const text = "Section 9 N 1/2";
    const plss = parsePlssLegalDescription(text);
    expect(plss.section).toBe("9");
    expect(plss.plss_aliquot).toMatch(/N/i);
  });
});

describe("inferCountyAndStateFromTexts", () => {
  it('extracts "Stark County" and North Dakota', () => {
    const { county, state } = inferCountyAndStateFromTexts("Stark County, North Dakota", "other");
    expect(county).toBe("Stark County");
    expect(state).toBe("North Dakota");
  });

  it("handles labeled County: Stark County, North Dakota (summary-style headings)", () => {
    const body = [
      "Mineral Property Summary",
      "",
      "County: Stark County, North Dakota",
      "Acreage: 24 acres",
      "",
      "Legal Description:",
      "Township 140 North",
      "Range 94 West",
      "Section 4 SE 1/4",
    ].join("\n");
    const { county, state } = inferCountyAndStateFromTexts(body);
    expect(county).toBe("Stark County");
    expect(state).toBe("North Dakota");
  });

  it("Fisher County, Texas (acreage line separate)", () => {
    const { county, state } = inferCountyAndStateFromTexts(
      "Fisher County, Texas",
      "257.65 acres",
      "Block R, W.E. Richardson Survey, Abstract 458"
    );
    expect(county).toBe("Fisher County");
    expect(state).toBe("Texas");
  });
});

describe("extractAcreageFromTexts", () => {
  it("reads acres from narrative text", () => {
    expect(extractAcreageFromTexts("approximately 24 acres more or less")).toBe(24);
    expect(extractAcreageFromTexts("12.5 acre tract")).toBe(12.5);
  });

  it("reads Acreage: labeled lines", () => {
    expect(extractAcreageFromTexts("Acreage: 24 acres")).toBe(24);
    expect(extractAcreageFromTexts("Acreage: 257.65")).toBe(257.65);
  });
});

describe("extractLegalDescriptionBlockFromText", () => {
  it("pulls PLSS lines after Legal Description: when present", () => {
    const body = [
      "County: Stark County, North Dakota",
      "Legal Description:",
      "Township 140 North",
      "Range 94 West",
      "Section 4 SE 1/4",
    ].join("\n");
    const block = extractLegalDescriptionBlockFromText(body);
    expect(block).toMatch(/Township 140 North/);
    expect(block).toMatch(/Section 4/);
  });
});

describe("Texas-style legal (abstract / survey / block)", () => {
  it("parses Fisher County-style abstract + survey + block", () => {
    const t = "Block R, W.E. Richardson Survey, Abstract 458";
    const r = parseLegalDescription(t);
    expect(r.block).toBe("R");
    expect(r.abstract_number).toBe("458");
    expect(r.survey_name).toMatch(/Richardson/i);
  });
});

describe("mergeLegalDescriptionParseResults", () => {
  it("fills PLSS from full text when structured legal only has a stub", () => {
    const fromOcr = parseLegalDescription(
      "Township 140 North\nRange 94 West\nSection 4 SE 1/4\nStark County, North Dakota\n24 acres"
    );
    const fromStructured = parseLegalDescription("Mineral interest");
    const m = mergeLegalDescriptionParseResults(fromOcr, fromStructured);
    expect(m.plss_township).toBe("140 North");
    expect(m.plss_range).toBe("94 West");
    expect(m.section).toBe("4");
  });
});
