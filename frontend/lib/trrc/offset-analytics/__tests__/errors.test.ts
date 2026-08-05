import { describe, it, expect } from "vitest";
import { OffsetAnalyticsError, OffsetAnalyticsCalculationError, NoQualifiedAnalogsError, wrapUnexpectedError } from "../errors";

describe("OffsetAnalyticsError", () => {
  it("carries a stable code, safe message, technical context, analysisId, retryability, and next action", () => {
    const err = new NoQualifiedAnalogsError({
      safeMessage: "No qualified analogs were found.",
      technicalContext: "0 of 12 candidates passed formation/status filters",
      analysisId: "abc-123",
      retryable: false,
      recommendedNextAction: "Widen the search radius or relax formation matching.",
    });
    expect(err.code).toBe("NO_QUALIFIED_ANALOGS_ERROR");
    expect(err.safeMessage).toBe("No qualified analogs were found.");
    expect(err.technicalContext).toContain("0 of 12");
    expect(err.analysisId).toBe("abc-123");
    expect(err.retryable).toBe(false);
    expect(err.recommendedNextAction).toMatch(/radius/);
  });

  it("toSafePayload() never includes technicalContext — that's for logs only", () => {
    const err = new NoQualifiedAnalogsError({
      safeMessage: "safe", technicalContext: "SENSITIVE INTERNAL DETAIL", analysisId: "id-1", retryable: true, recommendedNextAction: "retry",
    });
    const payload = err.toSafePayload();
    expect(JSON.stringify(payload)).not.toContain("SENSITIVE INTERNAL DETAIL");
  });

  it("is a real Error instance (instanceof works up the chain)", () => {
    const err = new NoQualifiedAnalogsError({ safeMessage: "x", technicalContext: "y", analysisId: null, retryable: false, recommendedNextAction: "z" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OffsetAnalyticsError);
  });
});

describe("wrapUnexpectedError", () => {
  it("wraps a raw thrown Error into a classified OffsetAnalyticsCalculationError with a safe, non-leaking message", () => {
    const raw = new Error("TypeError: cannot read property 'x' of undefined at internal/module.ts:42");
    const wrapped = wrapUnexpectedError(raw, "analysis-1");
    expect(wrapped).toBeInstanceOf(OffsetAnalyticsCalculationError);
    expect(wrapped.analysisId).toBe("analysis-1");
    expect(wrapped.safeMessage).not.toContain("internal/module.ts");
    expect(wrapped.technicalContext).toContain("cannot read property");
  });

  it("passes an already-classified OffsetAnalyticsError through unchanged, not double-wrapped", () => {
    const original = new NoQualifiedAnalogsError({ safeMessage: "x", technicalContext: "y", analysisId: "id-1", retryable: false, recommendedNextAction: "z" });
    const wrapped = wrapUnexpectedError(original, "id-1");
    expect(wrapped).toBe(original);
    expect(wrapped.code).toBe("NO_QUALIFIED_ANALOGS_ERROR");
  });

  it("handles a non-Error thrown value gracefully", () => {
    const wrapped = wrapUnexpectedError("a plain string throw", "id-1");
    expect(wrapped).toBeInstanceOf(OffsetAnalyticsCalculationError);
    expect(wrapped.technicalContext).toContain("a plain string throw");
  });
});
