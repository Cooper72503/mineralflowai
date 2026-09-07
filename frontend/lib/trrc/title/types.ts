/**
 * Shared schemas for the Title Resolution / Ownership Graph engine — Phase 1
 * (revised).
 *
 * Reuses the geology engine's StatementClassification (observed/calculated/
 * inferred) rather than redefining it.
 *
 * Schema shape: an INSTRUMENT (the document) has many PARTIES (grantor/
 * grantee, role + capacity) and many TRACTS (legal description + interest
 * figures for one piece of land covered by that instrument). A CLAIM is the
 * derived assertion linking one instrument to one tract — "this instrument
 * conveyed some interest in this tract" — read alongside title_instrument_
 * parties rather than duplicating grantor/grantee as free text on the claim
 * itself. This avoids collapsing real multi-grantor/multi-grantee deeds into
 * a false single grantor/grantee pair.
 *
 * Canonical tract/party identity is a PERSISTED proposal (confidence,
 * resolution method, resolution trace, needs-user-selection, match status),
 * not a transient in-memory grouping — see title_canonical_tracts/
 * title_canonical_parties.
 *
 * Phase 1 boundary, stated once here so every module can reference it: this
 * engine organizes available instruments into tract-specific timelines,
 * flags POTENTIAL discontinuities/variances (never asserted as confirmed
 * defects), and links every displayed fact to its source. It does NOT walk
 * or reconcile a fractional ownership ledger, does not compute NMA/NRI/
 * decimal interests, and does not adjudicate conflicts to a final answer —
 * see the project plan for the Phase 2+ roadmap.
 */

import type { StatementClassification } from "../geology/types";
export type { StatementClassification };

/** Label stored on every title_assessments row and shown verbatim on every surface — never "certified," never "clear." */
export const TITLE_ASSESSMENT_LABEL =
  "AI-assisted ownership-chain reconstruction, subject to professional verification";

/** Footer disclosure, distinct from the label above, shown alongside every title report page and UI tab. */
export const TITLE_DISCLOSURE_TEXT =
  "Not a title opinion. Not certified title. Curative work and legal review required before this chain can be relied upon for a transaction.";

/** No "intact"/"clean" option exists — Phase 1 never walks or reconciles a chain, only reports what's observable at the surface. */
export type TitleAssessmentClassification =
  | "NO_SURFACE_DISCONTINUITIES_DETECTED"
  | "POTENTIAL_GAPS_DETECTED"
  | "POTENTIAL_CONFLICTS_DETECTED"
  | "INSUFFICIENT_DATA";

export type TitleConfidenceClassification = "HIGH" | "MODERATE" | "LOW" | "INSUFFICIENT_DATA";

export type InstrumentType =
  | "deed"
  | "mineral_deed"
  | "lease"
  | "assignment"
  | "reservation"
  | "probate"
  | "affidavit_of_heirship"
  | "release"
  | "other";

export type InterestType =
  | "mineral"
  | "royalty"
  | "nonparticipating_royalty"
  | "executive"
  | "leasehold"
  | "overriding_royalty"
  | "depth_limited"
  | "formation_limited";

export type HumanReviewStatus = "unreviewed" | "confirmed" | "corrected" | "rejected";
export type MatchStatus = "proposed" | "confirmed" | "rejected";
export type TitleInstrumentSource = "county_clerk_index" | "user_provided_bulk_import";
export type PartyRole = "grantor" | "grantee";
export type PartyCapacity = "individual" | "trustee" | "spouse" | "entity" | "unknown";

/** A county-clerk INDEX entry proves an indexed record exists — it does not prove the legal effect of the underlying instrument. Only an instrument whose actual text was read can be instrument_verified. */
export type EvidenceLevel = "county_index_metadata" | "instrument_verified";

// ─── Instruments, parties, tracts ───────────────────────────────────────────

export interface TitleInstrument {
  id: string;
  instrumentType: InstrumentType;
  instrumentDate: string | null;
  recordedDate: string | null;
  docNumber: string | null;
  bookVolumePage: string | null;

  source: TitleInstrumentSource;
  sourceUrlOrDocId: string | null;
  sourceDocId: string | null;
  sourcePage: number | null;
  sourceExactLanguage: string | null;
  extractionConfidence: number | null;

  evidenceLevel: EvidenceLevel;
  instrumentContentVerified: boolean;

  humanReviewStatus: HumanReviewStatus;
}

export interface TitleInstrumentParty {
  id: string;
  instrumentId: string;
  partyName: string;
  role: PartyRole;
  capacity: PartyCapacity;
  canonicalPartyId: string | null;
}

export interface TitleInstrumentTract {
  id: string;
  instrumentId: string;
  county: string | null;
  legalDescription: string | null;
  abstractNumber: string | null;
  surveyName: string | null;
  blockNumber: string | null;
  sectionName: string | null;
  grossAcres: number | null;

  interestType: InterestType | null;
  interestConveyedFraction: number | null;
  interestReservedFraction: number | null;
  royaltyFraction: number | null;
  depthOrFormationLimit: string | null;

  canonicalTractId: string | null;
}

/** One asserted fact: instrument X conveyed some interest in tract Y. Parties are read via TitleInstrumentParty[instrumentId], never duplicated here as free text. */
export interface TitleClaim {
  id: string;
  instrumentId: string;
  instrumentTractId: string;
  canonicalAssetId: string | null;
  humanReviewStatus: HumanReviewStatus;
}

/** A fully-joined view used throughout the engine so downstream modules don't have to re-join instrument/parties/tract by hand for every claim. */
export interface EnrichedClaim {
  claim: TitleClaim;
  instrument: TitleInstrument;
  tract: TitleInstrumentTract;
  grantors: TitleInstrumentParty[];
  grantees: TitleInstrumentParty[];
}

// ─── Canonical identity (persisted proposals) ───────────────────────────────

export interface CanonicalMatchMeta {
  confidence: number;
  resolutionMethod: string;
  resolutionTrace: string[];
  needsUserSelection: boolean;
  matchStatus: MatchStatus;
}

export interface CanonicalTract extends CanonicalMatchMeta {
  id: string;
  county: string | null;
  abstractNumber: string | null;
  surveyName: string | null;
  blockNumber: string | null;
  sectionName: string | null;
  legalDescription: string | null;
}

export interface CanonicalParty extends CanonicalMatchMeta {
  id: string;
  displayName: string;
  normalizedName: string;
}

export interface AssetMatchingResult {
  tracts: CanonicalTract[];
  parties: CanonicalParty[];
  tractIdByInstrumentTractId: Record<string, string>;   // title_instrument_tracts.id -> canonical tract id
  partyIdByInstrumentPartyId: Record<string, string>;   // title_instrument_parties.id -> canonical party id
  warnings: TitleWarning[];
}

// ─── Timeline + surface-level discontinuity/variance detection ────────────

export type TitleFindingType =
  | "POTENTIAL_ACREAGE_VARIANCE"
  | "POTENTIAL_DESCRIPTION_VARIANCE"
  | "POSSIBLE_DUPLICATE_INSTRUMENT"
  | "POTENTIAL_CHAIN_DISCONTINUITY";

export interface TitleTimelineGap {
  type: TitleFindingType;
  canonicalTractId: string;
  description: string;
  claimIds: string[];
}

export interface TractTimeline {
  canonicalTractId: string;
  claims: EnrichedClaim[];   // sorted chronologically (instrument_date, falling back to recorded_date)
  gaps: TitleTimelineGap[];
  earliestInstrumentDate: string | null;
  latestInstrumentDate: string | null;
}

export interface TimelineResult {
  tracts: TractTimeline[];
  totalGapCount: number;
}

export interface TitleWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

// ─── Findings ────────────────────────────────────────────────────────────────

export type TitleFindingCategory = "supporting" | "contradicting" | "risk" | "gap";

export interface TitleFinding {
  category: TitleFindingCategory;
  classification: StatementClassification;
  findingType: TitleFindingType | null;
  title: string;
  description: string;
  evidenceIds: string[];
}

// ─── Evidence ────────────────────────────────────────────────────────────────

export interface TitleEvidenceEntry {
  id: string;
  fieldName: string;
  classification: StatementClassification;
  source: string;
  sourceUrlOrDocId: string | null;
  retrievedAt: string;
  rawValue: string | null;
  normalizedValue: string | null;
  confidence: number | null;
  transformationMethod: string | null;
}

// ─── Assessment ──────────────────────────────────────────────────────────────

export interface TitleAssessmentResult {
  classification: TitleAssessmentClassification;
  confidence: TitleConfidenceClassification;
  confidenceDimensions: Record<string, number>;
  diligenceImplication: string;
  label: string; // always TITLE_ASSESSMENT_LABEL

  instrumentCount: number;
  distinctPartyCount: number;
  earliestInstrumentDate: string | null;
  latestInstrumentDate: string | null;
  unresolvedFindingCount: number;

  supportingFactors: TitleFinding[];
  contradictingFactors: TitleFinding[];
  risks: TitleFinding[];
  dataGaps: TitleFinding[];

  tracts: CanonicalTract[];
  timeline: TimelineResult;
  evidence: TitleEvidenceEntry[];

  generatedAt: string;
  durationMs: number;
}
