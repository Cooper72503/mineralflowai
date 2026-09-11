/**
 * GOLDEN REPORT REGRESSION.
 *
 * The committed golden-decision-record.json is the reference output for the
 * shared golden input. If a code change makes the same synthetic asset
 * produce a materially different decision, these tests fail. That is the
 * intended behaviour: the fixture is updated deliberately, by regenerating
 * it with the sample script and reviewing the diff, never incidentally.
 *
 *   npx tsx scripts/generate-decision-record-sample.ts <dir>
 *
 * Expected values are asserted inline as well as against the fixture, so a
 * reviewer can see what the gold standard claims without opening the JSON.
 */
import { describe, it, expect } from "vitest";
import { buildDecisionRecord } from "../decision-record";
import { defaultScenarioDefinitions } from "../decision-inputs";
import { NOT_PROVIDED_LABEL, NO_THRESHOLD_LABEL } from "../decision-types";
import { goldenInput } from "./fixtures/golden-asset";
import golden from "./fixtures/golden-decision-record.json";

const input = goldenInput();
const record = buildDecisionRecord({ input, scenarioDefinitions: defaultScenarioDefinitions(input) });
const c = record.positionValue.cases;
const CENT = 2;

describe("golden record — ownership", () => {
  it("reproduces the exact ownership fractions and derived interest", () => {
    expect(record.evaluatedPosition.mineralFraction).toEqual({ n: "1", d: "4" });
    expect(record.evaluatedPosition.netMineralAcres).toBe(40);
    expect(record.evaluatedPosition.netRevenueInterest).toBe(0.01171875);
    expect(record.evaluatedPosition.netRevenueInterest).toBe(golden.evaluatedPosition.netRevenueInterest);
    expect(record.evaluatedPosition.derivation).toContain("1/4 x 1/4 x 3/16");
  });
});

describe("golden record — economics", () => {
  it("reproduces every value case to the cent", () => {
    expect(c.baseEconomicValueUsd).toBeCloseTo(47678.91, CENT);
    expect(c.downsideCommodityValueUsd).toBeCloseTo(37763.96, CENT);
    expect(c.upsideCommodityValueUsd).toBeCloseTo(57593.87, CENT);
    expect(c.quantifiedAssetExposureUsd).toBeCloseTo(5297.66, CENT);
    expect(c.evidenceAdjustedValueUsd).toBeCloseTo(42381.25, CENT);
    expect(c.riskAdjustedValueUsd).toBeCloseTo(32466.30, CENT);
    expect(record.positionValue.pvFactor).toBeCloseTo(0.7081433, 6);
  });
  it("matches the committed fixture exactly", () => {
    const g = golden.positionValue.cases;
    expect(c.baseEconomicValueUsd).toBeCloseTo(g.baseEconomicValueUsd, 8);
    expect(c.downsideCommodityValueUsd).toBeCloseTo(g.downsideCommodityValueUsd, 8);
    expect(c.evidenceAdjustedValueUsd).toBeCloseTo(g.evidenceAdjustedValueUsd, 8);
    expect(c.riskAdjustedValueUsd).toBeCloseTo(g.riskAdjustedValueUsd, 8);
  });
  it("withholds the maximum price because no buyer margin was supplied", () => {
    expect(record.underwritingCriteria.minimumMarginPct.classification).toBe("NOT_PROVIDED");
    expect(record.underwritingCriteria.minimumMarginPct.source).toBe(NOT_PROVIDED_LABEL);
    expect(record.positionValue.maxAcquisitionPriceUsd).toBeNull();
    expect(record.positionValue.maxPriceUnavailableReason).toContain(NO_THRESHOLD_LABEL);
    expect(record.positionValue.askingPriceUsd).toBeNull();
  });
});

describe("golden record — exceptions", () => {
  it("classifies all four exceptions with the expected independent properties", () => {
    const by = Object.fromEntries(record.exceptionImpacts.map(i => [i.findingId, i]));
    expect(Object.keys(by).sort()).toEqual(["E-01", "E-02", "E-03", "E-04"]);

    expect(by["E-01"]).toMatchObject({ blocksClosing: true, decisionMaterial: true, quantifiable: true, ownershipMaterial: true, requiresProfessionalReview: true });
    expect(by["E-01"].quantifiedValueImpactUsd).toBeCloseTo(-5297.66, CENT);

    expect(by["E-02"]).toMatchObject({ blocksClosing: true, decisionMaterial: false, quantifiable: false, ownershipMaterial: false, requiresProfessionalReview: true });
    expect(by["E-02"].quantifiedValueImpactUsd).toBeNull();

    expect(by["E-03"]).toMatchObject({ blocksClosing: true, decisionMaterial: true, quantifiable: false, ownershipMaterial: true });
    expect(by["E-04"]).toMatchObject({ blocksClosing: false, decisionMaterial: true, quantifiable: false, ownershipMaterial: true });
  });
});

describe("golden record — scenarios", () => {
  it("produces two ownership and two commodity scenarios with the expected deltas", () => {
    expect(record.scenarios).toHaveLength(4);
    const own = record.scenarios.filter(s => s.axis === "ownership");
    const com = record.scenarios.filter(s => s.axis === "commodity");
    expect(own).toHaveLength(2);
    expect(com).toHaveLength(2);

    const admitted = record.scenarios.find(s => s.id === "admit-E-01")!;
    expect(admitted.netRevenueInterest).toBeCloseTo(0.01171875 * 8 / 9, 12);
    expect(admitted.deltaUsd).toBeCloseTo(-5297.66, CENT);
    expect(admitted.deltaPct).toBeCloseTo(-1 / 9, 8);

    const down = record.scenarios.find(s => s.id === "deck-down")!;
    expect(down.netRevenueInterest).toBe(0.01171875);   // commodity scenario leaves ownership alone
    expect(down.economicValueUsd).toBeCloseTo(37763.96, CENT);
  });
});

describe("golden record — decision", () => {
  it("reaches the expected posture, readiness and confidence with the expected rules", () => {
    expect(record.posture).toBe("HOLD_FOR_DILIGENCE");
    expect(record.postureRuleId).toBe("R-07");
    expect(record.closingReadiness.readiness).toBe("NOT_READY");
    expect(record.closingReadiness.ruleId).toBe("C-02");
    expect(record.confidence.overall).toBe("LOW");
    expect(record.confidence.cappedBy).toBe("title_evidence");
    expect(record.posture).toBe(golden.posture);
    expect(record.closingReadiness.readiness).toBe(golden.closingReadiness.readiness);
  });
  it("evaluates rules in order and stops at the first match", () => {
    expect(record.ruleTrace.map(t => t.ruleId)).toEqual(["R-01", "R-02", "R-03", "R-04", "R-05", "R-06", "R-07"]);
    expect(record.ruleTrace.filter(t => t.matched)).toHaveLength(1);
    expect(record.ruleTrace[record.ruleTrace.length - 1].ruleId).toBe("R-07");
  });
  it("states each rule's own outcome, so the trace cannot read as though all fired", () => {
    const entry = record.auditTrail.find(a => a.question.toLowerCase().includes("choose"))!;
    expect(entry.rawFact).toContain("R-01 evaluated → no match");
    expect(entry.rawFact).toContain("R-06 evaluated → no match");
    expect(entry.rawFact).toContain("R-07 evaluated → MATCH");
    expect(entry.rawFact).not.toMatch(/R-01, R-02/);
  });
  it("describes the competing claim as included, never as legally valid", () => {
    const bp = record.positionValue.breakpoints.find(b => b.variable.includes("Competing"))!;
    expect(bp.flipsAt).toBe("if included in the ownership scenario");
    expect(JSON.stringify(record)).not.toMatch(/admitted as valid|claim is (valid|good)|legally valid/i);
  });
  it("states a thesis assembled from structured facts, with no dangling conjunction", () => {
    expect(record.investmentThesis).toContain("$47,679");
    expect(record.investmentThesis).toMatch(/prevents closing/);
    expect(record.investmentThesis).not.toMatch(/though[^.]*\bbut\b/i);
    expect(record.investmentThesis).toContain("No buyer return criterion was supplied");
  });
});

describe("golden record — traceability and discipline", () => {
  it("answers every challengeable question in the audit trail", () => {
    const qs = record.auditTrail.map(a => a.question).join(" | ");
    for (const needle of ["net revenue interest", "base economic value", "confidence", "closing readiness", "choose"]) {
      expect(qs.toLowerCase()).toContain(needle.toLowerCase());
    }
    expect(record.auditTrail).toHaveLength(9);
    for (const a of record.auditTrail) {
      expect(a.question && a.source && a.rawFact && a.classification && a.derivation && a.effect && a.decisionRule && a.output).toBeTruthy();
    }
  });
  it("flags the stale regulator pull and the unsearched pre-1962 window", () => {
    expect(record.sourceFreshness.find(f => f.role === "regulator")!.status).toBe("stale");
    expect(record.sourceFreshness.find(f => f.role === "county_pre1962")!.status).toBe("missing");
  });
  it("uses no prohibited title language anywhere", () => {
    expect(JSON.stringify(record)).not.toMatch(/clear title|marketable title|certified title|valid title|invalid claim|title is (clear|good|valid)/i);
  });
  it("reconciles across pages: every figure the report shows agrees with the record", () => {
    expect(c.evidenceAdjustedValueUsd).toBeCloseTo(c.baseEconomicValueUsd! - c.quantifiedAssetExposureUsd, 8);
    expect(c.riskAdjustedValueUsd).toBeCloseTo(c.downsideCommodityValueUsd! - c.quantifiedAssetExposureUsd, 8);
    const measured = record.exceptionImpacts.reduce((s, i) => s + (i.quantifiedValueImpactUsd != null && i.quantifiedValueImpactUsd < 0 ? Math.abs(i.quantifiedValueImpactUsd) : 0), 0);
    expect(c.quantifiedAssetExposureUsd).toBeCloseTo(measured, 8);
    // The waterfall's subtotal is the same evidence-adjusted value shown in the table.
    const subtotal = record.positionValue.waterfall.find(w => w.kind === "subtotal")!;
    expect(subtotal.runningUsd).toBeCloseTo(c.evidenceAdjustedValueUsd!, 8);
    // Scenario delta equals the exception it quantifies.
    const admitted = record.scenarios.find(s => s.id === "admit-E-01")!;
    const e1 = record.exceptionImpacts.find(i => i.findingId === "E-01")!;
    expect(admitted.deltaUsd).toBeCloseTo(e1.quantifiedValueImpactUsd!, 8);
  });
  it("is stable across runs", () => {
    const again = buildDecisionRecord({ input: goldenInput(), scenarioDefinitions: defaultScenarioDefinitions(goldenInput()) });
    expect(again.posture).toBe(record.posture);
    expect(again.ruleTrace).toEqual(record.ruleTrace);
    expect(again.positionValue.cases).toEqual(record.positionValue.cases);
    expect(again.investmentThesis).toBe(record.investmentThesis);
  });
});
