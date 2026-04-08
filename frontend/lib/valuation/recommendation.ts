import type { DealValuationActivityLevel } from "./types";
import type { DealScoreResult } from "@/lib/document-processing/deal-score";
import { logValuationDev } from "./normalize";

export function deriveRecommendation(args: {
  dealScore: DealScoreResult;
  confidence: "low" | "medium" | "high";
  activity: DealValuationActivityLevel;
  totalLow: number | null;
  totalHigh: number | null;
  missingCritical: number;
}): "PURSUE" | "REVIEW" | "PASS" {
  const score = typeof args.dealScore.score === "number" && Number.isFinite(args.dealScore.score) ? args.dealScore.score : 0;
  const hasValue =
    args.totalLow != null &&
    args.totalHigh != null &&
    args.totalHigh > 0 &&
    args.totalLow >= 0;

  // No numeric screening band or inputs too thin for a directional $ range → always review in-app.
  if (!hasValue) {
    logValuationDev("recommendation_path", {
      rec: "REVIEW",
      score,
      confidence: args.confidence,
      activity: args.activity,
      hasValue,
      missingCritical: args.missingCritical,
      note: "no_numeric_band",
    });
    return "REVIEW";
  }

  let rec: "PURSUE" | "REVIEW" | "PASS" = "REVIEW";

  if (args.confidence === "low" && args.missingCritical >= 3) {
    rec = "REVIEW";
  } else if (
    hasValue &&
    args.confidence !== "low" &&
    (args.activity === "high" || args.activity === "moderate") &&
    score >= 55
  ) {
    rec = "PURSUE";
  } else if (hasValue && score >= 40 && args.confidence !== "low") {
    rec = "REVIEW";
  } else if (score < 30 && args.confidence === "low") {
    rec = "PASS";
  } else {
    rec = "REVIEW";
  }

  logValuationDev("recommendation_path", {
    rec,
    score,
    confidence: args.confidence,
    activity: args.activity,
    hasValue,
    missingCritical: args.missingCritical,
  });
  return rec;
}
