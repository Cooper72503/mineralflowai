import { describe, expect, it } from "vitest";
import {
  extractAcreageFromTexts,
  inferCountyAndStateFromTexts,
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
});

describe("inferCountyAndStateFromTexts", () => {
  it('extracts "Stark County" and North Dakota', () => {
    const { county, state } = inferCountyAndStateFromTexts("Stark County, North Dakota", "other");
    expect(county).toBe("Stark County");
    expect(state).toBe("North Dakota");
  });
});

describe("extractAcreageFromTexts", () => {
  it("reads acres from narrative text", () => {
    expect(extractAcreageFromTexts("approximately 24 acres more or less")).toBe(24);
    expect(extractAcreageFromTexts("12.5 acre tract")).toBe(12.5);
  });
});
