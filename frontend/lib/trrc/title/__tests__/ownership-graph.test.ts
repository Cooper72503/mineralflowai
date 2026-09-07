/**
 * Ownership-graph scenarios. All inputs are FIXTURES (see fixtures/
 * instruments.ts) — nothing here touches TRRC or a county portal.
 */
import { describe, it, expect } from "vitest";
import { buildOwnershipGraph } from "../ownership-graph";
import { Fraction } from "../fraction";
import { buildGraphInput, TRACT_A, TRACT_B } from "./fixtures/instruments";

const scope = ["surface", "minerals", "leasehold", "royalty"] as const;

function run(specs: Parameters<typeof buildGraphInput>[0], tracts = [TRACT_A]) {
  return buildOwnershipGraph({ ...buildGraphInput(specs, tracts), interestScope: [...scope] });
}
const share = (j: { n: string; d: string } | null) => (j ? Fraction.fromJson(j)!.toString() : null);

describe("supported sequence", () => {
  it("A -> B -> C on the mineral estate produces supported events and a single apparent holder, with A as earliest evidenced holder (not root of title)", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", number: "1001", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral" }] },
      { executed: "2000-02-05", recorded: "2000-02-10", number: "2002", from: ["Bob Brown"], to: ["Carol Clark"], claims: [{ interest: "mineral" }] },
    ]);
    const branch = out.branches.find(b => b.interestType === "mineral")!;
    expect(branch.events.map(e => e.support)).toEqual(["root", "supported"]);
    expect(branch.earliestEvidencedHolders[0].displayName).toBe("Alice Adams");
    expect(branch.apparentHolders).toHaveLength(1);
    expect(branch.apparentHolders[0].parties[0].displayName).toBe("Carol Clark");
    expect(branch.apparentHolders[0].status).toBe("unresolved"); // A's share was never quantified, so C's isn't either
    expect(out.findings.filter(f => f.type === "UNSUPPORTED_TRANSITION")).toHaveLength(0);
    expect(branch.notes.join(" ")).not.toMatch(/clear|unbroken|certified/i);
  });
});

describe("missing predecessor", () => {
  it("flags a grantor with no evidenced acquisition as UNSUPPORTED_TRANSITION with a citation and next action", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral" }] },
      { executed: "2000-02-05", recorded: "2000-02-10", from: ["Dan Dunn"], to: ["Carol Clark"], claims: [{ interest: "mineral" }] },
    ]);
    const f = out.findings.find(x => x.type === "UNSUPPORTED_TRANSITION")!;
    expect(f).toBeTruthy();
    expect(f.severity).toBe("high");
    expect(f.explanation).toMatch(/Dan Dunn/);
    expect(f.citations.length).toBeGreaterThan(0);
    expect(f.nextAction).toMatch(/vesting/);
    expect(f.affectedTractId).toBe("tract-a");
  });

  it("distinguishes a grantor whose evidenced interest is in a DIFFERENT tract (TRACT_INTEREST_MISMATCH)", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral", tract: "tract-b" }] },
      { executed: "1991-01-05", recorded: "1991-01-10", from: ["Zed Zane"], to: ["Yolanda York"], claims: [{ interest: "mineral", tract: "tract-a" }] },
      { executed: "2000-02-05", recorded: "2000-02-10", from: ["Bob Brown"], to: ["Carol Clark"], claims: [{ interest: "mineral", tract: "tract-a" }] },
    ], [TRACT_A, TRACT_B]);
    expect(out.findings.some(f => f.type === "TRACT_INTEREST_MISMATCH" && f.explanation.includes("Bob Brown"))).toBe(true);
  });
});

describe("fractional transfers and mineral reservations", () => {
  it("tracks exact fractions: 1/2 reserved in a deed, then 1/4 of the whole conveyed by the grantee; over-conveyance detected", () => {
    const out = run([
      // Root: Owen owns (unquantified). Owen -> Paula, reserving 1/2 minerals; surface passes.
      { executed: "1998-03-03", recorded: "1998-03-10", from: ["Owen Olsen"], to: ["Paula Perez"], claims: [
        { interest: "surface" },
        { interest: "mineral", effect: "conveyance", fraction: undefined },                                   // all of grantor's mineral interest ...
        { interest: "mineral", effect: "reservation", fraction: "1/2", basis: "of_entire_estate", reservationText: "reserving an undivided 1/2 of the minerals" },
      ] },
      // Paula conveys 1/4 of the whole to Quinn — supported, leaves her with (unknown - 1/4)
      { executed: "2005-06-15", recorded: "2005-06-20", from: ["Paula Perez"], to: ["Quinn Qi"], claims: [{ interest: "mineral", fraction: "1/4", basis: "of_entire_estate" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    const owen = mineral.apparentHolders.find(h => h.parties[0].displayName === "Owen Olsen")!;
    expect(share(owen.share)).toBe("1/2");
    expect(owen.shareNote).toMatch(/reserved/i);
    const quinn = mineral.apparentHolders.find(h => h.parties[0].displayName === "Quinn Qi")!;
    expect(share(quinn.share)).toBe("1/4");
    expect(out.findings.some(f => f.type === "OVER_CONVEYANCE")).toBe(false);
    const surface = out.branches.find(b => b.interestType === "surface")!;
    expect(surface.apparentHolders[0].parties[0].displayName).toBe("Paula Perez");
  });

  it("does not treat a fraction of the grantor's interest as a fraction of the entire estate", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_entire_estate" }] },
      { executed: "2000-02-05", recorded: "2000-02-10", from: ["Bob Brown"], to: ["Carol Clark"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_grantor_interest" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    const carol = mineral.apparentHolders.find(h => h.parties[0].displayName === "Carol Clark")!;
    expect(share(carol.share)).toBe("1/4");                          // 1/2 of Bob's 1/2
    const bob = mineral.apparentHolders.find(h => h.parties[0].displayName === "Bob Brown")!;
    expect(share(bob.share)).toBe("1/4");
  });

  it("flags OVER_CONVEYANCE when a grantor conveys more than the evidenced share, and CONFLICTING_CONVEYANCE when conveying after fully divesting", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral", fraction: "1/4", basis: "of_entire_estate" }] },
      { executed: "1995-01-05", recorded: "1995-01-10", from: ["Bob Brown"], to: ["Carol Clark"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_entire_estate" }] },
      { executed: "1999-01-05", recorded: "1999-01-10", from: ["Bob Brown"], to: ["Dan Dunn"], claims: [{ interest: "mineral", fraction: "1/8", basis: "of_entire_estate" }] },
    ]);
    expect(out.findings.some(f => f.type === "OVER_CONVEYANCE")).toBe(true);
    expect(out.findings.some(f => f.type === "CONFLICTING_CONVEYANCE")).toBe(true);
  });

  it("leaves the share unresolved and flags the basis when the fraction basis is unknown", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_entire_estate" }] },
      { executed: "2000-02-05", recorded: "2000-02-10", from: ["Bob Brown"], to: ["Carol Clark"], claims: [{ interest: "mineral", fraction: "1/2", basis: "unknown" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    expect(mineral.apparentHolders.find(h => h.parties[0].displayName === "Carol Clark")!.share).toBeNull();
    expect(out.findings.some(f => f.type === "UNRESOLVED_ALLOCATION" && /basis/i.test(f.title))).toBe(true);
  });

  it("flags a reservation without a parseable fraction as UNRESOLVED_RESERVATION", () => {
    const out = run([
      { executed: "1998-03-03", recorded: "1998-03-10", from: ["Owen Olsen"], to: ["Paula Perez"], claims: [
        { interest: "mineral", effect: "conveyance" },
        { interest: "mineral", effect: "reservation", fraction: null, reservationText: "reserving unto grantor the minerals heretofore reserved" },
      ] },
    ]);
    expect(out.findings.some(f => f.type === "UNRESOLVED_RESERVATION")).toBe(true);
  });
});

describe("multiple parties and tracts", () => {
  it("keeps multi-grantee conveyances as ONE collective holding with an unresolved allocation (no equal-share inference)", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown", "Beth Brown", "Bill Brown"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_entire_estate" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    const collective = mineral.apparentHolders.find(h => h.status === "collective")!;
    expect(collective.parties).toHaveLength(3);
    expect(share(collective.share)).toBe("1/2");
    expect(mineral.unresolvedAllocations.length).toBeGreaterThan(0);
    expect(out.findings.some(f => f.type === "UNRESOLVED_ALLOCATION")).toBe(true);
  });

  it("builds separate branches per tract and never merges chains across tracts", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral", tract: "tract-a" }, { interest: "mineral", tract: "tract-b" }] },
      { executed: "2000-02-05", recorded: "2000-02-10", from: ["Bob Brown"], to: ["Carol Clark"], claims: [{ interest: "mineral", tract: "tract-a" }] },
    ], [TRACT_A, TRACT_B]);
    const a = out.branches.find(b => b.tractId === "tract-a" && b.interestType === "mineral")!;
    const b = out.branches.find(b => b.tractId === "tract-b" && b.interestType === "mineral")!;
    expect(a.apparentHolders[0].parties[0].displayName).toBe("Carol Clark");
    expect(b.apparentHolders[0].parties[0].displayName).toBe("Bob Brown");
  });

  it("checks a lessor against the mineral ledger and creates a leasehold branch", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral" }] },
      { type: "lease", executed: "2010-01-05", recorded: "2010-01-10", from: ["Bob Brown"], to: ["Big Oil Co"], claims: [{ interest: "leasehold", fraction: null, reservationText: "Lessor royalty: 3/16" }] },
      { type: "lease", executed: "2011-01-05", recorded: "2011-01-10", from: ["Stranger Sam"], to: ["Other Oil Co"], claims: [{ interest: "leasehold", fraction: null }] },
    ]);
    const lease = out.branches.find(b => b.interestType === "leasehold")!;
    expect(lease.apparentHolders.some(h => h.parties[0].displayName === "Big Oil Co")).toBe(true);
    expect(out.findings.some(f => f.type === "UNSUPPORTED_TRANSITION" && /Stranger Sam/.test(f.explanation))).toBe(true);
    expect(out.findings.some(f => f.type === "UNSUPPORTED_TRANSITION" && /Bob Brown/.test(f.explanation))).toBe(false);
  });
});

describe("late-recorded instruments and timing", () => {
  it("sorts by recording date, labels the basis, and flags execution/recording order differences without deciding priority", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral" }] },
      { executed: "1992-05-01", recorded: "2001-06-01", number: "late", from: ["Bob Brown"], to: ["Carol Clark"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_grantor_interest" }] },
      { executed: "1995-05-01", recorded: "1995-05-05", from: ["Bob Brown"], to: ["Dan Dunn"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_grantor_interest" }] },
      { executed: null, recorded: null, from: ["Dan Dunn"], to: ["Eve Evans"], claims: [{ interest: "mineral" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    expect(mineral.events.map(e => e.dateBasis)).toEqual(["recorded", "recorded", "recorded", "undated"]);
    expect(mineral.events[1].to[0].displayName).toBe("Dan Dunn");          // recorded 1995 sorts before the late-recorded 1992 deed
    const timing = out.findings.filter(f => f.type === "TIMING_AMBIGUITY");
    expect(timing.some(f => /Late-recorded/.test(f.title))).toBe(true);
    expect(timing.some(f => /Recording order differs/.test(f.title))).toBe(true);
    expect(timing.every(f => !/priority is determined|takes priority/i.test(f.explanation))).toBe(true);
  });
});

describe("probate and succession evidence", () => {
  it("treats an affidavit of heirship as an evidence-bearing transition (SUCCESSION_EVIDENCE info), not a break, and keeps heirs collective without shares", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_entire_estate" }] },
      { type: "affidavit_of_heirship", executed: "2010-01-05", recorded: "2010-01-10", from: ["Bob Brown"], to: ["Hank Brown", "Helen Brown"], claims: [{ interest: "mineral", fraction: null }] },
      { executed: "2015-01-05", recorded: "2015-01-10", from: ["Hank Brown"], to: ["Zoe Zimmer"], claims: [{ interest: "mineral", fraction: "1/4", basis: "of_entire_estate" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    expect(out.findings.some(f => f.type === "SUCCESSION_EVIDENCE" && f.severity === "info" && /affidavit of heirship/.test(f.explanation))).toBe(true);
    expect(out.findings.some(f => f.type === "UNSUPPORTED_TRANSITION" && /Hank Brown|Helen Brown/.test(f.explanation))).toBe(false);
    expect(mineral.apparentHolders.some(h => h.status === "collective" && h.parties.length === 2)).toBe(true);
    expect(out.findings.some(f => f.type === "UNRESOLVED_ALLOCATION")).toBe(true);
  });

  it("applies stated per-heir shares from a probate record", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_entire_estate" }] },
      { type: "probate", executed: "2010-01-05", recorded: "2010-01-10", from: ["Bob Brown"], to: ["Hank Brown", "Helen Brown"], claims: [{ interest: "mineral", fraction: "1/2", basis: "of_grantor_interest" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    const heirs = mineral.apparentHolders.filter(h => /Brown/.test(h.parties[0].displayName));
    expect(heirs.map(h => share(h.share)).sort()).toEqual(["1/4", "1/4"]);
    // Alice (earliest evidenced holder) remains listed with an unquantified remainder — never dropped, never assumed.
    expect(mineral.apparentHolders.find(h => h.parties[0].displayName === "Alice Adams")!.share).toBeNull();
  });
});

describe("releases and encumbrances", () => {
  it("matches a full release by recording reference, reports a partial release, and reports an unmatched release without asserting an active lien", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "surface" }] },
      { type: "deed_of_trust", executed: "1991-01-05", recorded: "1991-01-10", number: "DT-1", from: ["Bob Brown"], to: ["First Bank"], claims: [{ interest: "surface", fraction: null }] },
      { type: "deed_of_trust", executed: "1992-01-05", recorded: "1992-01-10", number: "DT-2", from: ["Bob Brown"], to: ["Second Bank"], claims: [{ interest: "surface", fraction: null }] },
      { type: "deed_of_trust", executed: "1993-01-05", recorded: "1993-01-10", number: "DT-3", from: ["Bob Brown"], to: ["Third Bank"], claims: [{ interest: "surface", fraction: null }] },
      { type: "release", executed: "1995-01-05", recorded: "1995-01-10", from: ["First Bank"], to: ["Bob Brown"], references: [{ description: "release of DT-1", instrumentNumber: "DT-1", bookVolumePage: null, county: "Martin", relation: "released_obligation", page: 1 }], claims: [{ interest: "surface", fraction: null }] },
      { type: "release", executed: "1996-01-05", recorded: "1996-01-10", from: ["Second Bank"], to: ["Bob Brown"], references: [{ description: "partial release of DT-2", instrumentNumber: "DT-2", bookVolumePage: null, county: "Martin", relation: "released_obligation", page: 1 }], claims: [{ interest: "surface", fraction: "1/2", basis: "of_entire_estate" }] },
      { type: "release", executed: "1997-01-05", recorded: "1997-01-10", from: ["Unknown Lender"], to: ["Bob Brown"], references: [{ description: "release of DT-9", instrumentNumber: "DT-9", bookVolumePage: null, county: "Martin", relation: "released_obligation", page: 1 }], claims: [{ interest: "surface", fraction: null }] },
    ]);
    const surface = out.branches.find(b => b.interestType === "surface")!;
    const byNo = (n: string) => surface.encumbrances.find(e => e.recordingReference === `Inst. No. ${n}`)!;
    expect(byNo("DT-1").releaseStatus).toBe("release_located");
    expect(byNo("DT-2").releaseStatus).toBe("partial_release_located");
    expect(byNo("DT-3").releaseStatus).toBe("no_release_located_in_reviewed_records");
    const noRelease = out.findings.filter(f => f.type === "ENCUMBRANCE_NO_RELEASE");
    expect(noRelease.some(f => f.instrumentIds.includes(surface.encumbrances.find(e => e.recordingReference === "Inst. No. DT-3")!.instrumentId))).toBe(true);
    expect(noRelease.every(f => !/confirmed active|active lien/i.test(f.title))).toBe(true);
    expect(noRelease.some(f => /not a determination that the lien is active/.test(f.explanation))).toBe(true);
    expect(out.findings.some(f => f.type === "MISSING_REFERENCED_INSTRUMENT" && /does not match any encumbrance/.test(f.title))).toBe(true);
  });
});

describe("index-only evidence and signatures", () => {
  it("never interprets an index-only instrument and does not derive holdings from it", () => {
    const out = run([
      { executed: null, recorded: "1990-01-10", verified: false, from: ["Alice Adams"], to: ["Bob Brown"], claims: [{ interest: "mineral" }] },
    ]);
    const mineral = out.branches.find(b => b.interestType === "mineral")!;
    expect(mineral.events[0].support).toBe("not_evaluated");
    expect(mineral.apparentHolders).toHaveLength(0);
  });

  it("reports signature and representative-capacity observations without inventing co-signature rules", () => {
    const out = run([
      { executed: "1990-01-05", recorded: "1990-01-10", from: [{ name: "Alice Adams", capacity: "executor_administrator" }], to: ["Bob Brown"], signatures: [{ party: "Alice Adams", observed: "unclear", note: "no signature line", page: 2 }], claims: [{ interest: "mineral" }] },
    ]);
    const sig = out.findings.filter(f => f.type === "SIGNATURE_CAPACITY_CONCERN");
    expect(sig.some(f => /Signature not confirmed/.test(f.title))).toBe(true);
    expect(sig.some(f => /Representative capacity/.test(f.title))).toBe(true);
    expect(sig.every(f => !/all co-owners must sign|must be signed by all/i.test(f.explanation))).toBe(true);
  });
});
