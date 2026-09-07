/**
 * Chronological instrument timeline per canonical tract, plus Phase 1's
 * surface-level checks — all named and framed as POTENTIAL findings, never
 * confirmed defects, since none of them have been walked against a real
 * reconciled ledger yet.
 *
 * Chain-discontinuity detection deliberately does NOT assume a tract's
 * claims form a single linear sequence (title branches across multiple
 * owners, tracts, and fractional interests — two claims next to each other
 * in date order may involve entirely unrelated branches of ownership). The
 * actual check: for each grantor on a claim, does that same canonical party
 * appear as a grantee on any EARLIER claim for the SAME canonical tract? If
 * not, that's a potential discontinuity — and even then, it's explicitly
 * labeled "potential" because the acquisition instrument may simply be
 * missing from the available dataset or predate the search period, not
 * because the conveyance is actually unsupported.
 */

import type { EnrichedClaim, TractTimeline, TimelineResult, TitleTimelineGap, CanonicalTract } from "./types";

function parseDate(claim: EnrichedClaim): number {
  const raw = claim.instrument.instrumentDate ?? claim.instrument.recordedDate;
  if (!raw) return Number.POSITIVE_INFINITY; // undated claims sort last, never silently dropped
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function canonicalIds(parties: EnrichedClaim["grantors"]): Set<string> {
  return new Set(parties.map(p => p.canonicalPartyId).filter((id): id is string => !!id));
}

/** Grantor with no earlier observed acquisition event for the same canonical tract — labeled a POTENTIAL discontinuity, not a confirmed break. */
function detectPotentialChainDiscontinuities(canonicalTractId: string, sorted: EnrichedClaim[]): TitleTimelineGap[] {
  const gaps: TitleTimelineGap[] = [];
  const observedAsGranteeSoFar = new Set<string>();

  for (const claim of sorted) {
    const grantorIds = canonicalIds(claim.grantors);
    const unsupported = Array.from(grantorIds).filter(id => !observedAsGranteeSoFar.has(id));

    // Only flag when the grantor's canonical identity is actually known (unmatched/unresolved parties are already a disclosed data gap elsewhere, not a redundant discontinuity finding here).
    if (unsupported.length > 0) {
      const grantorNames = claim.grantors.filter(g => g.canonicalPartyId && unsupported.includes(g.canonicalPartyId)).map(g => g.partyName);
      if (grantorNames.length > 0) {
        gaps.push({
          type: "POTENTIAL_CHAIN_DISCONTINUITY",
          canonicalTractId,
          description: `${grantorNames.join(", ")} conveyed an interest in this tract, but no earlier claim in the available data shows how they acquired it — this may reflect a real gap, or simply an acquisition instrument outside what was retrieved or searched`,
          claimIds: [claim.claim.id],
        });
      }
    }

    for (const id of Array.from(canonicalIds(claim.grantees))) observedAsGranteeSoFar.add(id);
  }

  return gaps;
}

function detectPossibleDuplicateInstruments(canonicalTractId: string, claims: EnrichedClaim[]): TitleTimelineGap[] {
  const gaps: TitleTimelineGap[] = [];
  const seen = new Map<string, EnrichedClaim>();

  for (const claim of claims) {
    const grantorKey = Array.from(canonicalIds(claim.grantors)).sort().join(",");
    const granteeKey = Array.from(canonicalIds(claim.grantees)).sort().join(",");
    const key = [grantorKey, granteeKey, claim.instrument.instrumentDate ?? "", claim.instrument.docNumber ?? ""].join("|");
    const prior = seen.get(key);
    if (prior) {
      gaps.push({
        type: "POSSIBLE_DUPLICATE_INSTRUMENT",
        canonicalTractId,
        description: "Two instruments record the same parties, date, and document number for this tract — may be a duplicate index entry, or two genuinely separate instruments that happen to share these fields",
        claimIds: [prior.claim.id, claim.claim.id],
      });
    } else {
      seen.set(key, claim);
    }
  }
  return gaps;
}

function detectVariances(canonicalTractId: string, claims: EnrichedClaim[]): TitleTimelineGap[] {
  const gaps: TitleTimelineGap[] = [];

  const withAcreage = claims.filter(c => c.tract.grossAcres !== null);
  const distinctAcreages = new Set(withAcreage.map(c => c.tract.grossAcres));
  if (withAcreage.length >= 2 && distinctAcreages.size > 1) {
    gaps.push({
      type: "POTENTIAL_ACREAGE_VARIANCE",
      canonicalTractId,
      description: `Claims grouped onto this tract report different gross acreage figures (${Array.from(distinctAcreages).join(", ")}) — may reflect a parent/child tract split, a partial conveyance, a correction, or a genuine discrepancy worth checking`,
      claimIds: withAcreage.map(c => c.claim.id),
    });
  }

  const withLegal = claims.filter(c => c.tract.legalDescription !== null);
  const distinctLegal = new Set(withLegal.map(c => c.tract.legalDescription!.trim().toLowerCase()));
  if (withLegal.length >= 2 && distinctLegal.size > 1) {
    gaps.push({
      type: "POTENTIAL_DESCRIPTION_VARIANCE",
      canonicalTractId,
      description: "Claims grouped onto this tract (via coarser county/abstract/survey/block/section matching) carry different legal-description text — may reflect a survey-description change, multiple tracts genuinely combined under one coarse match, or a real inconsistency worth checking",
      claimIds: withLegal.map(c => c.claim.id),
    });
  }

  return gaps;
}

export function buildTitleTimeline(tracts: CanonicalTract[], enrichedByTract: Record<string, EnrichedClaim[]>): TimelineResult {
  const result: TractTimeline[] = [];
  let totalGapCount = 0;

  for (const tract of tracts) {
    const claims = enrichedByTract[tract.id] ?? [];
    const sorted = [...claims].sort((a, b) => parseDate(a) - parseDate(b));

    const gaps = [
      ...detectPotentialChainDiscontinuities(tract.id, sorted),
      ...detectPossibleDuplicateInstruments(tract.id, sorted),
      ...detectVariances(tract.id, sorted),
    ];
    totalGapCount += gaps.length;

    const dated = sorted.filter(c => c.instrument.instrumentDate || c.instrument.recordedDate);
    result.push({
      canonicalTractId: tract.id,
      claims: sorted,
      gaps,
      earliestInstrumentDate: dated[0]?.instrument.instrumentDate ?? dated[0]?.instrument.recordedDate ?? null,
      latestInstrumentDate: dated[dated.length - 1]?.instrument.instrumentDate ?? dated[dated.length - 1]?.instrument.recordedDate ?? null,
    });
  }

  return { tracts: result, totalGapCount };
}
