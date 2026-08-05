/**
 * Undeveloped tract scaling — explicit development-case assumptions for
 * translating a single analog type curve into a tract-level forecast.
 * Never infers well count from acreage alone: doing so requires a real
 * spacing assumption (acres per well, itself basin/operator/regulatory-
 * dependent), and guessing one would be exactly the kind of fabricated
 * precision this engine exists to avoid. When no explicit assumptions are
 * supplied, this returns a SINGLE_WELL_PROXY case — the one development
 * scenario that needs no spacing assumption at all — clearly labeled as
 * such, not silently treated as "the" forecast for the whole tract.
 */

import type { WarningEntry } from "./types";

export type DevelopmentCaseType = "SINGLE_WELL_PROXY" | "MULTI_WELL_CONFIGURED";

export interface DevelopmentAssumptions {
  spacingAcresPerWell: number;
  lateralLengthFt: number;
  developmentTimingMonths: number[]; // month offset (from "today") each well comes online — length must equal well count once resolved
  netDevelopableAcres: number;
  grossTractAcres: number;
  netMineralAcres: number | null;
  riskFactor: number; // 0-1, a subjective/operator-supplied derate distinct from probabilityOfDevelopment
  probabilityOfDevelopment: number; // 0-1
  infrastructureDeductionUsd: number; // one-time deduction (gathering, roads, etc.), applied in proxy-valuation.ts (Phase 15)
}

export interface DevelopmentCase {
  caseType: DevelopmentCaseType;
  wellCount: number;
  developmentTimingMonths: number[];
  probabilityOfDevelopment: number;
  riskFactor: number;
  infrastructureDeductionUsd: number;
  netDevelopableAcres: number | null;
  grossTractAcres: number | null;
  netMineralAcres: number | null;
  warnings: WarningEntry[];
}

/**
 * Builds a SINGLE_WELL_PROXY case — the honest default when no explicit
 * development plan is supplied. probabilityOfDevelopment and riskFactor
 * default to 1.0 (i.e. this function does not itself invent a discount;
 * see proxy-valuation.ts for where an unrisked vs risked split is surfaced
 * to the caller, who should supply a real probability if they have one).
 */
export function buildSingleWellProxyCase(overrides: Partial<Pick<DevelopmentAssumptions, "probabilityOfDevelopment" | "riskFactor" | "netMineralAcres" | "grossTractAcres">> = {}): DevelopmentCase {
  const warnings: WarningEntry[] = [{
    code: "SINGLE_WELL_PROXY_DEFAULT",
    message: "No development assumptions were supplied — this is a single-well proxy case (as if one well like the analog set were drilled on this tract), NOT a full-tract development forecast. Well count was not inferred from acreage.",
    severity: "info",
  }];
  return {
    caseType: "SINGLE_WELL_PROXY",
    wellCount: 1,
    developmentTimingMonths: [0],
    probabilityOfDevelopment: overrides.probabilityOfDevelopment ?? 1.0,
    riskFactor: overrides.riskFactor ?? 1.0,
    infrastructureDeductionUsd: 0,
    netDevelopableAcres: null,
    grossTractAcres: overrides.grossTractAcres ?? null,
    netMineralAcres: overrides.netMineralAcres ?? null,
    warnings,
  };
}

/**
 * Builds a MULTI_WELL_CONFIGURED case from explicit assumptions. Well
 * count is DERIVED from spacing (netDevelopableAcres / spacingAcresPerWell,
 * floored) — a real, disclosed calculation, not a black-box guess, and
 * the spacing figure itself must come from the caller (operator input, a
 * basin-typical default the caller explicitly chose, etc.), never invented
 * here.
 */
export function buildConfiguredDevelopmentCase(assumptions: DevelopmentAssumptions): DevelopmentCase {
  const warnings: WarningEntry[] = [];

  if (assumptions.spacingAcresPerWell <= 0) {
    warnings.push({ code: "INVALID_SPACING", message: "Spacing acres per well must be positive — falling back to a single-well proxy", severity: "critical" });
    return { ...buildSingleWellProxyCase({ probabilityOfDevelopment: assumptions.probabilityOfDevelopment, riskFactor: assumptions.riskFactor, netMineralAcres: assumptions.netMineralAcres, grossTractAcres: assumptions.grossTractAcres }), warnings };
  }

  const wellCount = Math.max(1, Math.floor(assumptions.netDevelopableAcres / assumptions.spacingAcresPerWell));
  if (wellCount === 1) {
    warnings.push({ code: "SPACING_YIELDS_SINGLE_WELL", message: `${assumptions.netDevelopableAcres} developable acres at ${assumptions.spacingAcresPerWell} acres/well spacing supports only 1 well`, severity: "info" });
  }

  let timing = assumptions.developmentTimingMonths;
  if (timing.length !== wellCount) {
    warnings.push({ code: "TIMING_ARRAY_LENGTH_MISMATCH", message: `${timing.length} development-timing entries supplied for ${wellCount} wells — extending/truncating to match, extra wells assumed to start at the same offset as the last supplied entry`, severity: "warning" });
    const lastTiming = timing[timing.length - 1] ?? 0;
    timing = Array.from({ length: wellCount }, (_, i) => timing[i] ?? lastTiming);
  }

  if (assumptions.probabilityOfDevelopment <= 0) {
    warnings.push({ code: "ZERO_DEVELOPMENT_PROBABILITY", message: "Probability of development is 0 — any resulting risked valuation will be $0, by design, not an error", severity: "info" });
  }

  return {
    caseType: "MULTI_WELL_CONFIGURED",
    wellCount,
    developmentTimingMonths: timing,
    probabilityOfDevelopment: assumptions.probabilityOfDevelopment,
    riskFactor: assumptions.riskFactor,
    infrastructureDeductionUsd: assumptions.infrastructureDeductionUsd,
    netDevelopableAcres: assumptions.netDevelopableAcres,
    grossTractAcres: assumptions.grossTractAcres,
    netMineralAcres: assumptions.netMineralAcres,
    warnings,
  };
}
