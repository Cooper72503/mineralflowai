import { describe, expect, it } from "vitest";
import { recordingIdentity, referenceCounty } from "../recording-identity";
import { parseInstrumentText, findRecordingReferences } from "../instrument-parser";
import { buildCrossCuttingFindings } from "../chain-findings";
import { buildGraphInput, TRACT_A } from "./fixtures/instruments";

describe("reference identity and reviewed predecessor evidence", () => {
  it("extracts actual county names without absorbing 'of' and declines ambiguous context", () => {
    expect(referenceCounty("Deed Records of Midland County, Texas")).toBe("Midland");
    expect(referenceCounty("Deaf Smith County, Texas")).toBe("Deaf Smith");
    expect(referenceCounty("Midland County and Glasscock County records")).toBeNull();
    expect(referenceCounty("Unknown County")).toBeNull();
    const d = parseInstrumentText("MINERAL DEED\nInstrument No. 2025-12345\nGrantor: Alice Smith\nGrantee: Bob Jones\n" + "x".repeat(450) + " same land described in Instrument No. 2009-21234 of Midland County, Texas.");
    expect(d.instruments[0].references.find(r => r.instrumentNumber === "2009-21234")?.county).toBe("Midland");
    expect(findRecordingReferences("Instrument No. 2009-21234")[0].value).toBe("2009-21234");
  });
  it("does not collapse distinct volume/page pairs or unknown recording counties", () => {
    expect(recordingIdentity("Midland", null, "Vol. 12, Pg. 345")).not.toBe(recordingIdentity("Midland", null, "Vol. 123, Pg. 45"));
    expect(recordingIdentity(null, "2025-12345", null)).toBeNull();
  });
  it.each([
    ["Martin", true, 0], ["Martin", false, 1], ["Midland", true, 1],
  ] as const)("county %s, content read %s leaves %s missing references", (county, verified, count) => {
    const input = buildGraphInput([
      { number: "2020-0001", from: ["A"], to: ["B"], references: [{ description: "same land", instrumentNumber: "2009-21234", bookVolumePage: null, county: "Martin", relation: "predecessor", page: 1 }], claims: [{ interest: "mineral" }] },
      { number: "2009-21234", verified, from: ["C"], to: ["A"], claims: [{ interest: "mineral" }] },
    ]);
    input.instruments[1].county = county;
    const findings = buildCrossCuttingFindings({ ...input, tracts: [TRACT_A], limitations: [], providerUnavailableCounties: [], ocrFailedDocumentIds: [] });
    expect(findings.filter(f => f.type === "MISSING_REFERENCED_INSTRUMENT")).toHaveLength(count);
  });
});
