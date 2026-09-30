/** Oil-only sensitivity: the existing provider and entry/exit formulas, unchanged. */
import { evaluatePrototype, type EconomicsAsset, type EconomicsAssumptions } from '../economics-provider';
import { entryAnalysis, exitAnalysis } from './decision-layer';

export const OIL_PRICE_STEPS = Array.from({ length: 13 }, (_, i) => 40 + i * 5);
export const SENSITIVITY_DISCLOSURE = 'Oil is a flat realized-price assumption, not a live WTI strip. Gas, NGL, interest and selected costs are held constant. Each row refits the existing forecast and recalculates the economic limit. Entry ceiling uses the selected discount hurdle; exit is remaining cash-flow value at the end of the selected hold, not today’s PV or a guaranteed sale price. Unresolved title remains unresolved at every price.';
export function oilSensitivity(asset: EconomicsAsset, assumptions: EconomicsAssumptions) {
  return OIL_PRICE_STEPS.map(oilPriceUsdBbl => {
    const economics = evaluatePrototype(asset, { ...assumptions, oilPriceUsdBbl });
    const entry = entryAnalysis(economics);
    const exit = exitAnalysis(economics, entry);
    return { oilPriceUsdBbl, reason: economics.reason,
      annualNet: economics.scenarios?.base.annual[0]?.net ?? null,
      ceiling: entry ? Math.max(0, entry.ceiling) : null,
      holdCash: exit?.byScenario.base.holdCash ?? null,
      exitValue: exit?.byScenario.base.exitValue ?? null,
      irrPct: exit?.byScenario.base.irrPct ?? null };
  });
}

/** Sensitivities around the location benchmark, never invented company actuals. */
export function costScenario(start: EconomicsAssumptions, factor: number): Partial<EconomicsAssumptions> {
  if (!Number.isFinite(factor) || factor < 0) throw new Error('Invalid cost scenario multiplier');
  return { loeUsdPerBoe: start.loeUsdPerBoe * factor,
    fixedOpexUsdPerWellMonth: start.fixedOpexUsdPerWellMonth * factor,
    workoverUsdPerBoe: start.workoverUsdPerBoe * factor };
}
