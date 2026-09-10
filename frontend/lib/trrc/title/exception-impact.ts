/**
 * Turns findings into decision impact with EXPLICIT, INDEPENDENT properties.
 *
 * The four questions below are answered separately and never derived from
 * one another, because they genuinely come apart:
 *
 *   blocksClosing              must be cured or waived before legal closing
 *   decisionMaterial           could change the posture or the price paid
 *   quantifiable               a dollar impact CAN in principle be measured
 *   quantifiedValueImpactUsd   a dollar impact WAS measured
 *
 * An unreleased encumbrance blocks closing but is not decision-material at
 * the price level and cannot be priced. A competing ownership claim blocks
 * closing AND is decision-material AND is quantifiable AND was measured at
 * a specific figure. Those are not contradictory positions, and collapsing
 * them into one "severity" would lose the distinction a buyer needs.
 *
 * `quantifiable` is a property of the finding type. Whether it was actually
 * measured depends on the scenario engine having a readable fraction to
 * work from, which is why the two are stored apart.
 */

import type { ChainFinding, ChainFindingType } from "./chain-types";
import type { ExceptionImpact, ImpactChannel } from "./decision-types";
import { UNQUANTIFIED_LABEL } from "./decision-types";

export interface Quantifier {
  valueImpactUsd: number;
  nriFrom: number;
  nriTo: number;
  note: string;
}

interface Profile {
  affects: ImpactChannel[];
  affectsNote: string;
  blocksClosing: boolean;
  decisionMaterial: boolean;
  quantifiable: boolean;
  ownershipMaterial: boolean;
  requiresProfessionalReview: boolean;
  resolution: string;
  unquantifiedReason: string;
}

const PROFILES: Partial<Record<ChainFindingType, Profile>> = {
  UNSUPPORTED_TRANSITION: {
    affects: ["ownership", "nri", "value"],
    affectsNote: "A conveying party with no evidenced acquisition puts the size of every reconciled position in question.",
    blocksClosing: true, decisionMaterial: true, quantifiable: true, ownershipMaterial: true, requiresProfessionalReview: true,
    resolution: "Locate the instrument vesting the interest in that party, or obtain a release or disclaimer of the competing claim.",
    unquantifiedReason: "The conveyed fraction could not be read from the reviewed instrument, so the dilution cannot be measured.",
  },
  OVER_CONVEYANCE: {
    affects: ["ownership", "nri", "value"],
    affectsNote: "More interest has been conveyed than the estate contains, so at least one holder's share is overstated.",
    blocksClosing: true, decisionMaterial: true, quantifiable: true, ownershipMaterial: true, requiresProfessionalReview: true,
    resolution: "Reconcile the conflicting instruments and determine which conveyance controls.",
    unquantifiedReason: "Which holder absorbs the shortfall is not determinable from the reviewed records.",
  },
  CONFLICTING_CONVEYANCE: {
    affects: ["ownership", "nri", "value"],
    affectsNote: "The same interest appears to have been conveyed more than once.",
    blocksClosing: true, decisionMaterial: true, quantifiable: true, ownershipMaterial: true, requiresProfessionalReview: true,
    resolution: "Compare both instruments and check for an intervening reacquisition or correction deed.",
    unquantifiedReason: "Priority between conflicting conveyances is a legal determination, not a calculation.",
  },
  ENCUMBRANCE_NO_RELEASE: {
    affects: ["timing", "cost"],
    affectsNote: "A recorded encumbrance with no located release may require curative work before funds are released. It does not change the size of the ownership position.",
    blocksClosing: true, decisionMaterial: false, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: true,
    resolution: "Search the grantor index under the lender for a release, partial release, or satisfaction.",
    unquantifiedReason: "No outstanding balance is stated in the reviewed records, so the encumbrance cannot be priced.",
  },
  UNRESOLVED_ALLOCATION: {
    affects: ["ownership", "nri"],
    affectsNote: "A collective holding with no stated split means an individual seller's share is unknown, so what is actually being bought is undefined.",
    blocksClosing: true, decisionMaterial: true, quantifiable: false, ownershipMaterial: true, requiresProfessionalReview: false,
    resolution: "Obtain the recorded image to check for per-grantee fractions, or locate a partition instrument.",
    unquantifiedReason: "No split is stated in the instrument, and equal shares are never assumed.",
  },
  MISSING_REFERENCED_INSTRUMENT: {
    affects: ["ownership", "coverage"],
    affectsNote: "An instrument the chain refers to was not obtained, so part of the chain rests on an unread document.",
    blocksClosing: true, decisionMaterial: false, quantifiable: false, ownershipMaterial: true, requiresProfessionalReview: false,
    resolution: "Order the referenced instrument from the county and re-run the reconstruction.",
    unquantifiedReason: "The contents of an unretrieved instrument cannot be priced.",
  },
  IDENTITY_MISMATCH: {
    affects: ["ownership"],
    affectsNote: "Two similar names are carried as separate parties, leaving a link in the chain unproven.",
    blocksClosing: true, decisionMaterial: false, quantifiable: false, ownershipMaterial: true, requiresProfessionalReview: false,
    resolution: "Confirm from the instruments whether these are one party, then merge or keep separate.",
    unquantifiedReason: "Whether two parties are the same person is a factual question, not an economic one.",
  },
  INDEX_ONLY_EVIDENCE: {
    affects: ["ownership", "coverage"],
    affectsNote: "Instruments known only from a county index have not been read, so their effect on the estate is unknown.",
    blocksClosing: false, decisionMaterial: true, quantifiable: false, ownershipMaterial: true, requiresProfessionalReview: false,
    resolution: "Order the recorded images and re-run the reconstruction.",
    unquantifiedReason: "An unread instrument may convey anything or nothing; assigning it a value would be fabrication.",
  },
  UNRESOLVED_RESERVATION: {
    affects: ["ownership", "nri"],
    affectsNote: "A reservation whose fraction could not be read leaves the grantee's share unresolved.",
    blocksClosing: true, decisionMaterial: true, quantifiable: false, ownershipMaterial: true, requiresProfessionalReview: false,
    resolution: "Read the reservation clause in the recorded image and enter the reserved fraction.",
    unquantifiedReason: "The reserved fraction is not legible in the reviewed record.",
  },
  TIMING_AMBIGUITY: {
    affects: ["ownership"],
    affectsNote: "Execution and recording order differ, which can bear on priority between instruments.",
    blocksClosing: false, decisionMaterial: false, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: true,
    resolution: "Review both instruments together to establish which grantor interest each affected.",
    unquantifiedReason: "Priority is a legal determination and is not modelled here.",
  },
  SIGNATURE_CAPACITY_CONCERN: {
    affects: ["ownership"],
    affectsNote: "A conveying party's signature or authority to act is not confirmed in the reviewed text.",
    blocksClosing: false, decisionMaterial: false, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: true,
    resolution: "Inspect the recorded image for signature and acknowledgment, or locate the authority instrument.",
    unquantifiedReason: "Sufficiency of execution is a legal question.",
  },
  SUCCESSION_EVIDENCE: {
    affects: ["none"],
    affectsNote: "An ownership transition supported by succession evidence rather than a deed.",
    blocksClosing: false, decisionMaterial: false, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: true,
    resolution: "Confirm the probate order or heirship judgment and any allocation among successors.",
    unquantifiedReason: "Recorded as supporting evidence rather than as a risk.",
  },
  PROVIDER_UNAVAILABLE: {
    affects: ["coverage", "ownership"],
    affectsNote: "A county with no automated access limits how complete the search can be.",
    blocksClosing: false, decisionMaterial: true, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: false,
    resolution: "Complete a manual county search and add the instruments to the file.",
    unquantifiedReason: "Records never searched cannot be assigned a value.",
  },
  OCR_FAILED: {
    affects: ["coverage"],
    affectsNote: "A document that could not be read is absent from the reconstruction.",
    blocksClosing: false, decisionMaterial: false, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: false,
    resolution: "Re-upload a clearer scan or paste the instrument text.",
    unquantifiedReason: "An unread document cannot be priced.",
  },
};

const DEFAULT_PROFILE: Profile = {
  affects: ["ownership"],
  affectsNote: "Bears on the reconstructed ownership position.",
  blocksClosing: false, decisionMaterial: false, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: false,
  resolution: "Review the cited evidence and resolve before relying on the position.",
  unquantifiedReason: "No quantification rule is defined for this finding type.",
};

/** Plain-language statement of how this exception's four properties combine. */
function effectNote(p: Profile, measured: number | null): string {
  const parts: string[] = [];
  if (measured != null) {
    parts.push(`Measured at ${measured < 0 ? "−" : ""}$${Math.round(Math.abs(measured)).toLocaleString("en-US")}, so it can be priced into an offer.`);
  } else if (p.quantifiable) {
    parts.push("Quantifiable in principle, but the evidence needed to measure it is not in the file.");
  } else {
    parts.push("Not priceable from evidence of this kind.");
  }
  parts.push(p.blocksClosing
    ? "Must still be cured or waived before closing; pricing it does not remove it."
    : "Does not by itself prevent closing.");
  if (p.decisionMaterial) parts.push("Can change the posture or the price a buyer would pay.");
  if (p.requiresProfessionalReview) parts.push("Needs professional judgement rather than more data.");
  return parts.join(" ");
}

export function buildExceptionImpacts(
  findings: ChainFinding[],
  quantifiers: Record<string, Quantifier> = {},
): ExceptionImpact[] {
  return findings
    .filter(f => f.severity !== "info" || f.type === "SUCCESSION_EVIDENCE")
    .map(f => {
      const p = PROFILES[f.type as ChainFindingType] ?? DEFAULT_PROFILE;
      const q = quantifiers[f.findingId];
      const measured = q ? q.valueImpactUsd : null;
      return {
        findingId: f.findingId,
        type: f.type,
        severity: f.severity,
        issue: f.title,
        evidence: f.explanation,
        citations: f.citations,
        affects: p.affects,
        affectsNote: p.affectsNote,

        blocksClosing: p.blocksClosing,
        decisionMaterial: p.decisionMaterial,
        quantifiable: p.quantifiable,
        quantifiedValueImpactUsd: measured,
        ownershipMaterial: p.ownershipMaterial,
        requiresProfessionalReview: p.requiresProfessionalReview,

        nriImpact: q ? { from: q.nriFrom, to: q.nriTo } : null,
        unquantifiedReason: measured == null ? `${UNQUANTIFIED_LABEL}. ${p.unquantifiedReason}` : null,
        resolution: f.nextAction || p.resolution,
        decisionEffectNote: effectNote(p, measured),
      } satisfies ExceptionImpact;
    })
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
      return Number(b.blocksClosing) - Number(a.blocksClosing);
    });
}

/** Only measured adverse impacts contribute to exposure. */
export function totalQuantifiedExposure(impacts: ExceptionImpact[]): number {
  return impacts.reduce((s, i) => s + (i.quantifiedValueImpactUsd != null && i.quantifiedValueImpactUsd < 0 ? Math.abs(i.quantifiedValueImpactUsd) : 0), 0);
}
