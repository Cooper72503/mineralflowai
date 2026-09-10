/**
 * Acquisition decision layer — types. Gold-standard schema.
 *
 * Four separations are load-bearing and are enforced as separate fields
 * rather than derived from one another:
 *
 *   1. Acquisition posture (a business recommendation) is independent of
 *      closing readiness (whether the evidence file is complete). A deal can
 *      be economically attractive and still not be ready to close.
 *
 *   2. An exception's properties are independent. Blocking closing, being
 *      decision-material, being quantifiable, and requiring professional
 *      review are four different facts. An exception can block closing AND
 *      carry a measured dollar impact AND be priceable for acquisition
 *      analysis; those are not contradictory.
 *
 *   3. Commodity-price cases are separate from asset-specific exposure. A
 *      downside commodity value and an evidence-adjusted value are different
 *      numbers, and no single "downside" figure silently blends them.
 *
 *   4. Every underwriting number is either supplied by the buyer or absent.
 *      When absent it is NOT_PROVIDED and dependent outputs are withheld
 *      rather than fabricated from a house default.
 *
 * No model chooses any value in this file. Everything is produced by
 * versioned deterministic rules.
 */

import type { FractionJson } from "./fraction";
import type { ChainFindingType, Citation, FindingSeverity, TitleAssessmentClassification } from "./chain-types";

export const DECISION_RULE_VERSION = "2.0.0";
export const DECISION_SCHEMA_VERSION = "2.0.0";
export const GOLDEN_SCHEMA_VERSION = "2.0.0";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export type AcquisitionPosture =
  | "PROCEED" | "CONDITIONAL_PROCEED" | "HOLD_FOR_DILIGENCE" | "PASS" | "INSUFFICIENT_DATA";

export const POSTURE_DISPLAY: Record<AcquisitionPosture, string> = {
  PROCEED: "Proceed",
  CONDITIONAL_PROCEED: "Conditional proceed",
  HOLD_FOR_DILIGENCE: "Hold for diligence",
  PASS: "Pass",
  INSUFFICIENT_DATA: "Insufficient data",
};

export type DecisionConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
export const CONFIDENCE_RANK: Record<DecisionConfidence, number> = { INSUFFICIENT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export type ClosingReadiness =
  | "READY_FOR_FINAL_REVIEW" | "CONDITIONAL" | "NOT_READY" | "INSUFFICIENT_EVIDENCE";

export const READINESS_DISPLAY: Record<ClosingReadiness, string> = {
  READY_FOR_FINAL_REVIEW: "Ready for final review",
  CONDITIONAL: "Conditional",
  NOT_READY: "Not ready",
  INSUFFICIENT_EVIDENCE: "Insufficient evidence",
};

export const READINESS_DISCLAIMER =
  "Closing readiness describes how complete the evidence file assembled here is. It is not a statement that title is marketable, and it does not substitute for a title opinion.";

export const POSTURE_VS_READINESS_NOTE =
  "Acquisition posture and closing readiness are independent. Economics can support continued acquisition work while unresolved evidence still prevents closing.";

export const NOT_PROVIDED_LABEL = "NOT PROVIDED";
export const NO_ASKING_PRICE_LABEL = "ASKING PRICE NOT PROVIDED";
export const UNQUANTIFIED_LABEL = "ECONOMIC IMPACT NOT YET QUANTIFIABLE";
export const NO_THRESHOLD_LABEL = "DECISION THRESHOLD UNAVAILABLE — REQUIRED BUYER CRITERION NOT PROVIDED";

// ─── Provenance-tagged values ───────────────────────────────────────────────

/** Every configurable number carries where it came from and what kind of value it is. */
export type ValueClassification =
  | "USER_INPUT"        // supplied by the buyer
  | "OBSERVED"          // read from a source record
  | "DERIVED"           // computed from other values in this record
  | "SYSTEM_DEFAULT"    // a stated convention, disclosed as such
  | "NOT_PROVIDED";     // absent; dependent outputs are withheld

export interface Criterion<T> {
  value: T | null;
  source: string;
  classification: ValueClassification;
  note?: string;
}

export interface PriceDeckInput {
  oilUsdPerBbl: number;
  gasUsdPerMcf: number;
  oilDifferentialUsdPerBbl: number;
  gasDifferentialUsdPerMcf: number;
}

/**
 * Every user-configurable decision threshold, each tagged. A criterion whose
 * classification is NOT_PROVIDED must not be silently replaced by a default.
 */
export interface UnderwritingCriteria {
  discountRate: Criterion<number>;
  minimumMarginPct: Criterion<number>;
  underwriteAgainst: Criterion<"base_economic" | "downside_commodity" | "evidence_adjusted">;
  baseDeck: Criterion<PriceDeckInput>;
  downsideDeck: Criterion<PriceDeckInput>;
  upsideDeck: Criterion<PriceDeckInput>;
  forecastHorizonYears: Criterion<number>;
  timingConvention: Criterion<string>;
  riskHaircutPct: Criterion<number>;
}

// ─── Exceptions: independent, explicit properties ───────────────────────────

export type ImpactChannel =
  | "ownership" | "nri" | "value" | "cost" | "timing" | "regulatory" | "coverage" | "none";

export interface ExceptionImpact {
  findingId: string;
  type: ChainFindingType | string;
  severity: FindingSeverity;

  issue: string;
  evidence: string;
  citations: Citation[];
  affects: ImpactChannel[];
  affectsNote: string;

  // ── Four independent properties. None is inferred from another. ──
  /** Must be resolved or waived before legal closing. */
  blocksClosing: boolean;
  /** Could change the acquisition posture or the price a buyer would pay. */
  decisionMaterial: boolean;
  /** Whether a dollar impact CAN in principle be measured from available evidence. */
  quantifiable: boolean;
  /** The measured impact. Non-null only when quantifiable AND actually measured. */
  quantifiedValueImpactUsd: number | null;
  /** Changes the reconstructed ownership position. */
  ownershipMaterial: boolean;
  /** Needs a licensed professional, not more data. */
  requiresProfessionalReview: boolean;

  nriImpact: { from: number; to: number } | null;
  /** Present whenever quantifiedValueImpactUsd is null. */
  unquantifiedReason: string | null;
  resolution: string;
  /** How these properties combine for this specific exception, in words. */
  decisionEffectNote: string;
}

// ─── Value: commodity cases kept apart from asset-specific exposure ─────────

export interface OwnershipBasis {
  grossTractAcres: number | null;
  prorationUnitAcres: number | null;
  mineralFraction: FractionJson | null;
  leaseRoyaltyFraction: FractionJson | null;
  netMineralAcres: number | null;
  netRevenueInterest: number | null;
  derivation: string;
}

export interface ValueCases {
  /** Base commodity deck, no asset-specific adjustment. */
  baseEconomicValueUsd: number | null;
  /** Downside commodity deck only. Contains NO exception exposure. */
  downsideCommodityValueUsd: number | null;
  /** Upside commodity deck only. */
  upsideCommodityValueUsd: number | null;
  /** Sum of measured exception impacts. Asset-specific, not commodity. */
  quantifiedAssetExposureUsd: number;
  /** Base economic value less quantified exposure. */
  evidenceAdjustedValueUsd: number | null;
  /** Downside commodity value less quantified exposure. Both adjustments, named. */
  riskAdjustedValueUsd: number | null;
}

export type WaterfallKind = "start" | "deduct" | "subtotal" | "result" | "unavailable";

export interface WaterfallStep {
  label: string;
  amountUsd: number | null;
  runningUsd: number | null;
  kind: WaterfallKind;
  source: string;
}

export interface DecisionBand {
  label: string;
  fromUsd: number | null;
  toUsd: number | null;
  posture: AcquisitionPosture;
  basis: string;
  available: boolean;
  unavailableReason: string | null;
}

export interface Breakpoint {
  variable: string;
  currentValue: string;
  flipsAt: string;
  consequence: string;
  computable: boolean;
  unavailableReason: string | null;
}

export interface PositionValue {
  basis: OwnershipBasis;
  criteria: UnderwritingCriteria;
  cases: ValueCases;

  remainingOilBbl: number | null;
  remainingGasMcf: number | null;
  pvFactor: number | null;
  annualDecline: number | null;

  askingPriceUsd: number | null;
  priceToValueRatio: number | null;
  marginToBaseUsd: number | null;
  marginToEvidenceAdjustedUsd: number | null;
  marginToRiskAdjustedUsd: number | null;
  maxAcquisitionPriceUsd: number | null;
  maxPriceUnavailableReason: string | null;

  waterfall: WaterfallStep[];
  decisionMatrix: DecisionBand[];
  breakpoints: Breakpoint[];
  unavailableReasons: string[];
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

export type ScenarioAxis = "ownership" | "commodity" | "forecast";

export interface Scenario {
  id: string;
  label: string;
  axis: ScenarioAxis;
  description: string;
  toggles: string;
  ownershipDescription: string;
  netRevenueInterest: number | null;
  economicValueUsd: number | null;
  deltaUsd: number | null;
  deltaPct: number | null;
  posture: AcquisitionPosture;
  postureRuleId: string;
  closingReadiness: ClosingReadiness;
  isPrimary: boolean;
  supportedBy: string;
}

// ─── Confidence, decomposed ─────────────────────────────────────────────────

export type ConfidenceDomain =
  | "title_evidence" | "ownership" | "production" | "forecast" | "regulatory" | "economic_model";

export const CONFIDENCE_DOMAIN_LABEL: Record<ConfidenceDomain, string> = {
  title_evidence: "Title evidence",
  ownership: "Ownership",
  production: "Production",
  forecast: "Forecast",
  regulatory: "Regulatory",
  economic_model: "Economic model",
};

export interface ConfidenceComponent {
  domain: ConfidenceDomain;
  level: DecisionConfidence;
  reason: string;
  /** Only components that can change the decision cap the overall figure. */
  canChangeDecision: boolean;
}

export interface ConfidenceAssessment {
  overall: DecisionConfidence;
  rule: string;
  reason: string;
  cappedBy: ConfidenceDomain | null;
  components: ConfidenceComponent[];
}

// ─── Freshness ──────────────────────────────────────────────────────────────

export type FreshnessStatus = "current" | "stale" | "partial" | "missing";

export interface SourceFreshness {
  source: string;
  role: string;
  asOf: string | null;
  retrievedAt: string | null;
  coverage: string;
  ageDays: number | null;
  staleAfterDays: number;
  status: FreshnessStatus;
  note: string;
}

// ─── Rule output ────────────────────────────────────────────────────────────

export interface PostureResult {
  posture: AcquisitionPosture;
  ruleId: string;
  ruleVersion: string;
  rationale: string;
  investmentThesis: string;
  trace: Array<{ ruleId: string; matched: boolean; test: string }>;
  confidence: ConfidenceAssessment;
  strongestPositives: string[];
  materialRisks: string[];
  unresolvedAssumptions: string[];
  conditionsToAdvance: string[];
  conditionsThatReverse: string[];
}

export interface ClosingReadinessResult {
  readiness: ClosingReadiness;
  ruleId: string;
  rationale: string;
  disclaimer: string;
  independenceNote: string;
  unresolvedTitleIssues: string[];
  missingInstruments: string[];
  unresolvedRegulatoryIssues: string[];
  unresolvedEconomicAssumptions: string[];
  requiredProfessionalReview: string[];
  actionsBeforeClosing: string[];
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export interface AuditTrailEntry {
  question: string;
  source: string;
  sourceId: string | null;
  sourceTimestamp: string | null;
  rawFact: string;
  classification: ValueClassification;
  derivation: string;
  effect: string;
  decisionRule: string;
  output: string;
}

// ─── Asset identity ─────────────────────────────────────────────────────────

export interface AssetIdentity {
  apiNumber: string | null;
  county: string | null;
  state: string;
  tractLabel: string | null;
  grossTractAcres: number | null;
  prorationUnitAcres: number | null;
  interestScope: string[];
}

export interface EvaluatedPosition {
  label: string;
  mineralFraction: FractionJson | null;
  netMineralAcres: number | null;
  netRevenueInterest: number | null;
  derivation: string;
}

// ─── The golden record ──────────────────────────────────────────────────────

export interface DecisionRecord {
  goldenSchemaVersion: string;
  decisionSchemaVersion: string;
  decisionRuleVersion: string;
  generatedAt: string;
  asOfDate: string | null;
  jobId: string;
  analysisId: string;

  assetIdentity: AssetIdentity;
  evaluatedPosition: EvaluatedPosition;

  posture: AcquisitionPosture;
  postureDisplay: string;
  postureRuleId: string;
  rationale: string;
  investmentThesis: string;
  ruleTrace: PostureResult["trace"];

  confidence: ConfidenceAssessment;
  closingReadiness: ClosingReadinessResult;

  underwritingCriteria: UnderwritingCriteria;
  positionValue: PositionValue;
  exceptionImpacts: ExceptionImpact[];
  scenarios: Scenario[];
  sourceFreshness: SourceFreshness[];
  auditTrail: AuditTrailEntry[];

  strongestPositives: string[];
  materialRisks: string[];
  unresolvedAssumptions: string[];
  conditionsToAdvance: string[];
  conditionsThatReverse: string[];

  titleStatus: TitleAssessmentClassification;
  inputs: Record<string, unknown>;
  sourceIds: string[];
}

// ─── Engine inputs ──────────────────────────────────────────────────────────

export interface DecisionInputs {
  jobId: string;
  analysisId: string;
  asOfDate: string | null;
  assetIdentity: AssetIdentity;
  positionLabel: string;

  titleStatus: TitleAssessmentClassification;
  findings: import("./chain-types").ChainFinding[];
  confirmedTractCount: number;
  verifiedInstrumentCount: number;
  indexOnlyInstrumentCount: number;
  openReviewItemCount: number;
  unresolvedAllocationCount: number;

  basis: OwnershipBasis;
  criteria: UnderwritingCriteria;
  remainingOilBbl: number | null;
  remainingGasMcf: number | null;
  annualDecline: number | null;
  forecastBasisNote: string;
  askingPriceUsd: number | null;

  openRegulatoryItems: string[];
  reconciliationVariancePct: number | null;
  reconciliationThresholdPct: number;
  sourceFreshness: SourceFreshness[];
}
