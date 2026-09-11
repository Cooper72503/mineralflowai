/**
 * Assembles the golden DecisionRecord.
 *
 * Sequencing is the reason this is its own module:
 *
 *   1. Derive net revenue interest from exact title fractions.
 *   2. Run scenarios to MEASURE each material uncertainty.
 *   3. Feed those measurements back as exception quantifiers, so a dollar
 *      figure is always computed and never asserted.
 *   4. Re-value with commodity cases and asset exposure kept apart.
 *   5. Apply the posture ladder and, separately, the readiness ladder.
 *   6. Emit an audit trail where every material conclusion reads
 *      SOURCE -> RAW FACT -> CLASSIFICATION -> DERIVATION -> EFFECT ->
 *      DECISION RULE -> OUTPUT, each anchored to the question it answers.
 *
 * Every field the PDF renders exists here. The report contains no logic
 * that is not in this record.
 */

import { randomUUID } from "crypto";
import type {
  AuditTrailEntry, DecisionInputs, DecisionRecord, ExceptionImpact, SourceFreshness,
} from "./decision-types";
import {
  DECISION_RULE_VERSION, DECISION_SCHEMA_VERSION, GOLDEN_SCHEMA_VERSION, POSTURE_DISPLAY,
} from "./decision-types";
import { computeNri, computePositionValue } from "./position-value";
import { buildExceptionImpacts, totalQuantifiedExposure } from "./exception-impact";
import { decidePosture, assessClosingReadiness, POSTURE_RULES } from "./decision-rules";
import { runScenarios, type ScenarioDefinition } from "./scenarios";

export interface BuildDecisionInput {
  input: DecisionInputs;
  scenarioDefinitions: ScenarioDefinition[];
}

const usd = (n: number | null) => n == null ? "not modelled" : `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/** Days between a timestamp and the as-of date. */
export function ageInDays(asOf: string | null, retrieved: string | null): number | null {
  if (!asOf || !retrieved) return null;
  const a = Date.parse(asOf), r = Date.parse(retrieved);
  if (!Number.isFinite(a) || !Number.isFinite(r)) return null;
  return Math.round((a - r) / 86_400_000);
}

export function gradeFreshness(entries: SourceFreshness[], asOf: string | null): SourceFreshness[] {
  return entries.map(e => {
    const age = e.ageDays ?? ageInDays(asOf, e.retrievedAt);
    const status: SourceFreshness["status"] =
      e.status === "missing" || e.status === "partial" ? e.status
      : age == null ? "partial"
      : age > e.staleAfterDays ? "stale" : "current";
    return {
      ...e, ageDays: age, status,
      note: status === "stale" ? `Retrieved ${age} days before the as-of date, beyond the ${e.staleAfterDays}-day freshness window for this source.`
        : status === "missing" ? e.note || "Not retrieved."
        : status === "partial" ? e.note || "Retrieved, but coverage is incomplete."
        : `Within the ${e.staleAfterDays}-day freshness window.`,
    };
  });
}

export function buildDecisionRecord({ input, scenarioDefinitions }: BuildDecisionInput): DecisionRecord {
  // 1. Ownership decimal from exact fractions.
  const nr = computeNri(input.basis);
  const basis = { ...input.basis, netMineralAcres: nr.netMineralAcres, netRevenueInterest: nr.netRevenueInterest, derivation: nr.derivation };
  const resolved: DecisionInputs = { ...input, basis };

  // 2-3. Scenarios measure; measurements become quantifiers.
  const provisional = buildExceptionImpacts(resolved.findings, {});
  const { scenarios, quantifiers } = runScenarios(resolved, scenarioDefinitions, provisional);
  const impacts = buildExceptionImpacts(resolved.findings, quantifiers);

  // 4. Value, with commodity cases and asset exposure kept apart.
  const exposure = totalQuantifiedExposure(impacts);
  const value = computePositionValue({
    basis, criteria: resolved.criteria,
    remainingOilBbl: resolved.remainingOilBbl, remainingGasMcf: resolved.remainingGasMcf,
    annualDecline: resolved.annualDecline, quantifiedAssetExposureUsd: exposure, askingPriceUsd: resolved.askingPriceUsd,
  });

  // 5. Two independent ladders.
  const posture = decidePosture(resolved, value, impacts);
  const readiness = assessClosingReadiness(resolved, impacts, basis.netRevenueInterest != null);
  const freshness = gradeFreshness(resolved.sourceFreshness, resolved.asOfDate);

  // 6. Audit trail, one entry per challengeable conclusion.
  const audit: AuditTrailEntry[] = [];
  const fresh = (role: string) => freshness.find(f => f.role === role) ?? null;

  if (basis.netRevenueInterest != null) {
    const f = fresh("county");
    audit.push({
      question: `Why is net revenue interest ${basis.netRevenueInterest.toFixed(8)}?`,
      source: "County clerk instruments", sourceId: "county:title-chain", sourceTimestamp: f?.retrievedAt ?? null,
      rawFact: `Reviewed instruments place ${basis.mineralFraction ? `${basis.mineralFraction.n}/${basis.mineralFraction.d}` : "an unstated fraction"} of the minerals under ${basis.grossTractAcres} gross acres with the evaluated position, under a ${basis.leaseRoyaltyFraction ? `${basis.leaseRoyaltyFraction.n}/${basis.leaseRoyaltyFraction.d}` : "unstated"} lease royalty.`,
      classification: "DERIVED", derivation: basis.derivation,
      effect: `${basis.netMineralAcres?.toFixed(2)} net mineral acres and a revenue decimal of ${basis.netRevenueInterest.toFixed(8)}.`,
      decisionRule: "R-03 tests whether this is computable at all.",
      output: `Net revenue interest ${basis.netRevenueInterest.toFixed(8)}.`,
    });
  }
  if (value.cases.baseEconomicValueUsd != null) {
    const f = fresh("vendor");
    audit.push({
      question: `Why is base economic value ${usd(value.cases.baseEconomicValueUsd)}?`,
      source: "Vendor analytics", sourceId: "vendor:reserves", sourceTimestamp: f?.retrievedAt ?? null,
      rawFact: `Remaining recoverable volumes of ${(resolved.remainingOilBbl ?? 0).toLocaleString("en-US")} bbl oil and ${(resolved.remainingGasMcf ?? 0).toLocaleString("en-US")} mcf gas.`,
      classification: "DERIVED",
      derivation: `Priced at the base deck, net of severance and ad valorem, multiplied by the position's ${basis.netRevenueInterest?.toFixed(8)} decimal, then discounted by a present-value factor of ${value.pvFactor?.toFixed(4)} derived from a ${((resolved.annualDecline ?? 0) * 100).toFixed(1)}% annual decline over ${resolved.criteria.forecastHorizonYears.value ?? 20} years.`,
      effect: `Base ${usd(value.cases.baseEconomicValueUsd)}, downside commodity ${usd(value.cases.downsideCommodityValueUsd)}, upside commodity ${usd(value.cases.upsideCommodityValueUsd)}.`,
      decisionRule: "R-04, R-05 and R-06 test value and the asking price against it.",
      output: `Base economic value ${usd(value.cases.baseEconomicValueUsd)}.`,
    });
  }
  for (const i of impacts.filter(x => x.quantifiedValueImpactUsd != null)) {
    const f = fresh("county");
    audit.push({
      question: `Why did ${i.findingId} cost ${usd(i.quantifiedValueImpactUsd)}?`,
      source: "County clerk instruments", sourceId: i.findingId, sourceTimestamp: f?.retrievedAt ?? null,
      rawFact: i.evidence, classification: "DERIVED",
      derivation: `Measured by re-running ownership with the claim admitted: net revenue interest ${i.nriImpact!.from.toFixed(8)} to ${i.nriImpact!.to.toFixed(8)}. The delta between scenarios is the impact; nothing is estimated.`,
      effect: `Reduces evidence-adjusted value by ${usd(i.quantifiedValueImpactUsd)}.`,
      decisionRule: i.blocksClosing ? "R-08 (measured blocker) and C-03." : "Carried as quantified exposure.",
      output: `${usd(i.quantifiedValueImpactUsd)} of measured exposure.`,
    });
  }
  for (const i of impacts.filter(x => x.blocksClosing && x.quantifiedValueImpactUsd == null)) {
    audit.push({
      question: `Why can ${i.findingId} not be priced?`,
      source: "County clerk instruments", sourceId: i.findingId, sourceTimestamp: fresh("county")?.retrievedAt ?? null,
      rawFact: i.evidence, classification: "OBSERVED",
      derivation: i.unquantifiedReason ?? "", effect: "Cannot be offset by an offer adjustment.",
      decisionRule: "R-07 holds the deal rather than repricing it.",
      output: "Unpriceable closing blocker.",
    });
  }
  if (resolved.reconciliationVariancePct != null) {
    audit.push({
      question: "Why is the production basis flagged?",
      source: "Vendor versus regulator", sourceId: "reconciliation", sourceTimestamp: fresh("regulator")?.retrievedAt ?? null,
      rawFact: `Vendor well-level volumes differ from the filed lease total by ${resolved.reconciliationVariancePct.toFixed(2)}%.`,
      classification: "DERIVED", derivation: `Compared against a ${resolved.reconciliationThresholdPct.toFixed(2)}% review threshold.`,
      effect: Math.abs(resolved.reconciliationVariancePct) > resolved.reconciliationThresholdPct ? "Exceeds threshold; the production basis is not settled." : "Within threshold.",
      decisionRule: "R-11.", output: `${resolved.reconciliationVariancePct.toFixed(2)}% unreconciled variance.`,
    });
  }
  audit.push({
    question: `Why is confidence ${posture.confidence.overall}?`,
    source: "Decision engine", sourceId: "confidence", sourceTimestamp: null,
    rawFact: posture.confidence.components.map(c => `${c.domain}=${c.level}`).join(", "),
    classification: "DERIVED", derivation: posture.confidence.rule,
    effect: `Capped by ${posture.confidence.cappedBy}.`, decisionRule: "Confidence decomposition rule.",
    output: `${posture.confidence.overall}: ${posture.confidence.reason}`,
  });
  audit.push({
    question: `Why is closing readiness ${readiness.readiness}?`,
    source: "Decision engine", sourceId: "readiness", sourceTimestamp: null,
    rawFact: readiness.rationale, classification: "DERIVED",
    derivation: "Readiness runs on its own ladder from closing blockers and review items, independent of the posture ladder.",
    effect: readiness.independenceNote, decisionRule: readiness.ruleId, output: readiness.readiness,
  });
  audit.push({
    question: `Why did the system choose ${POSTURE_DISPLAY[posture.posture]}?`,
    source: "Decision engine", sourceId: "posture", sourceTimestamp: null,
    // Each rule states its own outcome. Listing the trace as bare ids with only
    // the matched one annotated reads as though every rule fired, which is the
    // opposite of first-match-wins.
    rawFact: posture.trace.map(t => `${t.ruleId} evaluated \u2192 ${t.matched ? "MATCH" : "no match"}`).join("; "),
    classification: "DERIVED",
    derivation: `Rules evaluated in precedence order; first match wins. ${posture.ruleId} matched on: ${POSTURE_RULE_TEST(posture.ruleId)}.`,
    effect: posture.rationale, decisionRule: `${posture.ruleId} (ruleset ${DECISION_RULE_VERSION})`,
    output: POSTURE_DISPLAY[posture.posture],
  });

  return {
    goldenSchemaVersion: GOLDEN_SCHEMA_VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    decisionRuleVersion: DECISION_RULE_VERSION,
    generatedAt: new Date().toISOString(),
    asOfDate: resolved.asOfDate,
    jobId: resolved.jobId,
    analysisId: resolved.analysisId || randomUUID(),

    assetIdentity: resolved.assetIdentity,
    evaluatedPosition: {
      label: resolved.positionLabel,
      mineralFraction: basis.mineralFraction,
      netMineralAcres: basis.netMineralAcres,
      netRevenueInterest: basis.netRevenueInterest,
      derivation: basis.derivation,
    },

    posture: posture.posture,
    postureDisplay: POSTURE_DISPLAY[posture.posture],
    postureRuleId: posture.ruleId,
    rationale: posture.rationale,
    investmentThesis: posture.investmentThesis,
    ruleTrace: posture.trace,

    confidence: posture.confidence,
    closingReadiness: readiness,

    underwritingCriteria: resolved.criteria,
    positionValue: value,
    exceptionImpacts: impacts,
    scenarios,
    sourceFreshness: freshness,
    auditTrail: audit,

    strongestPositives: posture.strongestPositives,
    materialRisks: posture.materialRisks,
    unresolvedAssumptions: posture.unresolvedAssumptions,
    conditionsToAdvance: posture.conditionsToAdvance,
    conditionsThatReverse: posture.conditionsThatReverse,

    titleStatus: resolved.titleStatus,
    inputs: {
      confirmedTractCount: resolved.confirmedTractCount,
      verifiedInstrumentCount: resolved.verifiedInstrumentCount,
      indexOnlyInstrumentCount: resolved.indexOnlyInstrumentCount,
      openReviewItemCount: resolved.openReviewItemCount,
      unresolvedAllocationCount: resolved.unresolvedAllocationCount,
      annualDecline: resolved.annualDecline,
      forecastBasisNote: resolved.forecastBasisNote,
      remainingOilBbl: resolved.remainingOilBbl,
      remainingGasMcf: resolved.remainingGasMcf,
      askingPriceUsd: resolved.askingPriceUsd,
      reconciliationVariancePct: resolved.reconciliationVariancePct,
      reconciliationThresholdPct: resolved.reconciliationThresholdPct,
    },
    sourceIds: Array.from(new Set(audit.map(a => a.sourceId).filter((x): x is string => !!x))),
  };
}

/** Rule test text, read from the ladder itself so the audit entry cannot drift from it. */
function POSTURE_RULE_TEST(ruleId: string): string {
  return POSTURE_RULES.find(r => r.id === ruleId)?.test ?? ruleId;
}
