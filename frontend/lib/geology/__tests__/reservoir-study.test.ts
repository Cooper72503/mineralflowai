import { describe, expect, it } from "vitest";
import { CALIBRATIONS, DOCUMENTS, MEASUREMENTS } from "../evidence/registry";
import { validateEvidence } from "../evidence/validate";
import { buildReservoirStudy } from "../reservoir-study";
import { RESERVOIRS, reservoirById, reservoirsForField } from "../reservoirs";

const study = (id: string) => buildReservoirStudy(reservoirById(id)!);

describe("evidence registry", () => {
  it("passes validation: units, ranges, pages, applicability and re-checkable text", () => {
    expect(validateEvidence(DOCUMENTS, MEASUREMENTS, CALIBRATIONS)).toEqual([]);
  });
  it("rejects a value with no saturation basis, an out-of-document page, or a text-layer value without its words", () => {
    const bad = [{ ...MEASUREMENTS.find(m => m.id === "doe-seminole-roz-oil-saturation")!, id: "x1", saturationBasis: undefined },
      { ...MEASUREMENTS[0], id: "x2", source: { ...MEASUREMENTS[0].source, pdfPage: 999 } },
      { ...MEASUREMENTS[0], id: "x3", extraction: { method: "text_layer" as const, checkedOn: "2026-11-23" } }];
    const errors = validateEvidence(DOCUMENTS, bad, []);
    expect(errors.some(e => /x1: a saturation must state/.test(e))).toBe(true);
    expect(errors.some(e => /x2: PDF page 999 is outside/.test(e))).toBe(true);
    expect(errors.some(e => /x3: .* needs the exact words/.test(e))).toBe(true);
  });
});

describe("Seminole field upper ROZ: field-level published measurements", () => {
  const s = study("seminole-upper-roz");
  it("uses only field-level values for this interval and computes oil in place at reservoir conditions", () => {
    expect(s.status).toBe("reservoir_volume_only");
    expect(s.selections.find(x => x.key === "area")!.chosen!.id).toBe("doe-seminole-field-area");
    expect(s.selections.find(x => x.key === "net_pay")!.chosen!.id).toBe("doe-seminole-roz-net-pay");
    expect(s.selections.find(x => x.key === "porosity")!.chosen!.id).toBe("doe-seminole-roz-porosity");
    expect(s.selections.find(x => x.key === "saturation")!.chosen!.id).toBe("doe-seminole-roz-oil-saturation");
    if (s.hcpv.status !== "calculated") throw Error(s.hcpv.reason);
    // 7,758 × 23,700 ac × 197 ft × φ × 0.32, φ = 0.13 / 0.14 / 0.15 (printed range and its midpoint)
    expect(s.hcpv.value.central).toBeCloseTo(7758 * 23700 * 197 * 0.14 * 0.32, 0);
    expect(s.hcpv.value.low).toBeCloseTo(7758 * 23700 * 197 * 0.13 * 0.32, 0);
    expect(s.hcpv.value.high).toBeCloseTo(7758 * 23700 * 197 * 0.15 * 0.32, 0);
    expect(s.hcpv.value.fixedAtCentral).toEqual(["reservoir area", "net pay", "oil saturation"]);
    expect(s.hcpv.flags).toContain("Saturation is present-day, so this is oil in place at that saturation, not original oil in place.");
  });
  it("stops the stock-tank conversion for the missing field FVF, and does not substitute the regional Partition #3 value", () => {
    expect(s.oilInPlace.status).toBe("stopped");
    const fvf = s.selections.find(x => x.key === "formation_volume_factor")!;
    expect(fvf.chosen).toBeNull();
    expect(fvf.candidates.map(c => [c.measurement.value, c.usable])).toEqual([[1.39, false]]);
    expect(fvf.candidates[0].reason).toMatch(/Regional average \(DOE ROZ Partition #3\).*never substituted/);
    expect(s.missing.map(m => m.label)).toEqual(["Oil formation volume factor (Bo)"]);
    expect(s.missing[0].needed).toMatch(/PVT or fluid study/);
  });
  it("states that the field area stands in for the interval's own extent, and that the unit area is a different scope", () => {
    const area = s.selections.find(x => x.key === "area")!;
    expect(area.notes[0]).toMatch(/do not map the upper ROZ below the main pay zone's own areal extent/);
    expect(area.candidates.find(c => c.measurement.id === "lucia-ssau-area")!.reason).toMatch(/not the whole Seminole field/);
  });
  it("is reproducible: the same evidence gives the same numbers and fingerprint", () => {
    const again = study("seminole-upper-roz");
    expect(again.fingerprint).toBe(s.fingerprint);
    expect(again.hcpv).toEqual(s.hcpv);
  });
});

describe("Seminole San Andres Unit main pay and ODC: what is missing, precisely", () => {
  it("SAU main pay: area only; porosity, initial saturation, net pay and FVF are missing; the published OOIP is a comparison flagged for its unit", () => {
    const s = study("seminole-sau-main-pay");
    expect(s.status).toBe("insufficient");
    expect(s.selections.find(x => x.key === "area")!.chosen!.id).toBe("lucia-ssau-area");
    expect(s.missing.map(m => m.label)).toEqual(["Net pay (h)", "Porosity (φ)", "Oil or water saturation (So / Sw)", "Oil formation volume factor (Bo)"]);
    expect(s.comparisons[0].value).toBe("1,100 Mstb as printed");
    expect(s.comparisons[0].note).toMatch(/probably MMSTB/);
    expect(s.calibrations.map(c => c.id)).toContain("seminole-archie-parameters");
  });
  it("ODC: the field area is the only measurement; Partition #2 ROZ averages describe a different interval and region and are not used", () => {
    const s = study("odc-san-andres");
    expect(s.status).toBe("insufficient");
    expect(s.selections.find(x => x.key === "area")!.chosen!.value).toBe(2800);
    expect(s.missing.map(m => m.label)).toEqual(["Net pay (h)", "Porosity (φ)", "Oil or water saturation (So / Sw)", "Oil formation volume factor (Bo)"]);
    expect(s.missing[1].detail).toMatch(/0\.09 fraction \(DOE ROZ Partition #2\): Regional average/);
    expect(s.hcpv.status).toBe("stopped");
  });
});

describe("which reservoirs a lead's RRC field belongs to", () => {
  it("maps only the Seminole field itself and ODC; East Seminole is a separate buildup", () => {
    expect(reservoirsForField("GAINES", "SEMINOLE (SAN ANDRES)").map(r => r.id)).toEqual(["seminole-upper-roz", "seminole-sau-main-pay"]);
    expect(reservoirsForField("GAINES", "O D C (SAN ANDRES)").map(r => r.id)).toEqual(["odc-san-andres"]);
    expect(reservoirsForField("GAINES", "SEMINOLE  EAST (SAN ANDRES)")).toEqual([]);
    expect(reservoirsForField("GAINES", "SEMINOLE (DEVONIAN)")).toEqual([]);
    expect(reservoirsForField("YOAKUM", "SEMINOLE (SAN ANDRES)")).toEqual([]);
    expect(RESERVOIRS).toHaveLength(3);
  });
});
