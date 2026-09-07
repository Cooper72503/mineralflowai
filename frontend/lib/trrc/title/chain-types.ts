/**
 * Types for the API-number -> title-chain workflow (migration 028).
 *
 * Builds on 027's vocabulary (title/types.ts) rather than replacing it:
 * TitleAssessmentClassification, HumanReviewStatus, MatchStatus, and the
 * disclosure constants are reused verbatim. Everything here is JSON-safe
 * (fractions travel as {n, d} decimal strings) because the analysis
 * object is persisted to jsonb and downloaded as-is.
 */

import type { FractionJson } from "./fraction";
import type { TitleAssessmentClassification, MatchStatus } from "./types";
export type { TitleAssessmentClassification, MatchStatus };

export const TITLE_CHAIN_SCHEMA_VERSION = "1.0.0";
export const EXTRACTION_SCHEMA_VERSION = "1.0.0";

/** Concise statement required on every report surface. */
export const TITLE_CHAIN_REPORT_STATEMENT =
  "This is document-based title research assembled from the records reviewed. It is not a title opinion and does not certify title. Professional review by a licensed attorney or landman is required before relying on it for a transaction.";

/** User-facing wording for NO_SURFACE_DISCONTINUITIES_DETECTED — never "clear", "clean", "unbroken", or "certified". */
export const STATUS_DISPLAY: Record<TitleAssessmentClassification, string> = {
  NO_SURFACE_DISCONTINUITIES_DETECTED: "No discontinuities detected in reviewed records",
  POTENTIAL_GAPS_DETECTED: "Potential gaps detected",
  POTENTIAL_CONFLICTS_DETECTED: "Potential conflicts detected",
  INSUFFICIENT_DATA: "Insufficient data",
};

/**
 * Status aggregation rule (documented here, implemented in chain-findings.ts):
 *   1. INSUFFICIENT_DATA when there are no confirmed tracts, or no content-verified
 *      instruments attached to a confirmed tract within the interest scope.
 *   2. else POTENTIAL_CONFLICTS_DETECTED when any finding is of a conflict type
 *      (OVER_CONVEYANCE, CONFLICTING_CONVEYANCE, FRACTION_INCONSISTENCY at high+ severity).
 *   3. else POTENTIAL_GAPS_DETECTED when any finding is of a gap type
 *      (UNSUPPORTED_TRANSITION, MISSING_REFERENCED_INSTRUMENT, IDENTITY_MISMATCH,
 *      TRACT_INTEREST_MISMATCH, UNRESOLVED_RESERVATION, ENCUMBRANCE_NO_RELEASE,
 *      SIGNATURE_CAPACITY_CONCERN, TIMING_AMBIGUITY, UNRESOLVED_ALLOCATION, INDEX_ONLY_EVIDENCE).
 *   4. else NO_SURFACE_DISCONTINUITIES_DETECTED.
 * Every individual finding is retained regardless of which status wins.
 */
export const STATUS_AGGREGATION_RULE =
  "INSUFFICIENT_DATA if no confirmed tract has a content-verified instrument in scope; else POTENTIAL_CONFLICTS_DETECTED if any conflict-type finding exists; else POTENTIAL_GAPS_DETECTED if any gap-type finding exists; else NO_SURFACE_DISCONTINUITIES_DETECTED. All findings are retained in every case.";

export type InterestScope = "surface" | "minerals" | "leasehold" | "royalty";
export const INTEREST_SCOPES: InterestScope[] = ["surface", "minerals", "leasehold", "royalty"];

export type JobStatus =
  | "pending" | "resolving_wells" | "searching_records" | "awaiting_tract_confirmation"
  | "awaiting_documents" | "ingesting" | "analyzing" | "complete" | "failed" | "cancelled";

export type WellResolutionStatus = "unresolved" | "resolved" | "not_found" | "error";

export type WellTractAssociationType =
  | "surface_location" | "bottomhole_location" | "well_path" | "permit_acreage"
  | "lease_unit_boundary" | "legal_tract" | "user_supplied";

export type ReviewStatus = "proposed" | "confirmed" | "rejected";

export type ChainInterestType =
  | "surface" | "mineral" | "royalty" | "nonparticipating_royalty" | "executive"
  | "leasehold" | "working_interest" | "overriding_royalty" | "unknown";

/** Which scope an interest type reports under. */
export const INTEREST_TYPE_SCOPE: Record<ChainInterestType, InterestScope | null> = {
  surface: "surface",
  mineral: "minerals",
  executive: "minerals",
  royalty: "royalty",
  nonparticipating_royalty: "royalty",
  overriding_royalty: "royalty",
  leasehold: "leasehold",
  working_interest: "leasehold",
  unknown: null,
};

export type ClaimEffect =
  | "conveyance" | "reservation" | "lease_grant" | "assignment" | "release"
  | "encumbrance" | "succession" | "other";

export type FractionBasis = "of_entire_estate" | "of_grantor_interest" | "unknown";

export type ExtendedInstrumentType =
  | "deed" | "mineral_deed" | "royalty_deed" | "lease" | "assignment" | "reservation"
  | "probate" | "affidavit_of_heirship" | "release" | "deed_of_trust" | "lien"
  | "correction_deed" | "unit_agreement" | "other";

export type ExtendedPartyRole =
  | "grantor" | "grantee" | "lessor" | "lessee" | "assignor" | "assignee"
  | "releasor" | "releasee" | "decedent" | "heir" | "devisee" | "executor"
  | "borrower" | "lender" | "trustee" | "other";

/** Roles that hand an interest off (source side) vs receive it (target side). */
export const SOURCE_ROLES: ExtendedPartyRole[] = ["grantor", "lessor", "assignor", "releasor", "decedent", "borrower"];
export const TARGET_ROLES: ExtendedPartyRole[] = ["grantee", "lessee", "assignee", "releasee", "heir", "devisee", "lender"];

export type ExtendedPartyCapacity =
  | "individual" | "trustee" | "spouse" | "entity" | "executor_administrator"
  | "heir_devisee" | "attorney_in_fact" | "successor" | "unknown";

export interface Citation {
  documentId: string | null;
  instrumentId: string | null;
  page: number | null;
  excerpt: string | null;
  sourceUrl: string | null;
  label: string | null;
}

// ─── Well + tract candidates ───────────────────────────────────────────────

export interface JobWell {
  id: string;
  originalInput: string;
  api10: string | null;
  api14: string | null;
  sidetrackSuffix: string | null;
  completionSuffix: string | null;
  countyCode: string | null;
  countyName: string | null;
  validationError: string | null;
  resolutionStatus: WellResolutionStatus;
  resolutionError: string | null;
  wellName: string | null;
  wellNumber: string | null;
  operatorName: string | null;
  operatorNumber: string | null;
  district: string | null;
  leaseNumber: string | null;
  leaseName: string | null;
  fieldName: string | null;
  latitude: number | null;
  longitude: number | null;
  wellPath: Record<string, unknown> | null;
  surveyName: string | null;
  abstractNumber: string | null;
  blockNumber: string | null;
  sectionName: string | null;
  permitRefs: Array<Record<string, unknown>>;
  completionRefs: Array<Record<string, unknown>>;
  sourceUrls: Array<{ source: string; url: string | null; retrievedAt: string; status: string }>;
  retrievedAt: string | null;
}

export interface CandidateTract {
  id: string;
  tractLabel: string;
  county: string | null;
  abstractNumber: string | null;
  surveyName: string | null;
  blockNumber: string | null;
  sectionName: string | null;
  legalDescription: string | null;
  grossAcres: number | null;
  confidence: number;
  resolutionMethod: string;
  resolutionTrace: string[];
  needsUserSelection: boolean;
  matchStatus: MatchStatus;
}

export interface WellTractAssociation {
  id: string;
  wellId: string;
  canonicalTractId: string;
  associationType: WellTractAssociationType;
  confidence: number;
  evidence: Citation[];
  reviewStatus: ReviewStatus;
}

// ─── Analysis result (the one validated object every surface renders from) ─

export interface PartyRef {
  canonicalPartyId: string | null;
  instrumentPartyId: string;
  displayName: string;
  role: ExtendedPartyRole;
  capacity: ExtendedPartyCapacity;
  capacityDetail: string | null;
}

export type DateBasis = "recorded" | "execution" | "effective" | "undated";
export type EventSupport = "supported" | "unsupported" | "partial" | "root" | "not_evaluated";

export interface ChainEvent {
  eventId: string;
  instrumentId: string;
  claimId: string;
  documentId: string | null;
  instrumentType: ExtendedInstrumentType;
  effect: ClaimEffect;
  sortDate: string | null;
  dateBasis: DateBasis;
  executionDate: string | null;
  effectiveDate: string | null;
  recordedDate: string | null;
  recordingReference: string | null;
  from: PartyRef[];
  to: PartyRef[];
  statedFraction: FractionJson | null;
  fractionBasis: FractionBasis;
  fractionVerbatim: string | null;
  /** Share of the ENTIRE estate this event moved, when computable from evidence; null when not. */
  computedShare: FractionJson | null;
  support: EventSupport;
  contentVerified: boolean;
  notes: string[];
  citations: Citation[];
}

export interface Holding {
  holdingId: string;
  parties: PartyRef[];              // >1 = collective holding with unresolved allocation
  share: FractionJson | null;       // null = evidenced but not quantifiable from reviewed records
  shareNote: string | null;
  status: "apparent" | "unresolved" | "collective" | "earliest_evidenced";
  sourceEventIds: string[];
}

export interface EncumbranceRecord {
  instrumentId: string;
  instrumentType: ExtendedInstrumentType;
  parties: PartyRef[];
  recordedDate: string | null;
  recordingReference: string | null;
  releaseStatus: "release_located" | "partial_release_located" | "no_release_located_in_reviewed_records";
  releaseInstrumentIds: string[];
  notes: string[];
  citations: Citation[];
}

export interface OwnershipBranch {
  branchId: string;
  tractId: string;
  tractLabel: string;
  interestType: ChainInterestType;
  scope: InterestScope | null;
  events: ChainEvent[];
  earliestEvidencedHolders: PartyRef[];
  earliestEvidencedDate: string | null;
  apparentHolders: Holding[];
  encumbrances: EncumbranceRecord[];
  unresolvedAllocations: Array<{ eventId: string; description: string }>;
  notes: string[];
}

export type ChainFindingType =
  | "UNSUPPORTED_TRANSITION" | "MISSING_REFERENCED_INSTRUMENT" | "OVER_CONVEYANCE"
  | "CONFLICTING_CONVEYANCE" | "IDENTITY_MISMATCH" | "TRACT_INTEREST_MISMATCH"
  | "UNRESOLVED_RESERVATION" | "FRACTION_INCONSISTENCY" | "SIGNATURE_CAPACITY_CONCERN"
  | "ENCUMBRANCE_NO_RELEASE" | "TIMING_AMBIGUITY" | "UNRESOLVED_ALLOCATION"
  | "INDEX_ONLY_EVIDENCE" | "SUCCESSION_EVIDENCE" | "PROVIDER_UNAVAILABLE" | "OCR_FAILED";

export const CONFLICT_FINDING_TYPES: ChainFindingType[] = ["OVER_CONVEYANCE", "CONFLICTING_CONVEYANCE", "FRACTION_INCONSISTENCY"];
export const GAP_FINDING_TYPES: ChainFindingType[] = [
  "UNSUPPORTED_TRANSITION", "MISSING_REFERENCED_INSTRUMENT", "IDENTITY_MISMATCH", "TRACT_INTEREST_MISMATCH",
  "UNRESOLVED_RESERVATION", "ENCUMBRANCE_NO_RELEASE", "SIGNATURE_CAPACITY_CONCERN", "TIMING_AMBIGUITY",
  "UNRESOLVED_ALLOCATION", "INDEX_ONLY_EVIDENCE",
];

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface ChainFinding {
  findingId: string;
  type: ChainFindingType;
  severity: FindingSeverity;
  title: string;
  explanation: string;
  affectedTractId: string | null;
  affectedTractLabel: string | null;
  affectedInterestType: ChainInterestType | null;
  instrumentIds: string[];
  citations: Citation[];
  nextAction: string;
}

export interface ChronologyRow {
  rowId: string;
  instrumentId: string;
  documentId: string | null;
  sortDate: string | null;
  dateBasis: DateBasis;
  executionDate: string | null;
  effectiveDate: string | null;
  recordedDate: string | null;
  instrumentType: ExtendedInstrumentType;
  parties: string;                 // "A, B -> C" rendered from PartyRef[]
  fromParties: PartyRef[];
  toParties: PartyRef[];
  recordingReference: string | null;
  tractLabel: string;
  interestType: ChainInterestType;
  effect: ClaimEffect;
  fraction: string | null;
  contentVerified: boolean;
  notes: string;
  citations: Citation[];
}

export interface SourceInventoryEntry {
  documentId: string;
  source: string;
  sourceIdentifier: string | null;
  sourceUrl: string | null;
  fileName: string | null;
  documentCategory: string;
  contentHash: string;
  retrievedAt: string;
  pageCount: number | null;
  hasTextLayer: boolean | null;
  ocrStatus: string;
  extractionStatus: string;
  instrumentIds: string[];
}

export interface SearchCoverageEntry {
  provider: string;
  county: string | null;
  queryType: string;
  queryValue: string;
  dateFrom: string | null;
  dateTo: string | null;
  status: string;
  resultCount: number;
  errorMessage: string | null;
  sourceUrl: string | null;
  searchedAt: string;
}

export interface WellSummary {
  wellId: string;
  originalInput: string;
  api14: string | null;
  formatted: string | null;
  wellName: string | null;
  operatorName: string | null;
  countyName: string | null;
  resolutionStatus: WellResolutionStatus;
  validationError: string | null;
  resolutionError: string | null;
  associations: Array<{ tractId: string; tractLabel: string; associationType: WellTractAssociationType; confidence: number; reviewStatus: ReviewStatus }>;
}

export interface TitleChainAnalysis {
  schemaVersion: string;
  analysisId: string;
  jobId: string;
  version: number;
  generatedAt: string;
  interestScope: InterestScope[];
  researchStartDate: string | null;
  asOfDate: string | null;

  status: TitleAssessmentClassification;
  statusDisplay: string;
  statusRule: string;

  wells: WellSummary[];
  tracts: CandidateTract[];
  branches: OwnershipBranch[];
  chronology: ChronologyRow[];
  findings: ChainFinding[];
  sourceInventory: SourceInventoryEntry[];
  searchCoverage: SearchCoverageEntry[];
  limitations: string[];
  reviewQueueOpenCount: number;

  statement: string;
}
