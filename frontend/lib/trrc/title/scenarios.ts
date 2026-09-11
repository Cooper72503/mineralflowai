/**
 * Scenario engine. Each scenario toggles ONE material uncertainty and lets
 * the consequence propagate the whole way down:
 *
 *   TITLE / OWNERSHIP -> NRI -> CASH FLOW -> VALUE -> POSTURE -> READINESS
 *
 * Scenarios are grouped by axis so a reader can tell whether a value moved
 * because of commodity prices or because of ownership. A scenario is only
 * created where the evidence supports one; no scenario exists merely to
 * fill a row.
 *
 * This is also where quantification comes from. The dollar impact of a
 * competing claim is not estimated, it is the measured difference between
 * the scenario that excludes it and the scenario that admits it.
 */

import { Fraction } from "./fraction";
import type { FractionJson } from "./fraction";
import type {
  DecisionInputs, ExceptionImpact, PriceDeckInput, Scenario, ScenarioAxis, UnderwritingCriteria,
} from "./decision-types";
import { computeNri, computePositionValue } from "./position-value";
import { decidePosture, assessClosingReadiness } from "./decision-rules";

export interface ScenarioDefinition {
  id: string;
  label: string;
  axis: ScenarioAxis;
  description: string;
  toggles: string;
  ownershipDescription: string;
  /** What in the record supports building this scenario at all. */
  supportedBy: string;
  mineralFractionOverride?: FractionJson | null;
  deckOverride?: PriceDeckInput | null;
  /** When set, the delta against the primary scenario quantifies this finding. */
  quantifiesFindingId?: string;
  isPrimary?: boolean;
}

export interface ScenarioRunResult {
  scenarios: Scenario[];
  quantifiers: Record<string, { valueImpactUsd: number; nriFrom: number; nriTo: number; note: string }>;
}

/**
 * If a competing claim of `claimFraction` is admitted into an estate that
 * already allocates to 1, every reconciled holder scales by 1/(1+claim).
 * Exact arithmetic; no rounding.
 */
export function dilutedFraction(held: FractionJson, claimFraction: FractionJson): FractionJson {
  const h = Fraction.fromJson(held)!;
  const c = Fraction.fromJson(claimFraction)!;
  return h.div(Fraction.one().add(c)).toJSON();
}

export function runScenarios(
  input: DecisionInputs,
  definitions: ScenarioDefinition[],
  impacts: ExceptionImpact[],
): ScenarioRunResult {
  const primaryDef = definitions.find(d => d.isPrimary) ?? definitions[0];
  const rows: Array<{ def: ScenarioDefinition; nri: number | null; value: number | null; posture: Scenario["posture"]; ruleId: string; readiness: Scenario["closingReadiness"] }> = [];

  for (const def of definitions) {
    const seed = {
      grossTractAcres: input.basis.grossTractAcres,
      prorationUnitAcres: input.basis.prorationUnitAcres,
      mineralFraction: def.mineralFractionOverride !== undefined ? def.mineralFractionOverride : input.basis.mineralFraction,
      leaseRoyaltyFraction: input.basis.leaseRoyaltyFraction,
    };
    const nr = computeNri(seed);
    const basis = { ...seed, netMineralAcres: nr.netMineralAcres, netRevenueInterest: nr.netRevenueInterest, derivation: nr.derivation };

    const criteria: UnderwritingCriteria = def.deckOverride
      ? { ...input.criteria, baseDeck: { ...input.criteria.baseDeck, value: def.deckOverride } }
      : input.criteria;

    // Exposure is held at zero inside a scenario so the delta measures the
    // toggled variable alone rather than the toggle plus the exposure.
    const value = computePositionValue({
      basis, criteria,
      remainingOilBbl: input.remainingOilBbl, remainingGasMcf: input.remainingGasMcf,
      annualDecline: input.annualDecline, quantifiedAssetExposureUsd: 0, askingPriceUsd: input.askingPriceUsd,
    });
    const scoped: DecisionInputs = { ...input, basis, criteria };
    const posture = decidePosture(scoped, value, impacts);
    const readiness = assessClosingReadiness(scoped, impacts, basis.netRevenueInterest != null);
    rows.push({ def, nri: basis.netRevenueInterest, value: value.cases.baseEconomicValueUsd, posture: posture.posture, ruleId: posture.ruleId, readiness: readiness.readiness });
  }

  const primary = rows.find(r => r.def.id === primaryDef.id)!;
  const quantifiers: ScenarioRunResult["quantifiers"] = {};

  const scenarios: Scenario[] = rows.map(r => {
    const delta = r.value != null && primary.value != null && r.def.id !== primary.def.id ? r.value - primary.value : null;
    const deltaPct = delta != null && primary.value ? delta / primary.value : null;

    if (r.def.quantifiesFindingId && delta != null && r.nri != null && primary.nri != null) {
      quantifiers[r.def.quantifiesFindingId] = {
        valueImpactUsd: delta,
        nriFrom: primary.nri,
        nriTo: r.nri,
        note: `Measured by re-running ownership under "${r.def.label}": net revenue interest moves ${primary.nri.toFixed(8)} to ${r.nri.toFixed(8)}, changing modelled value by ${delta < 0 ? "−" : "+"}$${Math.round(Math.abs(delta)).toLocaleString("en-US")}.`,
      };
    }

    return {
      id: r.def.id, label: r.def.label, axis: r.def.axis,
      description: r.def.description, toggles: r.def.toggles,
      ownershipDescription: r.def.ownershipDescription,
      netRevenueInterest: r.nri, economicValueUsd: r.value,
      deltaUsd: delta, deltaPct,
      posture: r.posture, postureRuleId: r.ruleId, closingReadiness: r.readiness,
      isPrimary: r.def.id === primary.def.id,
      supportedBy: r.def.supportedBy,
    };
  });

  return { scenarios, quantifiers };
}
