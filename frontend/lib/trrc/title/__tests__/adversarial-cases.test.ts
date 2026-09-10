/**
 * Adversarial cases for the decision engine. Fifteen situations that a real
 * acquisition file produces, each asserting that the engine behaves sensibly
 * rather than merely not crashing.
 *
 * All inputs are FIXTURES.
 */
import { describe, it, expect } from "vitest";
import { buildDecisionRecord } from "../decision-record";
import { buildUnderwritingCriteria, defaultScenarioDefinitions, shiftDeck } from "../decision-inputs";
import { NOT_PROVIDED_LABEL, NO_THRESHOLD_LABEL } from "../decision-types";
import type { ChainFinding } from "../chain-types";
import type { DecisionInputs } from "../decision-types";
import { goldenInput, GOLDEN_BASE_DECK, GOLDEN_FINDINGS, F } from "./fixtures/golden-asset";

const criteria = (marginPct: number | null) => buildUnderwritingCriteria({
  discountRate: 0.10, minimumMarginPct: marginPct, baseDeck: GOLDEN_BASE_DECK,
  downsideDeck: shiftDeck(GOLDEN_BASE_DECK, 0.8), upsideDeck: shiftDeck(GOLDEN_BASE_DECK, 1.2), forecastHorizonYears: 20,
});

const CLEAN: Partial<DecisionInputs> = {
  findings: [], titleStatus: "NO_SURFACE_DISCONTINUITIES_DETECTED",
  indexOnlyInstrumentCount: 0, openReviewItemCount: 0, unresolvedAllocationCount: 0,
  reconciliationVariancePct: null, openRegulatoryItems: [],
};

const build = (over: Partial<DecisionInputs>) => {
  const input = goldenInput(over);
  return buildDecisionRecord({ input, scenarioDefinitions: defaultScenarioDefinitions(input) });
};

const finding = (over: Partial<ChainFinding>): ChainFinding => ({ ...GOLDEN_FINDINGS[0], ...over });

describe("adversarial cases", () => {
  it("01 — strong economics, complete evidence: PROCEED and ready for review", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), askingPriceUsd: 10_000 });
    expect(r.posture).toBe("PROCEED");
    expect(r.postureRuleId).toBe("R-12");
    expect(r.closingReadiness.readiness).toBe("READY_FOR_FINAL_REVIEW");
    expect(r.confidence.overall).not.toBe("INSUFFICIENT");
    expect(r.positionValue.marginToBaseUsd!).toBeGreaterThan(0);
  });

  it("02 — strong economics, unresolved title blocker: held, not repriced", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), askingPriceUsd: 10_000, findings: [GOLDEN_FINDINGS[1]] });
    expect(r.posture).toBe("HOLD_FOR_DILIGENCE");
    expect(r.postureRuleId).toBe("R-07");
    expect(r.closingReadiness.readiness).toBe("NOT_READY");
    expect(r.positionValue.cases.quantifiedAssetExposureUsd).toBe(0);
  });

  it("03 — strong economics, quantified ownership risk: conditional, and priced", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), askingPriceUsd: 10_000, findings: [GOLDEN_FINDINGS[0]] });
    expect(r.posture).toBe("CONDITIONAL_PROCEED");
    expect(r.postureRuleId).toBe("R-08");
    expect(r.positionValue.cases.quantifiedAssetExposureUsd).toBeGreaterThan(0);
    expect(r.positionValue.cases.evidenceAdjustedValueUsd!).toBeLessThan(r.positionValue.cases.baseEconomicValueUsd!);
    expect(r.closingReadiness.readiness).toBe("CONDITIONAL");   // measured, but still must be cured
  });

  it("04 — weak economics, clean evidence: PASS on value alone", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), remainingOilBbl: 0, remainingGasMcf: 0 });
    expect(r.posture).toBe("PASS");
    expect(r.postureRuleId).toBe("R-05");
  });

  it("05 — asking price above modelled value: PASS", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), askingPriceUsd: 5_000_000 });
    expect(r.posture).toBe("PASS");
    expect(r.postureRuleId).toBe("R-06");
    expect(r.positionValue.marginToBaseUsd!).toBeLessThan(0);
  });

  it("06 — asking price below value but above the return ceiling: conditional", () => {
    const probe = build({ ...CLEAN, criteria: criteria(0.25) });
    const max = probe.positionValue.maxAcquisitionPriceUsd!;
    const base = probe.positionValue.cases.baseEconomicValueUsd!;
    const r = build({ ...CLEAN, criteria: criteria(0.25), askingPriceUsd: (max + base) / 2 });
    expect(r.posture).toBe("CONDITIONAL_PROCEED");
    expect(r.postureRuleId).toBe("R-09");
  });

  it("07 — missing asking price: no comparison, but thresholds still published", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), askingPriceUsd: null });
    expect(r.positionValue.askingPriceUsd).toBeNull();
    expect(r.positionValue.priceToValueRatio).toBeNull();
    expect(r.positionValue.maxAcquisitionPriceUsd).not.toBeNull();
    expect(r.positionValue.decisionMatrix.every(b => b.available)).toBe(true);
    expect(r.conditionsToAdvance.join(" ")).toMatch(/Obtain the seller's asking price/);
  });

  it("08 — missing buyer return criteria: no maximum price is manufactured", () => {
    const r = build({ ...CLEAN, askingPriceUsd: 10_000 });
    expect(r.underwritingCriteria.minimumMarginPct.classification).toBe("NOT_PROVIDED");
    expect(r.positionValue.maxAcquisitionPriceUsd).toBeNull();
    expect(r.positionValue.maxPriceUnavailableReason).toContain(NO_THRESHOLD_LABEL);
    expect(r.positionValue.decisionMatrix.every(b => !b.available)).toBe(true);
    expect(r.posture).toBe("PROCEED");   // economics still clear; only the ceiling is unknown
  });

  it("09 — missing production data: INSUFFICIENT_DATA, not a zero valuation", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), remainingOilBbl: null, remainingGasMcf: null });
    expect(r.posture).toBe("INSUFFICIENT_DATA");
    expect(r.postureRuleId).toBe("R-04");
    expect(r.positionValue.cases.baseEconomicValueUsd).toBeNull();
    expect(r.confidence.components.find(c => c.domain === "production")!.level).toBe("INSUFFICIENT");
  });

  it("10 — vendor and regulator disagree materially: conditional, and named in confidence", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), reconciliationVariancePct: 8.4 });
    expect(r.posture).toBe("CONDITIONAL_PROCEED");
    expect(r.postureRuleId).toBe("R-11");
    expect(r.confidence.components.find(c => c.domain === "production")!.level).toBe("LOW");
    expect(r.closingReadiness.unresolvedEconomicAssumptions.join(" ")).toMatch(/8\.40%/);
  });

  it("11 — multiple competing claims: each measured separately and summed", () => {
    const second = finding({ findingId: "E-99", explanation: "A second party conveyed an undivided 1/16 mineral interest with no evidenced acquisition." });
    const r = build({ ...CLEAN, criteria: criteria(0.25), findings: [GOLDEN_FINDINGS[0], second] });
    const measured = r.exceptionImpacts.filter(i => i.quantifiedValueImpactUsd != null);
    expect(measured).toHaveLength(2);
    expect(r.scenarios.filter(s => s.axis === "ownership" && !s.isPrimary)).toHaveLength(2);
    const sum = measured.reduce((s, i) => s + Math.abs(i.quantifiedValueImpactUsd!), 0);
    expect(r.positionValue.cases.quantifiedAssetExposureUsd).toBeCloseTo(sum, 6);
  });

  it("12 — unresolved co-grantee allocation: blocks, ownership-material, never split evenly", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25), findings: [GOLDEN_FINDINGS[2]], unresolvedAllocationCount: 1 });
    const e = r.exceptionImpacts[0];
    expect(e.blocksClosing).toBe(true);
    expect(e.ownershipMaterial).toBe(true);
    expect(e.quantifiable).toBe(false);
    expect(e.unquantifiedReason).toMatch(/equal shares are never assumed/);
    expect(r.posture).toBe("HOLD_FOR_DILIGENCE");
    expect(r.confidence.components.find(c => c.domain === "ownership")!.level).toBe("LOW");
  });

  it("13 — retrieval failure: reported as missing coverage, never as no-issues-found", () => {
    const r = build({
      ...CLEAN, criteria: criteria(0.25),
      findings: [finding({ findingId: "E-90", type: "PROVIDER_UNAVAILABLE", severity: "info", title: "No automated county access", explanation: "No supported provider covers this county." })],
      sourceFreshness: [...goldenInput().sourceFreshness, { source: "County B", role: "county_b", asOf: "2026-10-01", retrievedAt: null, coverage: "Not retrieved", ageDays: null, staleAfterDays: 30, status: "missing", note: "" }],
    });
    const missing = r.sourceFreshness.find(f => f.role === "county_b")!;
    expect(missing.status).toBe("missing");
    expect(r.sourceFreshness.every(f => f.status !== "current" || f.retrievedAt != null)).toBe(true);
  });

  it("14 — stale regulatory data is flagged against its own window", () => {
    const r = build({ ...CLEAN, criteria: criteria(0.25) });
    const reg = r.sourceFreshness.find(f => f.role === "regulator")!;
    expect(reg.status).toBe("stale");
    expect(reg.ageDays!).toBeGreaterThan(reg.staleAfterDays);
    const county = r.sourceFreshness.find(f => f.role === "county")!;
    expect(county.status).toBe("current");
  });

  it("15 — insufficient evidence to compute NRI: no value, no posture beyond INSUFFICIENT_DATA", () => {
    const i = goldenInput({ ...CLEAN, criteria: criteria(0.25) });
    i.basis.mineralFraction = null;
    const r = buildDecisionRecord({ input: i, scenarioDefinitions: defaultScenarioDefinitions(i) });
    expect(r.posture).toBe("INSUFFICIENT_DATA");
    expect(r.postureRuleId).toBe("R-03");
    expect(r.evaluatedPosition.netRevenueInterest).toBeNull();
    expect(r.positionValue.cases.baseEconomicValueUsd).toBeNull();
    expect(r.closingReadiness.readiness).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.confidence.overall).toBe("INSUFFICIENT");
  });
});

describe("invariants that must hold in every adversarial case", () => {
  const cases: Array<[string, Partial<DecisionInputs>]> = [
    ["clean", { ...CLEAN, criteria: criteria(0.25), askingPriceUsd: 10_000 }],
    ["blocker", { ...CLEAN, criteria: criteria(0.25), findings: [GOLDEN_FINDINGS[1]] }],
    ["priced", { ...CLEAN, criteria: criteria(0.25), findings: [GOLDEN_FINDINGS[0]] }],
    ["no price", { ...CLEAN, criteria: criteria(0.25) }],
    ["no criteria", { ...CLEAN }],
    ["no production", { ...CLEAN, criteria: criteria(0.25), remainingOilBbl: null, remainingGasMcf: null }],
    ["golden", {}],
  ];

  for (const [name, over] of cases) {
    it(`${name}: no prohibited title language, no invented inputs, provenance everywhere`, () => {
      const r = build(over);
      const json = JSON.stringify(r);
      expect(json).not.toMatch(/clear title|marketable title|certified title|valid title|invalid claim|title is clear|admitted as valid|legally valid/i);

      // Nothing invented.
      if (over.askingPriceUsd == null) expect(r.positionValue.askingPriceUsd).toBeNull();
      if (r.underwritingCriteria.minimumMarginPct.classification === "NOT_PROVIDED") {
        expect(r.positionValue.maxAcquisitionPriceUsd).toBeNull();
      }
      // Every criterion is tagged.
      for (const c of Object.values(r.underwritingCriteria)) {
        expect(["USER_INPUT", "OBSERVED", "DERIVED", "SYSTEM_DEFAULT", "NOT_PROVIDED"]).toContain(c.classification);
        expect(c.source.length).toBeGreaterThan(0);
      }
      // Every exception carries all six independent properties and a resolution.
      for (const e of r.exceptionImpacts) {
        expect(typeof e.blocksClosing).toBe("boolean");
        expect(typeof e.decisionMaterial).toBe("boolean");
        expect(typeof e.quantifiable).toBe("boolean");
        expect(typeof e.ownershipMaterial).toBe("boolean");
        expect(typeof e.requiresProfessionalReview).toBe("boolean");
        expect(e.resolution.length).toBeGreaterThan(0);
        if (e.quantifiedValueImpactUsd == null) expect(e.unquantifiedReason).toBeTruthy();
      }
      // Audit answers each conclusion with all seven fields.
      for (const a of r.auditTrail) {
        expect(a.question && a.source && a.rawFact && a.derivation && a.effect && a.decisionRule && a.output).toBeTruthy();
      }
      // Readiness never claims marketability.
      expect(r.closingReadiness.disclaimer).toMatch(/not a statement that title is marketable/i);
      // Cross-page reconciliation: waterfall end matches the maximum price.
      const result = r.positionValue.waterfall.find(w => w.kind === "result");
      if (result && r.positionValue.maxAcquisitionPriceUsd != null) {
        expect(result.runningUsd).toBeCloseTo(r.positionValue.maxAcquisitionPriceUsd, 6);
      }
      // Exposure equals the sum of measured adverse impacts.
      const sum = r.exceptionImpacts.reduce((s, i) => s + (i.quantifiedValueImpactUsd != null && i.quantifiedValueImpactUsd < 0 ? Math.abs(i.quantifiedValueImpactUsd) : 0), 0);
      expect(r.positionValue.cases.quantifiedAssetExposureUsd).toBeCloseTo(sum, 6);
      // Evidence-adjusted value reconciles with base less exposure.
      if (r.positionValue.cases.baseEconomicValueUsd != null) {
        expect(r.positionValue.cases.evidenceAdjustedValueUsd).toBeCloseTo(
          r.positionValue.cases.baseEconomicValueUsd - r.positionValue.cases.quantifiedAssetExposureUsd, 6);
      }
    });
  }
});
