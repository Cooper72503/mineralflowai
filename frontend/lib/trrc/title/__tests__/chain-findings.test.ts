import { describe, it, expect } from "vitest";
import { aggregateStatus, buildCrossCuttingFindings, findIdentityCandidates } from "../chain-findings";
import { buildOwnershipGraph } from "../ownership-graph";
import { buildGraphInput, TRACT_A } from "./fixtures/instruments";
import type { ChainFinding } from "../chain-types";

const scope = ["surface", "minerals", "leasehold", "royalty"] as const;
const f = (type: ChainFinding["type"], severity: ChainFinding["severity"] = "medium"): ChainFinding => ({
  findingId: `x-${type}`, type, severity, title: type, explanation: "", affectedTractId: null, affectedTractLabel: null, affectedInterestType: null, instrumentIds: [], citations: [], nextAction: "",
});

describe("status aggregation rule", () => {
  it("INSUFFICIENT_DATA when nothing verified is attached to a confirmed tract", () => {
    expect(aggregateStatus({ findings: [], confirmedTractCount: 0, verifiedInstrumentsOnConfirmedTracts: 0 })).toBe("INSUFFICIENT_DATA");
    expect(aggregateStatus({ findings: [f("OVER_CONVEYANCE", "high")], confirmedTractCount: 1, verifiedInstrumentsOnConfirmedTracts: 0 })).toBe("INSUFFICIENT_DATA");
  });
  it("conflicts win over gaps; gaps win over the no-discontinuity status; every finding is retained by the caller", () => {
    expect(aggregateStatus({ findings: [f("UNSUPPORTED_TRANSITION", "high"), f("OVER_CONVEYANCE", "high")], confirmedTractCount: 1, verifiedInstrumentsOnConfirmedTracts: 2 })).toBe("POTENTIAL_CONFLICTS_DETECTED");
    expect(aggregateStatus({ findings: [f("UNSUPPORTED_TRANSITION", "high")], confirmedTractCount: 1, verifiedInstrumentsOnConfirmedTracts: 2 })).toBe("POTENTIAL_GAPS_DETECTED");
    expect(aggregateStatus({ findings: [f("SUCCESSION_EVIDENCE", "info")], confirmedTractCount: 1, verifiedInstrumentsOnConfirmedTracts: 2 })).toBe("NO_SURFACE_DISCONTINUITIES_DETECTED");
  });
  it("a low-severity fraction inconsistency is a gap, a high-severity one is a conflict", () => {
    expect(aggregateStatus({ findings: [f("FRACTION_INCONSISTENCY", "low")], confirmedTractCount: 1, verifiedInstrumentsOnConfirmedTracts: 1 })).toBe("POTENTIAL_GAPS_DETECTED");
    expect(aggregateStatus({ findings: [f("FRACTION_INCONSISTENCY", "high")], confirmedTractCount: 1, verifiedInstrumentsOnConfirmedTracts: 1 })).toBe("POTENTIAL_CONFLICTS_DETECTED");
  });
});

describe("similar names belonging to different people", () => {
  it("proposes an identity review item and keeps the chain unsupported until confirmed", () => {
    const input = buildGraphInput([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["John Smith"], claims: [{ interest: "mineral" }] },
      { executed: "2000-02-05", recorded: "2000-02-10", from: ["John Smith Jr"], to: ["Carol Clark"], claims: [{ interest: "mineral" }] },
      { executed: "2001-02-05", recorded: "2001-02-10", from: ["J. Smith"], to: ["Dan Dunn"], claims: [{ interest: "mineral" }] },
    ]);
    const candidates = findIdentityCandidates(input.parties);
    expect(candidates.some(c => /generational suffix/.test(c.reason))).toBe(true);
    expect(candidates.some(c => /first initial/.test(c.reason))).toBe(true);
    const graph = buildOwnershipGraph({ ...input, interestScope: [...scope] });
    expect(graph.findings.filter(x => x.type === "UNSUPPORTED_TRANSITION")).toHaveLength(2);
    const cross = buildCrossCuttingFindings({ tracts: [TRACT_A], instruments: input.instruments, parties: input.parties, claims: input.claims, limitations: [], providerUnavailableCounties: [], ocrFailedDocumentIds: [] });
    expect(cross.filter(x => x.type === "IDENTITY_MISMATCH").length).toBeGreaterThanOrEqual(2);
  });
});

describe("missing referenced instruments, index-only, provider unavailable", () => {
  it("reports a predecessor reference that is not in the reviewed set, and index-only rows on a confirmed tract", () => {
    const input = buildGraphInput([
      { executed: "1998-03-03", recorded: "1998-03-10", from: ["Owen Olsen"], to: ["Paula Perez"], references: [{ description: "same land conveyed by deed recorded in Volume 210, Page 44", instrumentNumber: null, bookVolumePage: "Vol. 210, Pg. 44", county: "Martin", relation: "predecessor", page: 1 }], claims: [{ interest: "mineral" }] },
      { executed: null, recorded: "1980-01-10", verified: false, from: ["Nell North"], to: ["Owen Olsen"], claims: [{ interest: "mineral" }] },
    ]);
    const cross = buildCrossCuttingFindings({ tracts: [TRACT_A], instruments: input.instruments, parties: input.parties, claims: input.claims, limitations: [], providerUnavailableCounties: ["Martin"], ocrFailedDocumentIds: ["doc-x"] });
    expect(cross.some(x => x.type === "MISSING_REFERENCED_INSTRUMENT" && /Vol\. 210, Pg\. 44/.test(x.explanation))).toBe(true);
    expect(cross.some(x => x.type === "INDEX_ONLY_EVIDENCE")).toBe(true);
    expect(cross.some(x => x.type === "PROVIDER_UNAVAILABLE" && /Martin County/.test(x.title))).toBe(true);
    expect(cross.some(x => x.type === "OCR_FAILED")).toBe(true);
    expect(cross.every(x => x.nextAction.length > 0)).toBe(true);
  });
});
