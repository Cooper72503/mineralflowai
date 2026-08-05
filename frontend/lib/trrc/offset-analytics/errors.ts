/**
 * Domain-specific errors for genuinely UNEXPECTED failures — a provider
 * throwing, a malformed response, a programming invariant violated. This
 * is deliberately distinct from this engine's normal "no analogs found" /
 * "ownership unavailable" / "unmappable" outcomes, which are EXPECTED
 * business results, not errors — those are represented as structured
 * fields in OffsetAnalyticsPayload (matchMethod, validationStatus,
 * ownership.resultType, analog-selection's AnalogSetStatus, etc.), per
 * "never return an empty successful array when the analysis actually
 * failed" — the payload always distinguishes a real empty result from a
 * broken pipeline, without needing an exception for the former.
 *
 * These classes exist for the latter: something the pipeline did not
 * expect and cannot represent as a normal result field. runOffsetAnalytics
 * itself does not throw these under normal operation (see service.ts) —
 * they're for wrapping unexpected failures at the API-route boundary
 * (Phase 19/22) so a caller gets a stable code and a safe message instead
 * of a raw stack trace.
 */

export type ErrorCode =
  | "LEGAL_DESCRIPTION_VALIDATION_ERROR"
  | "LEGAL_DESCRIPTION_UNMAPPABLE_ERROR"
  | "AMBIGUOUS_SURVEY_MATCH_ERROR"
  | "INVALID_GEOMETRY_ERROR"
  | "SPATIAL_QUERY_ERROR"
  | "NO_PRODUCING_WELLS_FOUND_ERROR"
  | "NO_QUALIFIED_ANALOGS_ERROR"
  | "FORMATION_NORMALIZATION_ERROR"
  | "INSUFFICIENT_PRODUCTION_HISTORY_ERROR"
  | "ANALOG_DECLINE_FIT_ERROR"
  | "MISSING_OWNERSHIP_INPUTS_ERROR"
  | "INVALID_ECONOMIC_ASSUMPTIONS_ERROR"
  | "OFFSET_ANALYTICS_CALCULATION_ERROR";

export interface OffsetAnalyticsErrorOptions {
  safeMessage: string; // shown to the end user — never includes raw provider errors, stack traces, or internal identifiers
  technicalContext: string; // for logs only (Phase 20) — may include provider responses, query strings, etc.
  analysisId: string | null;
  retryable: boolean;
  recommendedNextAction: string;
  cause?: unknown;
}

export class OffsetAnalyticsError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  readonly technicalContext: string;
  readonly analysisId: string | null;
  readonly retryable: boolean;
  readonly recommendedNextAction: string;

  constructor(code: ErrorCode, options: OffsetAnalyticsErrorOptions) {
    super(options.safeMessage, { cause: options.cause });
    this.name = code;
    this.code = code;
    this.safeMessage = options.safeMessage;
    this.technicalContext = options.technicalContext;
    this.analysisId = options.analysisId;
    this.retryable = options.retryable;
    this.recommendedNextAction = options.recommendedNextAction;
  }

  /** What's safe to send to a frontend/API caller — never the technical context. */
  toSafePayload(): { code: ErrorCode; message: string; analysisId: string | null; retryable: boolean; recommendedNextAction: string } {
    return { code: this.code, message: this.safeMessage, analysisId: this.analysisId, retryable: this.retryable, recommendedNextAction: this.recommendedNextAction };
  }
}

function makeErrorClass(code: ErrorCode) {
  return class extends OffsetAnalyticsError {
    constructor(options: OffsetAnalyticsErrorOptions) {
      super(code, options);
    }
  };
}

export const LegalDescriptionValidationError = makeErrorClass("LEGAL_DESCRIPTION_VALIDATION_ERROR");
export const LegalDescriptionUnmappableError = makeErrorClass("LEGAL_DESCRIPTION_UNMAPPABLE_ERROR");
export const AmbiguousSurveyMatchError = makeErrorClass("AMBIGUOUS_SURVEY_MATCH_ERROR");
export const InvalidGeometryError = makeErrorClass("INVALID_GEOMETRY_ERROR");
export const SpatialQueryError = makeErrorClass("SPATIAL_QUERY_ERROR");
export const NoProducingWellsFoundError = makeErrorClass("NO_PRODUCING_WELLS_FOUND_ERROR");
export const NoQualifiedAnalogsError = makeErrorClass("NO_QUALIFIED_ANALOGS_ERROR");
export const FormationNormalizationError = makeErrorClass("FORMATION_NORMALIZATION_ERROR");
export const InsufficientProductionHistoryError = makeErrorClass("INSUFFICIENT_PRODUCTION_HISTORY_ERROR");
export const AnalogDeclineFitError = makeErrorClass("ANALOG_DECLINE_FIT_ERROR");
export const MissingOwnershipInputsError = makeErrorClass("MISSING_OWNERSHIP_INPUTS_ERROR");
export const InvalidEconomicAssumptionsError = makeErrorClass("INVALID_ECONOMIC_ASSUMPTIONS_ERROR");
export const OffsetAnalyticsCalculationError = makeErrorClass("OFFSET_ANALYTICS_CALCULATION_ERROR");

/**
 * Wraps any unexpected thrown error from runOffsetAnalytics (a provider
 * throwing outside its own .catch, a genuine bug) into a safe,
 * classified OffsetAnalyticsError — the API-route boundary (Phase 19/22)
 * should call this instead of letting a raw error/stack trace reach the
 * frontend.
 */
export function wrapUnexpectedError(err: unknown, analysisId: string | null): OffsetAnalyticsError {
  if (err instanceof OffsetAnalyticsError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new OffsetAnalyticsCalculationError({
    safeMessage: "Offset analytics could not complete due to an unexpected internal error. This is not a data-quality finding — try again, and report this if it persists.",
    technicalContext: message,
    analysisId,
    retryable: true,
    recommendedNextAction: "Retry the analysis. If the error persists, this needs investigation, not a re-run.",
    cause: err,
  });
}
