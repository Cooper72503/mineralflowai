import {
  lookupPermianCounty,
  normalizeCountyKey,
  titleCaseCountyLabel,
} from "@/lib/geology/permianCountyMap";

export type DrillDifficultyInput = {
  county?: string | null;
  state?: string | null;
  legal_description?: string | null;
  abstract?: string | null;
  survey?: string | null;
};

/** Returned to callers / UI (camelCase). */
export type DrillDifficultyResult = {
  estimatedFormation: string;
  estimatedDepthMin: number | null;
  estimatedDepthMax: number | null;
  drillDifficulty: "Easy" | "Moderate" | "Hard" | "Unknown";
  drillDifficultyScore: number;
  drillDifficultyReason: string;
};

/** Persisted on deal input / structured JSON (snake_case). */
export type DrillDifficultySnapshotSnake = {
  estimated_formation: string;
  estimated_depth_min: number | null;
  estimated_depth_max: number | null;
  drill_difficulty: string;
  drill_difficulty_score: number;
  drill_difficulty_reason: string;
};

const UNKNOWN_SNAPSHOT: DrillDifficultySnapshotSnake = {
  estimated_formation: "Unknown",
  estimated_depth_min: null,
  estimated_depth_max: null,
  drill_difficulty: "Unknown",
  drill_difficulty_score: 0,
  drill_difficulty_reason: "Estimated from county-level Permian Basin geology mapping",
};

function toResult(s: DrillDifficultySnapshotSnake): DrillDifficultyResult {
  const d = s.drill_difficulty;
  const drillDifficulty: DrillDifficultyResult["drillDifficulty"] =
    d === "Easy" || d === "Moderate" || d === "Hard" ? d : "Unknown";
  return {
    estimatedFormation: s.estimated_formation,
    estimatedDepthMin: s.estimated_depth_min,
    estimatedDepthMax: s.estimated_depth_max,
    drillDifficulty,
    drillDifficultyScore: s.drill_difficulty_score,
    drillDifficultyReason: s.drill_difficulty_reason,
  };
}

function classifyDifficulty(avgDepth: number): {
  drillDifficulty: "Easy" | "Moderate" | "Hard";
  drillDifficultyScore: number;
} {
  if (avgDepth < 6000) {
    return { drillDifficulty: "Easy", drillDifficultyScore: 15 };
  }
  if (avgDepth <= 10000) {
    return { drillDifficulty: "Moderate", drillDifficultyScore: 5 };
  }
  return { drillDifficulty: "Hard", drillDifficultyScore: -10 };
}

/**
 * County-level Permian MVP estimate. Never throws; failures yield Unknown / 0.
 */
export function estimateDrillDifficulty(input: DrillDifficultyInput): DrillDifficultyResult {
  try {
    const key = normalizeCountyKey(input.county);
    if (!key) {
      return toResult({
        ...UNKNOWN_SNAPSHOT,
        drill_difficulty_reason:
          "Estimated from county-level Permian Basin geology mapping (county not available)",
      });
    }

    const entry = lookupPermianCounty(key);
    if (!entry) {
      return toResult({
        ...UNKNOWN_SNAPSHOT,
        drill_difficulty_reason:
          "Estimated from county-level Permian Basin geology mapping (county not in regional map)",
      });
    }

    const avgDepth = (entry.depthMin + entry.depthMax) / 2;
    const { drillDifficulty, drillDifficultyScore } = classifyDifficulty(avgDepth);
    const label = titleCaseCountyLabel(key);

    return {
      estimatedFormation: entry.primaryFormation,
      estimatedDepthMin: entry.depthMin,
      estimatedDepthMax: entry.depthMax,
      drillDifficulty,
      drillDifficultyScore,
      drillDifficultyReason: `${label} County mapped to ${entry.primaryFormation} regional depth range`,
    };
  } catch {
    return toResult(UNKNOWN_SNAPSHOT);
  }
}

export function drillDifficultyToSnapshotSnake(
  result: DrillDifficultyResult
): DrillDifficultySnapshotSnake {
  return {
    estimated_formation: result.estimatedFormation,
    estimated_depth_min: result.estimatedDepthMin,
    estimated_depth_max: result.estimatedDepthMax,
    drill_difficulty: result.drillDifficulty,
    drill_difficulty_score: result.drillDifficultyScore,
    drill_difficulty_reason: result.drillDifficultyReason,
  };
}

/**
 * Mutates `dealInput` with snake_case drill fields + numeric score for {@link calculateDealScore}.
 * Safe to call on any plain object; never throws.
 */
/** Fields for `structured_data` / DB columns; omits undefined. */
export function drillSnapshotFromDealInput(
  dealInput: Record<string, unknown>
): DrillDifficultySnapshotSnake {
  const est = dealInput.estimated_formation;
  const dmin = dealInput.estimated_depth_min;
  const dmax = dealInput.estimated_depth_max;
  const dd = dealInput.drill_difficulty;
  const ds = dealInput.drill_difficulty_score;
  const dr = dealInput.drill_difficulty_reason;
  return {
    estimated_formation: typeof est === "string" ? est : "Unknown",
    estimated_depth_min:
      typeof dmin === "number" && Number.isFinite(dmin) ? Math.round(dmin) : null,
    estimated_depth_max:
      typeof dmax === "number" && Number.isFinite(dmax) ? Math.round(dmax) : null,
    drill_difficulty: typeof dd === "string" ? dd : "Unknown",
    drill_difficulty_score:
      typeof ds === "number" && Number.isFinite(ds) ? Math.round(ds) : 0,
    drill_difficulty_reason:
      typeof dr === "string" && dr.trim()
        ? dr
        : UNKNOWN_SNAPSHOT.drill_difficulty_reason,
  };
}

export function enrichDealScoreInputWithDrillDifficulty(
  dealInput: Record<string, unknown>
): void {
  try {
    const result = estimateDrillDifficulty({
      county: typeof dealInput.county === "string" ? dealInput.county : null,
      state: typeof dealInput.state === "string" ? dealInput.state : null,
      legal_description:
        typeof dealInput.legal_description === "string" ? dealInput.legal_description : null,
      abstract: typeof dealInput.abstract === "string" ? dealInput.abstract : null,
      survey: typeof dealInput.survey === "string" ? dealInput.survey : null,
    });
    const snap = drillDifficultyToSnapshotSnake(result);
    dealInput.estimated_formation = snap.estimated_formation;
    dealInput.estimated_depth_min = snap.estimated_depth_min;
    dealInput.estimated_depth_max = snap.estimated_depth_max;
    dealInput.drill_difficulty = snap.drill_difficulty;
    dealInput.drill_difficulty_score = snap.drill_difficulty_score;
    dealInput.drill_difficulty_reason = snap.drill_difficulty_reason;
  } catch {
    dealInput.estimated_formation = UNKNOWN_SNAPSHOT.estimated_formation;
    dealInput.estimated_depth_min = UNKNOWN_SNAPSHOT.estimated_depth_min;
    dealInput.estimated_depth_max = UNKNOWN_SNAPSHOT.estimated_depth_max;
    dealInput.drill_difficulty = UNKNOWN_SNAPSHOT.drill_difficulty;
    dealInput.drill_difficulty_score = UNKNOWN_SNAPSHOT.drill_difficulty_score;
    dealInput.drill_difficulty_reason = UNKNOWN_SNAPSHOT.drill_difficulty_reason;
  }
}
