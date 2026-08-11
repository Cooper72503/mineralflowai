/**
 * Petrophysical framework — Phase 5, architected per spec but NOT wired to
 * any live log data source in V1. No LAS ingestion UI exists yet
 * (well_log_files/well_log_curves, migration 023, are real tables with
 * zero rows until that's built), and this engine will not move to a real
 * Phase 5 implementation until Phases 1-4 (this file's siblings) are
 * solid, per the build plan.
 *
 * The functions below ARE the real deterministic geoscience formulas the
 * spec asks for — not placeholders — so the moment log curves exist
 * somewhere to feed them, wiring them in is a data-supply problem, not a
 * math problem. What's deliberately NOT here is an LLM path: these
 * functions take numeric curve arrays and numeric constants, full stop.
 * No function in this file accepts a prompt or calls out to Claude.
 */

export interface DepthValuePoint {
  depthFt: number;
  value: number;
}

export interface VshaleInputs {
  gammaRay: DepthValuePoint[];
  gammaRayCleanSand: number;   // GR_clean, API units — the shale-free baseline for this well
  gammaRayShaleBaseline: number; // GR_shale, API units — the 100%-shale baseline for this well
}

/** Linear (Larionov not applied — that's a separate, optional refinement) gamma-ray shale volume: Vsh = (GR - GR_clean) / (GR_shale - GR_clean), clamped to [0,1]. Returns null, not a fabricated number, when the two baselines don't bracket a usable range. */
export function computeVshaleFromGammaRay(inputs: VshaleInputs): { depthFt: number; vshale: number }[] | null {
  const range = inputs.gammaRayShaleBaseline - inputs.gammaRayCleanSand;
  if (range <= 0) return null;
  return inputs.gammaRay.map(p => ({
    depthFt: p.depthFt,
    vshale: Math.max(0, Math.min(1, (p.value - inputs.gammaRayCleanSand) / range)),
  }));
}

export interface DensityPorosityInputs {
  bulkDensity: DepthValuePoint[];
  matrixDensity: number;  // rho_matrix, g/cc — e.g. 2.65 for quartz, must be supplied, never assumed
  fluidDensity: number;   // rho_fluid, g/cc — e.g. 1.0 for fresh mud filtrate
}

/** Density porosity: phi_D = (rho_matrix - rho_bulk) / (rho_matrix - rho_fluid). */
export function computeDensityPorosity(inputs: DensityPorosityInputs): { depthFt: number; porosity: number }[] | null {
  const range = inputs.matrixDensity - inputs.fluidDensity;
  if (range <= 0) return null;
  return inputs.bulkDensity.map(p => ({
    depthFt: p.depthFt,
    porosity: Math.max(0, Math.min(1, (inputs.matrixDensity - p.value) / range)),
  }));
}

export interface GrossNetThicknessInputs {
  gammaRay: DepthValuePoint[];
  vshaleCutoff: number;       // e.g. 0.5 — depths at or below this Vsh count as "net"
  gammaRayCleanSand: number;
  gammaRayShaleBaseline: number;
  intervalTopFt: number;
  intervalBaseFt: number;
}

export interface ThicknessResult {
  grossThicknessFt: number;
  netThicknessFt: number;
  netToGrossRatio: number;
}

/** Gross = interval top-to-base. Net = sum of sample spacing at points within the interval where Vsh <= cutoff. Requires evenly-spaced samples; returns null rather than a distorted result if spacing can't be determined. */
export function computeGrossNetThickness(inputs: GrossNetThicknessInputs): ThicknessResult | null {
  const inInterval = inputs.gammaRay.filter(p => p.depthFt >= inputs.intervalTopFt && p.depthFt <= inputs.intervalBaseFt).sort((a, b) => a.depthFt - b.depthFt);
  if (inInterval.length < 2) return null;

  const spacing = inInterval[1].depthFt - inInterval[0].depthFt;
  if (spacing <= 0) return null;

  const vsh = computeVshaleFromGammaRay({ gammaRay: inInterval, gammaRayCleanSand: inputs.gammaRayCleanSand, gammaRayShaleBaseline: inputs.gammaRayShaleBaseline });
  if (!vsh) return null;

  const grossThicknessFt = inputs.intervalBaseFt - inputs.intervalTopFt;
  const netThicknessFt = vsh.filter(p => p.vshale <= inputs.vshaleCutoff).length * spacing;

  return { grossThicknessFt, netThicknessFt, netToGrossRatio: grossThicknessFt > 0 ? netThicknessFt / grossThicknessFt : 0 };
}

/**
 * V1 entry point — always returns the honest gap message, since no real
 * well_log_curves rows exist for any run yet. Once LAS ingestion is built,
 * this function is where a real caller checks for curve availability and
 * either calls the deterministic functions above or returns this same
 * message for a well that genuinely has no logs on file — the message
 * itself doesn't change, only whether the "no data" path is reached
 * because nothing was ingested (today) or because this specific well
 * genuinely has none (the ongoing, permanent case even after Phase 5 ships).
 */
export function assessPetrophysics(hasLogCurvesAvailable: boolean): { available: false; message: string } | never {
  if (!hasLogCurvesAvailable) {
    return { available: false, message: "Insufficient data for petrophysical assessment." };
  }
  // Phase 5 is not built — there is currently no code path that reaches
  // this point with hasLogCurvesAvailable=true, by construction (no LAS
  // ingestion UI exists). Throwing here is intentional: it means a caller
  // tried to claim log data was available before Phase 5 actually wires
  // that up, which would be exactly the kind of fabrication this module
  // exists to prevent.
  throw new Error("assessPetrophysics: log-curve-backed assessment is not implemented in V1 — this code path should be unreachable until Phase 5 ships.");
}
