/**
 * FIXTURES — synthetic instrument texts and graph inputs for the title-chain
 * engine tests. Every party, tract, and recording reference here is
 * invented for testing; none of it is live TRRC or county data.
 */

import { Fraction } from "../../fraction";
import type { CandidateTract, ChainInterestType, ClaimEffect, ExtendedInstrumentType, ExtendedPartyRole, FractionBasis } from "../../chain-types";
import type { GraphClaim, GraphInstrument, GraphParty } from "../../ownership-graph";

export const WARRANTY_DEED_TEXT = `WARRANTY DEED WITH MINERAL RESERVATION

THE STATE OF TEXAS §
COUNTY OF MARTIN §

THAT WE, JOHN A. DOE and MARY B. DOE, husband and wife, of Martin County, Texas ("Grantor"), for and in consideration of Ten Dollars and other good and valuable consideration paid by RICHARD ROE ("Grantee"), have GRANTED, SOLD and CONVEYED and by these presents do GRANT, SELL and CONVEY unto Grantee all of that certain tract of land described as follows:

160.0 acres of land, more or less, being the NE/4 of Section 12, Block 35, T-2-S, T&P RR Co. Survey, Abstract No. 1234, Martin County, Texas, being the same land conveyed to Grantor by deed recorded in Volume 210, Page 44 of the Deed Records of Martin County, Texas.

There is reserved unto Grantor, their heirs and assigns, an undivided one-half (1/2) interest in and to all of the oil, gas and other minerals in and under and that may be produced from the above described land.

This conveyance is made subject to all valid easements of record.

EXECUTED this 3rd day of March, 1998.

/s/ John A. Doe
/s/ Mary B. Doe

THE STATE OF TEXAS §
COUNTY OF MARTIN §
BEFORE ME, the undersigned notary public, on this day personally appeared JOHN A. DOE and MARY B. DOE, known to me to be the persons whose names are subscribed to the foregoing instrument, and acknowledged to me that they executed the same. Given under my hand and seal of office this 3rd day of March, 1998.

FILED FOR RECORD on the 10th day of March, 1998, Volume 512, Page 88, Official Public Records of Martin County, Texas.`;

export const MINERAL_DEED_TEXT = `MINERAL DEED

RICHARD ROE, a single man ("Grantor"), for value received, does hereby GRANT, BARGAIN, SELL and CONVEY unto ACME MINERALS, LLC, a Texas limited liability company ("Grantee"), an undivided 1/4 interest in and to all of the oil, gas and other minerals in and under the NE/4 of Section 12, Block 35, T-2-S, T&P RR Co. Survey, Abstract No. 1234, Martin County, Texas.

EXECUTED this 15th day of June, 2005.
/s/ Richard Roe
FILED FOR RECORD June 20, 2005, Document No. 2005-004411, Official Public Records of Martin County, Texas.`;

// ─── Graph-input builders ────────────────────────────────────────────────────

export const TRACT_A: CandidateTract = {
  id: "tract-a", tractLabel: "T&P RR Co. Survey, A-1234, Blk 35, Sec 12, Martin County", county: "Martin", abstractNumber: "A-1234", surveyName: "T&P RR Co.",
  blockNumber: "35", sectionName: "12", legalDescription: "NE/4 of Section 12, Block 35", grossAcres: 160, confidence: 0.9, resolutionMethod: "test", resolutionTrace: [], needsUserSelection: false, matchStatus: "confirmed",
};
export const TRACT_B: CandidateTract = { ...TRACT_A, id: "tract-b", tractLabel: "T&P RR Co. Survey, A-1235, Blk 35, Sec 13, Martin County", abstractNumber: "A-1235", sectionName: "13", legalDescription: "Section 13" };

let seq = 0;
export interface InstrumentSpec {
  id?: string;
  type?: ExtendedInstrumentType;
  executed?: string | null;
  recorded?: string | null;
  effective?: string | null;
  number?: string | null;
  from: Array<string | { name: string; capacity?: GraphParty["capacity"]; role?: ExtendedPartyRole }>;
  to: Array<string | { name: string; capacity?: GraphParty["capacity"]; role?: ExtendedPartyRole }>;
  claims: Array<{ tract?: string; interest: ChainInterestType; effect?: ClaimEffect; fraction?: string | null; basis?: FractionBasis; reservationText?: string | null; legal?: string | null }>;
  verified?: boolean;
  references?: GraphInstrument["references"];
  signatures?: GraphInstrument["signatureObservations"];
}

export function buildGraphInput(specs: InstrumentSpec[], tracts: CandidateTract[] = [TRACT_A]) {
  const instruments: GraphInstrument[] = [];
  const parties: GraphParty[] = [];
  const claims: GraphClaim[] = [];
  const canonical = new Map<string, string>();
  const canon = (name: string) => {
    const key = name.trim().toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ");
    if (!canonical.has(key)) canonical.set(key, `cp-${canonical.size + 1}`);
    return canonical.get(key)!;
  };
  const defaultSourceRole: Record<string, ExtendedPartyRole> = { lease: "lessor", assignment: "assignor", release: "releasor", deed_of_trust: "borrower", probate: "decedent", affidavit_of_heirship: "decedent" };
  const defaultTargetRole: Record<string, ExtendedPartyRole> = { lease: "lessee", assignment: "assignee", release: "releasee", deed_of_trust: "lender", probate: "heir", affidavit_of_heirship: "heir" };

  for (const s of specs) {
    seq++;
    const id = s.id ?? `inst-${seq}`;
    const type = s.type ?? "deed";
    instruments.push({
      id, documentId: `doc-${id}`, instrumentType: type, executionDate: s.executed ?? null, effectiveDate: s.effective ?? null, recordedDate: s.recorded ?? null,
      instrumentNumber: s.number ?? null, bookVolumePage: null, county: "Martin", contentVerified: s.verified ?? true, references: s.references ?? [],
      signatureObservations: s.signatures ?? [], sourceUrl: null, sourcePage: 1,
    });
    for (const p of s.from) {
      const spec = typeof p === "string" ? { name: p } : p;
      parties.push({ id: `${id}-from-${parties.length}`, instrumentId: id, name: spec.name, role: spec.role ?? defaultSourceRole[type] ?? "grantor", capacity: spec.capacity ?? "individual", capacityDetail: null, canonicalPartyId: canon(spec.name), page: 1, excerpt: null });
    }
    for (const p of s.to) {
      const spec = typeof p === "string" ? { name: p } : p;
      parties.push({ id: `${id}-to-${parties.length}`, instrumentId: id, name: spec.name, role: spec.role ?? defaultTargetRole[type] ?? "grantee", capacity: spec.capacity ?? "individual", capacityDetail: null, canonicalPartyId: canon(spec.name), page: 1, excerpt: null });
    }
    for (const c of s.claims) {
      const tractId = c.tract ?? tracts[0].id;
      claims.push({
        id: `${id}-claim-${claims.length}`, instrumentId: id, instrumentTractId: `${id}-it-${claims.length}`, canonicalTractId: tractId,
        effect: c.effect ?? (type === "lease" ? "lease_grant" : type === "assignment" ? "assignment" : type === "release" ? "release" : type === "deed_of_trust" || type === "lien" ? "encumbrance" : type === "probate" || type === "affidavit_of_heirship" ? "succession" : "conveyance"),
        interestType: c.interest, fraction: c.fraction === undefined ? Fraction.one() : c.fraction === null ? null : Fraction.parse(c.fraction),
        fractionBasis: c.basis ?? (c.fraction === undefined ? "of_grantor_interest" : "of_entire_estate"), fractionVerbatim: c.fraction ?? null,
        reservationText: c.reservationText ?? null, exceptionsText: null, legalDescription: c.legal ?? null, page: 1, excerpt: null, reviewStatus: "unreviewed",
      });
    }
  }
  return { tracts, instruments, parties, claims };
}
