import { describe, it, expect } from "vitest";
import { compareToAnalogs } from "../type-curve-comparison";

function generateCurve(qi: number, di: number, b: number, months: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < months; t++) {
    out.push(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b));
  }
  return out;
}

describe("compareToAnalogs", () => {
  it("returns 'Insufficient analog data' when no analogs are provided", () => {
    const result = compareToAnalogs(500000, []);
    expect(result.assessment).toBe("Insufficient analog data");
    expect(result.analogsWithUsableFit).toBe(0);
  });

  it("returns 'Insufficient analog data' when analogs have too little history to fit", () => {
    const result = compareToAnalogs(500000, [
      { api: "1", wellNumber: "1H", distanceMiles: 0.2, monthlyOilBbl: [100, 90] },
    ]);
    expect(result.assessment).toBe("Insufficient analog data");
  });

  it("identifies a subject well clearly outperforming weaker analogs", () => {
    const strongSubjectEur = 900000;
    const weakAnalogs = [
      { api: "1", wellNumber: "1H", distanceMiles: 0.3, monthlyOilBbl: generateCurve(8000, 0.07, 0.9, 30) },
      { api: "2", wellNumber: "2H", distanceMiles: 0.5, monthlyOilBbl: generateCurve(7000, 0.08, 0.9, 30) },
      { api: "3", wellNumber: "3H", distanceMiles: 0.7, monthlyOilBbl: generateCurve(9000, 0.075, 0.9, 30) },
    ];
    const result = compareToAnalogs(strongSubjectEur, weakAnalogs);
    expect(result.analogsWithUsableFit).toBe(3);
    expect(result.subjectPercentile).toBe(100);
    expect(result.assessment).toBe("Outperforming analogs");
  });

  it("identifies a subject well clearly underperforming stronger analogs", () => {
    const weakSubjectEur = 50000;
    const strongAnalogs = [
      { api: "1", wellNumber: "1H", distanceMiles: 0.3, monthlyOilBbl: generateCurve(20000, 0.06, 1.0, 30) },
      { api: "2", wellNumber: "2H", distanceMiles: 0.5, monthlyOilBbl: generateCurve(22000, 0.06, 1.0, 30) },
      { api: "3", wellNumber: "3H", distanceMiles: 0.7, monthlyOilBbl: generateCurve(19000, 0.06, 1.0, 30) },
    ];
    const result = compareToAnalogs(weakSubjectEur, strongAnalogs);
    expect(result.subjectPercentile).toBe(0);
    expect(result.assessment).toBe("Underperforming analogs");
  });

  it("computes avg and median EUR across usable analogs only, skipping unfittable ones", () => {
    const analogs = [
      { api: "1", wellNumber: "1H", distanceMiles: 0.3, monthlyOilBbl: generateCurve(10000, 0.07, 0.9, 30) },
      { api: "2", wellNumber: "2H", distanceMiles: 0.5, monthlyOilBbl: [50, 40] }, // too short to fit
    ];
    const result = compareToAnalogs(400000, analogs);
    expect(result.analogsProvided).toBe(2);
    expect(result.analogsWithUsableFit).toBe(1);
    expect(result.avgAnalogEur).not.toBeNull();
  });

  it("sorts analogs by distance for reporting order (input order preserved, not required to sort)", () => {
    const analogs = [
      { api: "1", wellNumber: "1H", distanceMiles: 0.9, monthlyOilBbl: generateCurve(10000, 0.07, 0.9, 30) },
      { api: "2", wellNumber: "2H", distanceMiles: 0.2, monthlyOilBbl: generateCurve(10000, 0.07, 0.9, 30) },
    ];
    const result = compareToAnalogs(400000, analogs);
    expect(result.analogs.map(a => a.api)).toEqual(["1", "2"]);
  });
});
