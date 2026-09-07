/**
 * Ownership graph — reconstructs ownership branches per (canonical tract,
 * interest type) from content-verified instruments. Deterministic code
 * only: exact rational arithmetic (fraction.ts), explicit date sorting
 * with labeled fallbacks, no equal-share inference, no flattening of
 * multi-party instruments.
 *
 * What it asserts and what it refuses to assert:
 *   - A conveyance is "supported" only when the source party has an
 *     evidenced holding in the SAME tract and interest type at that point
 *     in the chronology (a name appearing as grantee elsewhere is not
 *     enough).
 *   - A fraction "of grantor's interest" is multiplied by the grantor's
 *     evidenced share; if that share is unknown the resulting share is
 *     unknown (null), never assumed.
 *   - Multiple grantees with no stated allocation are ONE collective
 *     holding with an unresolved allocation, not N equal shares.
 *   - Recording order sorts the display; it never decides legal effect.
 *   - Probate / heirship are evidence-bearing successions, not breaks.
 *   - An encumbrance with no matching release is reported as "no release
 *     located in reviewed records" — never as a confirmed active lien.
 */

import { Fraction, sumFractions } from "./fraction";
import type {
  ChainEvent, ChainFinding, ChainFindingType, ChainInterestType, ClaimEffect, DateBasis, EncumbranceRecord,
  ExtendedInstrumentType, ExtendedPartyCapacity, ExtendedPartyRole, FindingSeverity, FractionBasis, Holding,
  InterestScope, OwnershipBranch, PartyRef, CandidateTract, Citation, EventSupport,
} from "./chain-types";
import { INTEREST_TYPE_SCOPE, SOURCE_ROLES, TARGET_ROLES } from "./chain-types";
import type { ExtractedReference } from "./instrument-schema";
import type { HumanReviewStatus } from "./types";

// ─── Inputs (row-derived, DB-agnostic) ───────────────────────────────────────

export interface GraphParty {
  id: string;
  instrumentId: string;
  name: string;
  role: ExtendedPartyRole;
  capacity: ExtendedPartyCapacity;
  capacityDetail: string | null;
  canonicalPartyId: string | null;
  page: number | null;
  excerpt: string | null;
}

export interface GraphInstrument {
  id: string;
  documentId: string | null;
  instrumentType: ExtendedInstrumentType;
  executionDate: string | null;
  effectiveDate: string | null;
  recordedDate: string | null;
  instrumentNumber: string | null;
  bookVolumePage: string | null;
  county: string | null;
  contentVerified: boolean;
  references: ExtractedReference[];
  signatureObservations: Array<{ party: string; observed: "signed" | "not_signed" | "unclear"; note: string | null; page: number | null }>;
  sourceUrl: string | null;
  sourcePage: number | null;
}

export interface GraphClaim {
  id: string;
  instrumentId: string;
  instrumentTractId: string;
  canonicalTractId: string | null;
  effect: ClaimEffect;
  interestType: ChainInterestType;
  fraction: Fraction | null;
  fractionBasis: FractionBasis;
  fractionVerbatim: string | null;
  reservationText: string | null;
  exceptionsText: string | null;
  legalDescription: string | null;
  page: number | null;
  excerpt: string | null;
  reviewStatus: HumanReviewStatus;
}

export interface GraphInput {
  tracts: CandidateTract[];
  instruments: GraphInstrument[];
  parties: GraphParty[];
  claims: GraphClaim[];
  interestScope: InterestScope[];
}

export interface GraphOutput {
  branches: OwnershipBranch[];
  findings: ChainFinding[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let findingSeq = 0;
function makeFinding(type: ChainFindingType, severity: FindingSeverity, title: string, explanation: string, opts: {
  tract?: CandidateTract | null; interestType?: ChainInterestType | null; instrumentIds?: string[]; citations?: Citation[]; nextAction: string;
}): ChainFinding {
  findingSeq++;
  return {
    findingId: `f-${type.toLowerCase()}-${findingSeq}`,
    type, severity, title, explanation,
    affectedTractId: opts.tract?.id ?? null,
    affectedTractLabel: opts.tract?.tractLabel ?? null,
    affectedInterestType: opts.interestType ?? null,
    instrumentIds: opts.instrumentIds ?? [],
    citations: opts.citations ?? [],
    nextAction: opts.nextAction,
  };
}

function partyRef(p: GraphParty): PartyRef {
  return { canonicalPartyId: p.canonicalPartyId, instrumentPartyId: p.id, displayName: p.name, role: p.role, capacity: p.capacity, capacityDetail: p.capacityDetail };
}

function partyKey(p: PartyRef): string {
  return p.canonicalPartyId ?? `ip:${p.instrumentPartyId}`;
}

function citationFor(inst: GraphInstrument, claim?: GraphClaim | null, label?: string): Citation {
  return {
    documentId: inst.documentId,
    instrumentId: inst.id,
    page: claim?.page ?? inst.sourcePage ?? null,
    excerpt: claim?.excerpt ?? null,
    sourceUrl: inst.sourceUrl,
    label: label ?? recordingRef(inst),
  };
}

function recordingRef(inst: GraphInstrument): string | null {
  return inst.instrumentNumber ? `Inst. No. ${inst.instrumentNumber}` : inst.bookVolumePage ?? null;
}

function sortDateFor(inst: GraphInstrument): { sortDate: string | null; basis: DateBasis } {
  if (inst.recordedDate) return { sortDate: inst.recordedDate, basis: "recorded" };
  if (inst.executionDate) return { sortDate: inst.executionDate, basis: "execution" };
  if (inst.effectiveDate) return { sortDate: inst.effectiveDate, basis: "effective" };
  return { sortDate: null, basis: "undated" };
}

function dateKey(d: string | null): number {
  if (!d) return Number.POSITIVE_INFINITY;
  const t = Date.parse(d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

function daysBetween(a: string, b: string): number | null {
  const ka = dateKey(a), kb = dateKey(b);
  if (!Number.isFinite(ka) || !Number.isFinite(kb)) return null;
  return Math.round((kb - ka) / 86_400_000);
}

const DISPLAY_ORDER: ChainInterestType[] = ["surface", "mineral", "executive", "royalty", "nonparticipating_royalty", "overriding_royalty", "leasehold", "working_interest", "unknown"];

/** Branch key: leasehold and working_interest are one branch; royalty variants stay distinct. */
function branchInterest(t: ChainInterestType): ChainInterestType {
  return t === "working_interest" ? "leasehold" : t;
}

function inScope(interest: ChainInterestType, scope: InterestScope[]): boolean {
  const s = INTEREST_TYPE_SCOPE[interest];
  if (s === null) return true; // unknown interest types are reported so they get reviewed
  return scope.includes(s);
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

interface LedgerEntry {
  parties: PartyRef[];          // 1 normally; >1 for a collective holding
  share: Fraction | null;
  known: boolean;               // share is evidenced (true) vs unknown (false)
  root: boolean;                // seeded as earliest evidenced holder
  sourceEventIds: string[];
  note: string | null;
}

class Ledger {
  entries: LedgerEntry[] = [];

  find(key: string): LedgerEntry | undefined {
    return this.entries.find(e => e.parties.some(p => partyKey(p) === key));
  }
  isEmpty(): boolean { return this.entries.length === 0; }
  add(entry: LedgerEntry): void { this.entries.push(entry); }
  remove(entry: LedgerEntry): void { this.entries = this.entries.filter(e => e !== entry); }
  keys(): Set<string> { return new Set(this.entries.flatMap(e => e.parties.map(partyKey))); }
}

// ─── Core ────────────────────────────────────────────────────────────────────

export function buildOwnershipGraph(input: GraphInput): GraphOutput {
  findingSeq = 0;
  const findings: ChainFinding[] = [];
  const branches: OwnershipBranch[] = [];

  const instrumentsById = new Map(input.instruments.map(i => [i.id, i]));
  const partiesByInstrument = new Map<string, GraphParty[]>();
  for (const p of input.parties) {
    const list = partiesByInstrument.get(p.instrumentId);
    if (list) list.push(p); else partiesByInstrument.set(p.instrumentId, [p]);
  }

  // Every (tract, interest) group. Mineral branches are processed before
  // leasehold so lease grants can check the lessor against the mineral ledger.
  const groups = new Map<string, { tract: CandidateTract; interest: ChainInterestType; claims: GraphClaim[] }>();
  for (const tract of input.tracts) {
    if (tract.matchStatus === "rejected") continue;
    for (const claim of input.claims) {
      if (claim.canonicalTractId !== tract.id || claim.reviewStatus === "rejected") continue;
      const interest = branchInterest(claim.interestType);
      if (!inScope(interest, input.interestScope)) continue;
      const key = `${tract.id}:${interest}`;
      const g = groups.get(key);
      if (g) g.claims.push(claim); else groups.set(key, { tract, interest, claims: [claim] });
    }
  }

  const mineralLedgers = new Map<string, Ledger>();   // tractId -> mineral ledger, for lessor checks
  const orderedGroups = Array.from(groups.values()).sort((a, b) => DISPLAY_ORDER.indexOf(a.interest) - DISPLAY_ORDER.indexOf(b.interest));

  for (const group of orderedGroups) {
    const { tract, interest } = group;
    const ledger = new Ledger();
    const events: ChainEvent[] = [];
    const encumbrances: EncumbranceRecord[] = [];
    const releases: Array<{ inst: GraphInstrument; claim: GraphClaim; parties: GraphParty[] }> = [];
    const unresolvedAllocations: OwnershipBranch["unresolvedAllocations"] = [];
    const notes: string[] = [];
    let earliestEvidencedHolders: PartyRef[] = [];
    let earliestEvidencedDate: string | null = null;

    // Group claims by instrument so a deed's conveyance + reservation on the same interest are handled together.
    const byInstrument = new Map<string, GraphClaim[]>();
    for (const c of group.claims) {
      const list = byInstrument.get(c.instrumentId);
      if (list) list.push(c); else byInstrument.set(c.instrumentId, [c]);
    }

    const ordered = Array.from(byInstrument.entries())
      .map(([instrumentId, claims]) => ({ inst: instrumentsById.get(instrumentId)!, claims }))
      .filter(x => !!x.inst)
      .sort((a, b) => {
        const da = sortDateFor(a.inst), db = sortDateFor(b.inst);
        const diff = dateKey(da.sortDate) - dateKey(db.sortDate);
        if (diff !== 0) return diff;
        const ea = dateKey(a.inst.executionDate), eb = dateKey(b.inst.executionDate);
        if (ea !== eb) return ea - eb;
        return (a.inst.instrumentNumber ?? "").localeCompare(b.inst.instrumentNumber ?? "");
      });

    let prevExecution: string | null = null;
    let eventSeq = 0;

    for (const { inst, claims } of ordered) {
      const parties = partiesByInstrument.get(inst.id) ?? [];
      const from = parties.filter(p => SOURCE_ROLES.includes(p.role)).map(partyRef);
      const to = parties.filter(p => TARGET_ROLES.includes(p.role)).map(partyRef);
      const { sortDate, basis } = sortDateFor(inst);
      const primary = claims.find(c => c.effect !== "reservation") ?? claims[0];
      const reservation = claims.find(c => c.effect === "reservation") ?? null;
      const eventNotes: string[] = [];
      const citations = claims.map(c => citationFor(inst, c));
      eventSeq++;
      const eventId = `${tract.id}:${interest}:${eventSeq}`;

      if (basis !== "recorded") eventNotes.push(basis === "undated" ? "No date available; shown last" : `Sorted by ${basis} date (recording date unavailable)`);

      // Timing observations (recording order never determines effect).
      if (inst.executionDate && inst.recordedDate) {
        const gap = daysBetween(inst.executionDate, inst.recordedDate);
        if (gap !== null && gap > 730) {
          findings.push(makeFinding("TIMING_AMBIGUITY", "low", "Late-recorded instrument",
            `${describeInstrument(inst, from, to)} was executed ${inst.executionDate} and recorded ${inst.recordedDate} (${gap} days later). Intervening instruments may have been recorded first; priority is not determined here.`,
            { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Check for instruments recorded between execution and recording and confirm their effect on this interest." }));
        }
      }
      if (prevExecution && inst.executionDate && dateKey(inst.executionDate) < dateKey(prevExecution) && basis === "recorded") {
        findings.push(makeFinding("TIMING_AMBIGUITY", "medium", "Recording order differs from execution order",
          `${describeInstrument(inst, from, to)} was executed before an instrument recorded ahead of it. Both dates are retained; recording order alone is not used to decide effect or priority.`,
          { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Review both instruments together to determine which grantor interest each affected." }));
      }
      if (inst.executionDate) prevExecution = inst.executionDate;

      // Index-only rows: shown, never interpreted.
      if (!inst.contentVerified) {
        events.push({
          eventId, instrumentId: inst.id, claimId: primary.id, documentId: inst.documentId, instrumentType: inst.instrumentType, effect: primary.effect,
          sortDate, dateBasis: basis, executionDate: inst.executionDate, effectiveDate: inst.effectiveDate, recordedDate: inst.recordedDate,
          recordingReference: recordingRef(inst), from, to, statedFraction: null, fractionBasis: "unknown", fractionVerbatim: null,
          computedShare: null, support: "not_evaluated", contentVerified: false,
          notes: [...eventNotes, "County index entry only — instrument text not reviewed; conveyance language not interpreted"], citations,
        });
        continue;
      }

      // Signature / capacity observations for source parties.
      for (const p of parties.filter(x => SOURCE_ROLES.includes(x.role))) {
        const obs = inst.signatureObservations.find(o => o.party.toLowerCase() === p.name.toLowerCase());
        if (obs && obs.observed !== "signed") {
          findings.push(makeFinding("SIGNATURE_CAPACITY_CONCERN", obs.observed === "not_signed" ? "medium" : "low", "Signature not confirmed for a conveying party",
            `${p.name} (${p.role}) — signature ${obs.observed === "not_signed" ? "not observed" : "unclear"} in the reviewed text of ${describeInstrument(inst, from, to)}. ${obs.note ?? ""}`.trim(),
            { tract, interestType: interest, instrumentIds: [inst.id], citations: [citationFor(inst, null, p.name)], nextAction: "Inspect the recorded image for the signature and acknowledgment of this party." }));
        }
        if (["executor_administrator", "attorney_in_fact", "trustee", "successor"].includes(p.capacity)) {
          const hasAuthorityRef = inst.references.some(r => /letters|power\s+of\s+attorney|trust|merger|probate|order/i.test(r.description));
          if (!hasAuthorityRef) {
            findings.push(makeFinding("SIGNATURE_CAPACITY_CONCERN", "low", "Representative capacity without authority instrument in reviewed records",
              `${p.name} acted as ${p.capacityDetail ?? p.capacity.replace(/_/g, " ")} in ${describeInstrument(inst, from, to)}; no instrument evidencing that authority was located in the reviewed records.`,
              { tract, interestType: interest, instrumentIds: [inst.id], citations: [citationFor(inst, null, p.name)], nextAction: "Locate the letters testamentary, power of attorney, trust instrument, or merger record that supports this capacity." }));
          }
        }
      }

      // Effects that do not move ownership on this branch.
      if (primary.effect === "encumbrance") {
        encumbrances.push({ instrumentId: inst.id, instrumentType: inst.instrumentType, parties: [...from, ...to], recordedDate: inst.recordedDate, recordingReference: recordingRef(inst), releaseStatus: "no_release_located_in_reviewed_records", releaseInstrumentIds: [], notes: [], citations });
        events.push(baseEvent(eventId, inst, primary, from, to, sortDate, basis, "not_evaluated", [...eventNotes, "Encumbrance; does not transfer ownership"], citations));
        continue;
      }
      if (primary.effect === "release") {
        releases.push({ inst, claim: primary, parties });
        events.push(baseEvent(eventId, inst, primary, from, to, sortDate, basis, "not_evaluated", [...eventNotes, "Release; matched against encumbrances below"], citations));
        continue;
      }
      if (primary.effect === "other") {
        events.push(baseEvent(eventId, inst, primary, from, to, sortDate, basis, "not_evaluated", [...eventNotes, "Instrument recorded but its effect on this interest is not interpreted"], citations));
        continue;
      }

      // Root: the earliest evidenced holders are whoever conveys first.
      let support: EventSupport;
      if (ledger.isEmpty()) {
        support = "root";
        if (from.length === 0) {
          eventNotes.push("No conveying party identified; branch has no earliest evidenced holder");
        } else {
          for (const p of from) ledger.add({ parties: [p], share: null, known: false, root: true, sourceEventIds: [eventId], note: "Earliest evidenced holder — not established as original owner or root of title" });
          earliestEvidencedHolders = from;
          earliestEvidencedDate = sortDate;
          eventNotes.push("Earliest evidenced holder(s) in reviewed records — not a root of title");
        }
      } else {
        const supported = from.filter(p => ledger.find(partyKey(p)));
        support = supported.length === from.length && from.length > 0 ? "supported" : supported.length > 0 ? "partial" : "unsupported";
        if (support !== "supported") {
          const missing = from.filter(p => !ledger.find(partyKey(p)));
          const elsewhere = missing.filter(p => appearsAsTargetElsewhere(p, input, tract.id, interest, instrumentsById, partiesByInstrument));
          for (const p of missing) {
            const isElsewhere = elsewhere.includes(p);
            findings.push(makeFinding(isElsewhere ? "TRACT_INTEREST_MISMATCH" : "UNSUPPORTED_TRANSITION", isElsewhere ? "medium" : "high",
              isElsewhere ? "Conveying party's evidenced interest is in a different tract or interest type" : "No evidence the conveying party held this interest",
              `${p.displayName} conveyed a ${interest.replace(/_/g, " ")} interest in ${tract.tractLabel} by ${describeInstrument(inst, from, to)}, but the reviewed records show no earlier instrument vesting that interest in ${p.displayName} for this tract${isElsewhere ? " (their evidenced interest is in another tract or interest type)" : ""}. This may be a missing instrument, an unreviewed index entry, or a real discontinuity.`,
              { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: `Search ${inst.county ?? "the county"} records for an instrument vesting ${interest.replace(/_/g, " ")} interest in ${p.displayName} before ${sortDate ?? "this instrument"}.` }));
            // Unsupported grantor enters the ledger with an unknown share so downstream transfers can still be traced.
            ledger.add({ parties: [p], share: null, known: false, root: false, sourceEventIds: [eventId], note: "Entered without evidenced acquisition" });
          }
        }
      }

      // Lease grants: leasehold is created, lessor must hold minerals.
      if (primary.effect === "lease_grant") {
        const mineralLedger = mineralLedgers.get(tract.id);
        const lessorsWithoutMinerals = from.filter(p => !mineralLedger || !mineralLedger.find(partyKey(p)));
        if (lessorsWithoutMinerals.length > 0 && input.interestScope.includes("minerals")) {
          findings.push(makeFinding("UNSUPPORTED_TRANSITION", "medium", "Lessor without evidenced mineral interest",
            `${lessorsWithoutMinerals.map(p => p.displayName).join(", ")} executed ${describeInstrument(inst, from, to)} covering ${tract.tractLabel}, but no reviewed instrument vests a mineral interest in ${lessorsWithoutMinerals.length > 1 ? "them" : "that party"} for this tract.`,
            { tract, interestType: "mineral", instrumentIds: [inst.id], citations, nextAction: "Locate the mineral vesting instrument for the lessor, or confirm the lessor's interest from an unreviewed source." }));
        }
        const holding: LedgerEntry = { parties: to, share: null, known: false, root: false, sourceEventIds: [eventId], note: `Leasehold covering lessor's interest${primary.reservationText ? ` (${primary.reservationText})` : ""}` };
        ledger.add(holding);
        if (to.length > 1) unresolvedAllocations.push({ eventId, description: `Lease names ${to.length} lessees with no stated allocation between them` });
        events.push({ ...baseEvent(eventId, inst, primary, from, to, sortDate, basis, support, [...eventNotes, "Lease creates a leasehold estate; the lessor's mineral interest is not transferred"], citations) });
        continue;
      }

      // Succession: decedent -> heirs/devisees, evidence-bearing transition.
      if (primary.effect === "succession") {
        const decedentEntry = from[0] ? ledger.find(partyKey(from[0])) : undefined;
        const share = decedentEntry?.share ?? null;
        if (decedentEntry) ledger.remove(decedentEntry);
        const evidence = inst.instrumentType === "affidavit_of_heirship" ? "an affidavit of heirship (a sworn statement, not a court determination)" : inst.instrumentType === "probate" ? "a probate record" : "a succession instrument";
        findings.push(makeFinding("SUCCESSION_EVIDENCE", "info", "Ownership transition by succession",
          `${from.map(p => p.displayName).join(", ") || "A decedent"}'s ${interest.replace(/_/g, " ")} interest in ${tract.tractLabel} passed to ${to.map(p => p.displayName).join(", ") || "unnamed successors"} on the strength of ${evidence}. This is an evidence-bearing transition, not a break; the sufficiency of the succession evidence is a matter for professional review.`,
          { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Confirm the succession evidence (probate order, heirship judgment, or supporting affidavits) and any allocation among successors." }));
        if (to.length === 0) {
          eventNotes.push("No successors named; interest holder unresolved after this event");
          ledger.add({ parties: from, share, known: false, root: false, sourceEventIds: [eventId], note: "Decedent's interest — successors not identified" });
        } else if (to.length === 1 || (primary.fraction && primary.fractionBasis !== "unknown")) {
          // A single successor, or stated per-successor shares ("1/3 each"), can be applied; otherwise collective.
          if (to.length === 1) {
            ledger.add({ parties: [to[0]], share, known: share !== null, root: false, sourceEventIds: [eventId], note: null });
          } else {
            const each = primary.fraction ? (share ? share.mul(primary.fraction) : null) : null;
            for (const p of to) ledger.add({ parties: [p], share: each, known: each !== null, root: false, sourceEventIds: [eventId], note: `Stated share ${primary.fractionVerbatim ?? primary.fraction?.toString() ?? ""} of decedent's interest` });
          }
        } else {
          ledger.add({ parties: to, share, known: share !== null, root: false, sourceEventIds: [eventId], note: "Collective holding — allocation among successors not stated in reviewed records" });
          unresolvedAllocations.push({ eventId, description: `${to.length} successors named without stated shares; allocation not inferred` });
          findings.push(makeFinding("UNRESOLVED_ALLOCATION", "low", "Allocation among successors not stated",
            `${describeInstrument(inst, from, to)} names ${to.length} successors without stating each one's share. Equal shares are not assumed.`,
            { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Locate the will, heirship judgment, or a later partition/deed that states each successor's share." }));
        }
        events.push({ ...baseEvent(eventId, inst, primary, from, to, sortDate, basis, support, eventNotes, citations), computedShare: share?.toJSON() ?? null });
        continue;
      }

      // Conveyance / assignment (with optional reservation on the same interest).
      const moved = computeMovedShare(ledger, from, primary, reservation, eventNotes);
      if (moved.overConveyance) {
        findings.push(makeFinding("OVER_CONVEYANCE", "high", "Conveyance exceeds the grantor's evidenced interest",
          `${describeInstrument(inst, from, to)} conveys ${primary.fractionVerbatim ?? primary.fraction?.toString() ?? "an interest"} in ${tract.tractLabel} (${interest.replace(/_/g, " ")}), but the grantor's evidenced interest at that point is ${moved.grantorSharesBefore.map(s => s?.toString() ?? "unknown").join(" + ")}. Either an intervening instrument is missing or the conveyance is over-stated.`,
          { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Search for an intervening acquisition by the grantor, or a correction instrument; otherwise treat as a potential conflict." }));
      }
      if (moved.conflicting) {
        findings.push(makeFinding("CONFLICTING_CONVEYANCE", "high", "Grantor conveyed an interest already conveyed away",
          `${describeInstrument(inst, from, to)}: the reviewed records show the grantor's ${interest.replace(/_/g, " ")} interest in ${tract.tractLabel} had already been fully conveyed before this instrument.`,
          { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Compare the two conveyances and check for a reacquisition, correction deed, or misidentified party." }));
      }
      if (moved.ambiguousBasis) {
        findings.push(makeFinding("UNRESOLVED_ALLOCATION", "medium", "Fraction basis not stated",
          `${describeInstrument(inst, from, to)} states "${primary.fractionVerbatim ?? primary.fraction?.toString()}" without making clear whether it is a fraction of the entire ${interest.replace(/_/g, " ")} estate or of the grantor's interest. Neither reading is assumed; the resulting share is left unresolved.`,
          { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Read the granting clause in the recorded image and confirm the stated basis." }));
      }
      if (moved.multiSourceUnallocated) {
        unresolvedAllocations.push({ eventId, description: `${from.length} grantors conveyed collectively; the reduction to each grantor's share is not stated` });
      }
      if (reservation) {
        if (!reservation.fraction) {
          findings.push(makeFinding("UNRESOLVED_RESERVATION", "medium", "Reservation without a parseable fraction",
            `${describeInstrument(inst, from, to)} contains a reservation (${truncate(reservation.reservationText ?? reservation.excerpt ?? "text not captured", 200)}) whose fraction could not be determined. The grantee's share of this interest is left unresolved.`,
            { tract, interestType: interest, instrumentIds: [inst.id], citations: [citationFor(inst, reservation, "reservation")], nextAction: "Read the reservation clause in the recorded image and enter the reserved fraction." }));
        } else if (moved.reservationExceeds) {
          findings.push(makeFinding("FRACTION_INCONSISTENCY", "high", "Reservation exceeds the grantor's evidenced interest",
            `${describeInstrument(inst, from, to)} reserves ${reservation.fractionVerbatim ?? reservation.fraction.toString()} of the ${interest.replace(/_/g, " ")} estate, more than the grantor's evidenced share.`,
            { tract, interestType: interest, instrumentIds: [inst.id], citations: [citationFor(inst, reservation, "reservation")], nextAction: "Verify the grantor's prior acquisitions; a reservation cannot exceed what the grantor held." }));
        }
      }
      if (reservation?.exceptionsText || primary.exceptionsText) {
        eventNotes.push(`Exceptions/subject-to language present: ${truncate(reservation?.exceptionsText ?? primary.exceptionsText ?? "", 160)}`);
      }

      // Targets: collective when more than one with no per-grantee claim.
      if (to.length > 0) {
        const targetEntry: LedgerEntry = {
          parties: to, share: moved.share, known: moved.share !== null, root: false, sourceEventIds: [eventId],
          note: to.length > 1 ? "Collective holding — allocation among grantees not stated" : moved.note,
        };
        // Merge with an existing holding for the same single party (accumulate share).
        const existing = to.length === 1 ? ledger.find(partyKey(to[0])) : undefined;
        if (existing && existing.parties.length === 1) {
          existing.share = existing.share && moved.share ? existing.share.add(moved.share) : null;
          existing.known = existing.share !== null;
          existing.sourceEventIds.push(eventId);
          existing.root = false;
        } else {
          ledger.add(targetEntry);
        }
        if (to.length > 1) {
          unresolvedAllocations.push({ eventId, description: `${to.length} grantees named without stated allocation; equal shares not assumed` });
          findings.push(makeFinding("UNRESOLVED_ALLOCATION", "low", "Allocation among grantees not stated",
            `${describeInstrument(inst, from, to)} names ${to.length} grantees without stating each one's share; the interest is carried as a collective holding.`,
            { tract, interestType: interest, instrumentIds: [inst.id], citations, nextAction: "Check the granting clause for per-grantee fractions, or a later partition instrument." }));
        }
      } else {
        eventNotes.push("No receiving party identified; conveyed share is unassigned");
      }

      events.push({
        ...baseEvent(eventId, inst, primary, from, to, sortDate, basis, support, eventNotes, citations),
        computedShare: moved.share?.toJSON() ?? null,
      });
    }

    // Releases -> encumbrances.
    for (const rel of releases) {
      const relRefs = rel.inst.references.filter(r => r.relation === "released_obligation" || r.relation === "other");
      const match = encumbrances.find(e => {
        const enc = instrumentsById.get(e.instrumentId)!;
        const byRef = relRefs.some(r => (r.instrumentNumber && r.instrumentNumber === enc.instrumentNumber) || (r.bookVolumePage && r.bookVolumePage === enc.bookVolumePage));
        const relFrom = rel.parties.filter(p => SOURCE_ROLES.includes(p.role)).map(p => partyKey(partyRef(p)));
        const encLenders = e.parties.filter(p => p.role === "lender" || p.role === "grantee").map(partyKey);
        const byParty = relFrom.some(k => encLenders.includes(k));
        return byRef || byParty;
      });
      if (!match) {
        findings.push(makeFinding("MISSING_REFERENCED_INSTRUMENT", "low", "Release does not match any encumbrance in reviewed records",
          `${describeInstrument(rel.inst, [], [])} releases an obligation that was not found among the reviewed instruments for ${tract.tractLabel}.`,
          { tract, interestType: interest, instrumentIds: [rel.inst.id], citations: [citationFor(rel.inst, rel.claim)], nextAction: "Locate the released deed of trust or lien to confirm the release's scope." }));
        continue;
      }
      const partial = (rel.claim.fraction && rel.claim.fraction.lt(Fraction.one())) || (rel.claim.legalDescription && match.citations[0]?.excerpt && !sameLegal(rel.claim.legalDescription, match.citations[0].excerpt));
      match.releaseStatus = partial ? "partial_release_located" : "release_located";
      match.releaseInstrumentIds.push(rel.inst.id);
      match.notes.push(partial ? `Partial release located: ${recordingRef(rel.inst) ?? rel.inst.id}` : `Release located: ${recordingRef(rel.inst) ?? rel.inst.id}`);
    }
    for (const e of encumbrances) {
      if (e.releaseStatus === "no_release_located_in_reviewed_records") {
        const enc = instrumentsById.get(e.instrumentId)!;
        findings.push(makeFinding("ENCUMBRANCE_NO_RELEASE", "medium", "No release located in reviewed records",
          `${describeInstrument(enc, e.parties.filter(p => SOURCE_ROLES.includes(p.role)), e.parties.filter(p => TARGET_ROLES.includes(p.role)))} encumbers ${tract.tractLabel}; no release matching it was found in the reviewed records. This is not a determination that the lien is active.`,
          { tract, interestType: interest, instrumentIds: [e.instrumentId], citations: e.citations, nextAction: "Search the county records for a release, partial release, or satisfaction referencing this instrument." }));
      } else if (e.releaseStatus === "partial_release_located") {
        findings.push(makeFinding("ENCUMBRANCE_NO_RELEASE", "low", "Only a partial release located",
          `A partial release was located for the encumbrance ${e.recordingReference ?? e.instrumentId} on ${tract.tractLabel}; the remainder has no release in the reviewed records.`,
          { tract, interestType: interest, instrumentIds: [e.instrumentId, ...e.releaseInstrumentIds], citations: e.citations, nextAction: "Confirm what the partial release covers and search for a full release." }));
      }
    }

    // Apparent holders.
    const apparentHolders: Holding[] = ledger.entries
      .filter(e => !(e.share && e.share.isZero()))
      .map((e, i) => ({
        holdingId: `${tract.id}:${interest}:h${i + 1}`,
        parties: e.parties,
        share: e.share?.toJSON() ?? null,
        shareNote: e.note,
        status: e.parties.length > 1 ? "collective" : e.root ? "earliest_evidenced" : e.share === null ? "unresolved" : "apparent",
        sourceEventIds: e.sourceEventIds,
      }));

    const total = sumFractions(ledger.entries.map(e => e.share));
    if (total && total.gt(Fraction.one())) {
      findings.push(makeFinding("FRACTION_INCONSISTENCY", "high", "Evidenced shares exceed the whole",
        `The evidenced ${interest.replace(/_/g, " ")} shares in ${tract.tractLabel} sum to ${total.toString()} (> 1). At least one instrument over-states an interest or a conveyance is duplicated.`,
        { tract, interestType: interest, instrumentIds: [], citations: [], nextAction: "Reconcile the fractions instrument by instrument against the recorded images." }));
    }
    if (interest === "mineral") mineralLedgers.set(tract.id, ledger);

    branches.push({
      branchId: `${tract.id}:${interest}`,
      tractId: tract.id,
      tractLabel: tract.tractLabel,
      interestType: interest,
      scope: INTEREST_TYPE_SCOPE[interest],
      events,
      earliestEvidencedHolders,
      earliestEvidencedDate,
      apparentHolders,
      encumbrances,
      unresolvedAllocations,
      notes,
    });
  }

  return { branches, findings };
}

// ─── Share arithmetic ────────────────────────────────────────────────────────

interface MovedShare {
  share: Fraction | null;
  note: string | null;
  overConveyance: boolean;
  conflicting: boolean;
  ambiguousBasis: boolean;
  multiSourceUnallocated: boolean;
  reservationExceeds: boolean;
  grantorSharesBefore: Array<Fraction | null>;
}

function computeMovedShare(ledger: Ledger, from: PartyRef[], claim: GraphClaim, reservation: GraphClaim | null, notes: string[]): MovedShare {
  const result: MovedShare = { share: null, note: null, overConveyance: false, conflicting: false, ambiguousBasis: false, multiSourceUnallocated: false, reservationExceeds: false, grantorSharesBefore: [] };
  const entries = from.map(p => ledger.find(partyKey(p)) ?? null);
  result.grantorSharesBefore = entries.map(e => e?.share ?? null);
  const fraction = claim.fraction;
  const basis = claim.fractionBasis;
  const grantorTotal = sumFractions(entries.map(e => e?.share ?? null));
  const reserved = reservation?.fraction ?? null;

  if (entries.some(e => e && e.share && e.share.isZero())) result.conflicting = true;

  if (!fraction) {
    notes.push("Fraction not stated; conveyed share not computed");
  } else if (basis === "of_entire_estate") {
    result.share = fraction;
    if (grantorTotal && fraction.gt(grantorTotal)) result.overConveyance = true;
    if (reserved && entries.length === 1 && entries[0]?.share && reserved.gt(entries[0].share)) result.reservationExceeds = true;
    // Reduce grantors.
    if (entries.length === 1 && entries[0]) {
      entries[0].share = entries[0].share ? entries[0].share.sub(fraction) : null;
      entries[0].known = entries[0].share !== null;
      if (entries[0].share && entries[0].share.isNegative()) entries[0].share = Fraction.zero();
    } else {
      for (const e of entries) if (e) { e.share = null; e.known = false; }
      if (entries.length > 1) result.multiSourceUnallocated = true;
    }
    result.note = `Stated as ${claim.fractionVerbatim ?? fraction.toString()} of the entire estate`;
  } else if (basis === "of_grantor_interest") {
    const knownAll = entries.length > 0 && entries.every(e => e && e.share !== null);
    if (knownAll) {
      let moved = Fraction.zero();
      for (const e of entries) {
        const part = (e!.share as Fraction).mul(fraction);
        moved = moved.add(part);
        e!.share = (e!.share as Fraction).sub(part);
        e!.known = true;
      }
      if (reserved) {
        if (reserved.gt(moved)) result.reservationExceeds = true;
        moved = moved.sub(reserved);
        if (moved.isNegative()) moved = Fraction.zero();
        // The reserving grantor keeps the reserved fraction.
        if (entries[0]) { entries[0].share = (entries[0].share as Fraction).add(reserved); }
      }
      result.share = moved;
      result.note = `${claim.fractionVerbatim ?? fraction.toString()} of grantor's evidenced interest (${entries.map(e => e!.share?.toString()).join(", ")} remaining)`;
    } else {
      result.share = null;
      notes.push(`Stated as ${claim.fractionVerbatim ?? fraction.toString()} of grantor's interest; grantor's interest is not quantified in reviewed records, so the resulting share is unresolved`);
      for (const e of entries) if (e) { e.known = false; if (fraction.eq(Fraction.one()) && !reserved) e.share = Fraction.zero(); else e.share = null; }
      if (reserved && entries[0]) {
        // The reservation is a stated fraction of the entire estate — carried as the document's claim, with the caveat that the grantor's underlying interest was never quantified.
        entries[0].share = reserved;
        entries[0].known = false;
        entries[0].note = `Retains reserved ${reservation?.fractionVerbatim ?? reserved.toString()} as stated — subject to grantor's underlying (unquantified) interest`;
      }
    }
  } else {
    result.ambiguousBasis = true;
    result.share = null;
    for (const e of entries) if (e) { e.share = null; e.known = false; }
    notes.push("Fraction basis ambiguous; share not computed");
  }

  if (reserved && basis === "of_entire_estate" && entries[0]) {
    entries[0].share = reserved;
    entries[0].known = true;
    entries[0].note = `Retains reserved ${reservation?.fractionVerbatim ?? reserved.toString()}`;
  }
  return result;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function baseEvent(eventId: string, inst: GraphInstrument, claim: GraphClaim, from: PartyRef[], to: PartyRef[], sortDate: string | null, basis: DateBasis, support: EventSupport, notes: string[], citations: Citation[]): ChainEvent {
  return {
    eventId, instrumentId: inst.id, claimId: claim.id, documentId: inst.documentId, instrumentType: inst.instrumentType, effect: claim.effect,
    sortDate, dateBasis: basis, executionDate: inst.executionDate, effectiveDate: inst.effectiveDate, recordedDate: inst.recordedDate,
    recordingReference: recordingRef(inst), from, to,
    statedFraction: claim.fraction?.toJSON() ?? null, fractionBasis: claim.fractionBasis, fractionVerbatim: claim.fractionVerbatim,
    computedShare: null, support, contentVerified: inst.contentVerified, notes, citations,
  };
}

function describeInstrument(inst: GraphInstrument, from: PartyRef[], to: PartyRef[]): string {
  const type = inst.instrumentType.replace(/_/g, " ");
  const ref = recordingRef(inst);
  const parties = from.length || to.length ? ` (${from.map(p => p.displayName).join(", ") || "?"} → ${to.map(p => p.displayName).join(", ") || "?"})` : "";
  return `the ${type}${ref ? ` ${ref}` : ""}${inst.recordedDate ? ` recorded ${inst.recordedDate}` : inst.executionDate ? ` dated ${inst.executionDate}` : ""}${parties}`;
}

function appearsAsTargetElsewhere(p: PartyRef, input: GraphInput, tractId: string, interest: ChainInterestType, instrumentsById: Map<string, GraphInstrument>, partiesByInstrument: Map<string, GraphParty[]>): boolean {
  const key = partyKey(p);
  for (const claim of input.claims) {
    if (claim.canonicalTractId === tractId && branchInterest(claim.interestType) === interest) continue;
    const parties = partiesByInstrument.get(claim.instrumentId) ?? [];
    if (parties.some(x => TARGET_ROLES.includes(x.role) && partyKey(partyRef(x)) === key) && instrumentsById.get(claim.instrumentId)?.contentVerified) return true;
  }
  return false;
}

function sameLegal(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b) || norm(b).includes(norm(a)) || norm(a).includes(norm(b));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
