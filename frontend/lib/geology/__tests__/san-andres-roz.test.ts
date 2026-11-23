import { describe, expect, it } from "vitest";
import { GAINES_ROZ_PARTITIONS, GAINES_ROZ_TOTALS, describeRoz, parseFieldName, reservoirPosition, rozCitation, sanAndresRozContext } from "../san-andres-roz";

const partitionOf = (field: string) => { const c = sanAndresRozContext("GAINES", field); return c?.status === "assigned" ? c.partition!.id : c?.status ?? null; };

describe("San Andres ROZ dataset (DOE/NETL-2020/2627)", () => {
  it("transcribes every unit consistently: published OIP per acre-foot = 7,758 × porosity × oil saturation ÷ FVF", () => {
    for (const p of GAINES_ROZ_PARTITIONS) for (const unit of [p.roz1.higher, p.roz1.lower, p.roz2.higher, p.roz2.lower]) {
      expect(Math.abs((7758 * unit.porosity * unit.oilSaturation) / unit.fvf - unit.oipBblPerAcreFt)).toBeLessThan(1.5);
    }
  });

  it("partition acres, in-place, recoverable and viable volumes sum to the published county totals", () => {
    const sum = (f: (p: (typeof GAINES_ROZ_PARTITIONS)[number]) => number) => GAINES_ROZ_PARTITIONS.reduce((a, p) => a + f(p), 0);
    expect(sum(p => p.assessedAcres)).toBe(GAINES_ROZ_TOTALS.assessedAcres);
    expect(sum(p => p.totalAcres - p.excludedAcres)).toBe(GAINES_ROZ_TOTALS.assessedAcres);
    expect(Math.abs(sum(p => p.oipMMbbl.total) - GAINES_ROZ_TOTALS.oipMMbbl.total)).toBeLessThanOrEqual(10); // "totals may not add due to rounding"
    expect(sum(p => p.technicallyRecoverableMMbbl)).toBe(GAINES_ROZ_TOTALS.technicallyRecoverableMMbbl);
    expect(sum(p => p.commerciallyViableMMbbl)).toBe(GAINES_ROZ_TOTALS.commerciallyViableMMbbl);
    for (const p of GAINES_ROZ_PARTITIONS) expect(p.oipMMbbl.higher + p.oipMMbbl.lower).toBe(p.oipMMbbl.total);
  });
});

describe("placing a field in a partition", () => {
  it("parses RRC field names as they really appear", () => {
    expect(parseFieldName("O D C (SAN ANDRES)")).toEqual({ core: "ODC", direction: null, reservoir: "SAN ANDRES" });
    expect(parseFieldName("SEMINOLE  EAST (SAN ANDRES)")).toEqual({ core: "SEMINOLE", direction: "E", reservoir: "SAN ANDRES" });
    expect(parseFieldName("SEMINOLE  S.E. (SAN ANDRES)")).toMatchObject({ core: "SEMINOLE", direction: "SE" });
    expect(parseFieldName("N . W. SEMINOLE CANYON")).toEqual({ core: "SEMINOLE", direction: "NW", reservoir: "CANYON" });
    expect(parseFieldName("SEMINOLE (SAN ANDRES)FIELD")).toMatchObject({ core: "SEMINOLE", reservoir: "SAN ANDRES" });
    expect(parseFieldName("RUSSELL (CLEARFORK CONSOLIDATED")).toMatchObject({ core: "RUSSELL", direction: null, reservoir: "CLEARFORK CONSOLIDATED" });
    expect(parseFieldName("G-M-K  SOUTH (SAN ANDRES)")).toMatchObject({ core: "GMK", direction: "S" });
  });

  it("assigns only the fields the appraisal names, as it names them", () => {
    expect(partitionOf("O D C (SAN ANDRES)")).toBe(2);
    expect(partitionOf("ODC (SAN ANDRES)")).toBe(2);
    expect(partitionOf("HAVEMEYER (SAN ANDRES)")).toBe(2);
    expect(partitionOf("RUSSELL  S. (SAN ANDRES)")).toBe(2);
    expect(partitionOf("RUSSELL SOUTH (SAN ANDRES)")).toBe(2);
    expect(partitionOf("WASSON")).toBe(1);
    expect(partitionOf("WASSON (GLORIETA)")).toBe(1);
    for (const f of ["SEMINOLE (SAN ANDRES)", "SEMINOLE  EAST (SAN ANDRES)", "NORTH SEMINOLE (SAN ANDRES)", "WEST SEMINOLE", "SEMINOLE  SW. (SAN ANDRES)", "BLACKWATCH (SAN ANDRES)"]) expect(partitionOf(f)).toBe(3);
    for (const f of ["ROBERTSON (SAN ANDRES)", "ROBERTSON  N. (CLEAR FORK 7100)", "NORTH ROBERTSON (DEVONIAN)", "JENKINS (SAN ANDRES)", "CARM-ANN (SAN ANDRES)"]) expect(partitionOf(f)).toBe(4);
    for (const f of ["G-M-K (SAN ANDRES)", "ADAIR (WOLFCAMP)", "ADAIR", "CEDAR LAKE", "HOMANN (SAN ANDRES)"]) expect(partitionOf(f)).toBe(5);
  });

  it("does not guess a field the appraisal does not name, names in two partitions, or only resembles a named one", () => {
    for (const f of ["RUSSELL  NORTH (DEVONIAN)", "RUSSELL (CLEARFORK 7000)", "ODC  NE. (SAN ANDRES)", "SEMINOLE DRAW (SAN ANDRES)", "WASSON 72", "WASSON  S. (WICHITA-ALBANY)", "G-M-K  SOUTH (SAN ANDRES)", "JENKINS  NORTH (CLEAR FORK)", "MEANS  N. (QUEEN SAND)", "HARRIS (QUEEN)"]) expect(partitionOf(f)).toBe("not_established");
    const hanford = sanAndresRozContext("GAINES", "HANFORD (SAN ANDRES)")!;
    expect(hanford.status).toBe("not_established");
    expect(hanford.reason).toMatch(/Partition #3 and Partition #5/);
  });

  it("says nothing outside Gaines County or without a field", () => {
    expect(sanAndresRozContext("YOAKUM", "WASSON")).toBeNull();
    expect(sanAndresRozContext("FISHER", "SEMINOLE (SAN ANDRES)")).toBeNull();
    expect(sanAndresRozContext("GAINES", null)).toBeNull();
    expect(sanAndresRozContext("Gaines County", "ODC (SAN ANDRES)")?.partition?.id).toBe(2);
  });

  it("places the producing reservoir above, in or below the San Andres", () => {
    expect(reservoirPosition("SAN ANDRES").position).toBe("san_andres");
    expect(reservoirPosition("QUEEN SAND")).toEqual({ position: "above", formation: "Queen" });
    expect(reservoirPosition("BASAL YATES")).toEqual({ position: "above", formation: "Yates" });
    expect(reservoirPosition("WOLFCAMP")).toEqual({ position: "below", formation: "Wolfcamp" });
    expect(reservoirPosition("DEV")).toEqual({ position: "below", formation: "Devonian" });
    expect(reservoirPosition("CLEARFORK 7000")).toEqual({ position: "below", formation: "Clear Fork" });
    expect(reservoirPosition("SAN ANGELO").position).toBe("below");
    expect(reservoirPosition("6600").position).toBe("unknown");
    expect(reservoirPosition(null).position).toBe("unknown");
  });
});

describe("wording", () => {
  it("states the ODC lease's partition as surrounding context, with the exhibits it came from", () => {
    const ctx = sanAndresRozContext("GAINES", "O D C (SAN ANDRES)")!;
    const d = describeRoz(ctx, "lease");
    expect(d.summary).toMatch(/Partition #2/);
    expect(d.summary).toMatch(/not this lease/);
    expect(d.figures[0].value).toBe("about 5,630 ft; 179 ft net pay; 9% porosity; 44% oil saturation");
    expect(d.figures[1].value).toBe("about 5,780 ft; 151 ft net pay; 9% porosity; 40% oil saturation");
    expect(d.reservoirNote).toMatch(/not established/);
    expect(d.caveat).toMatch(/no reserves, rights or value/i);
    expect(rozCitation(ctx)).toMatch(/DOE\/NETL-2020\/2627.*Exhibit 2-17, p\. 37/);
  });

  it("adds the Seminole field's own published ROZ values for Seminole leads", () => {
    const d = describeRoz(sanAndresRozContext("GAINES", "SEMINOLE  EAST (SAN ANDRES)")!, "well");
    expect(d.figures.at(-1)).toEqual({ label: "Seminole field ROZ (published)", value: "upper ROZ 246 ft gross, 197 ft net pay, 13–15% porosity, 32% oil saturation, below the field's main pay zone" });
  });

  it("explains, without figures, why an unnamed field gets no partition", () => {
    const d = describeRoz(sanAndresRozContext("GAINES", "RUSSELL  NORTH (DEVONIAN)")!, "well");
    expect(d.figures).toEqual([]);
    expect(d.summary).toMatch(/not established/);
    expect(d.reservoirNote).toMatch(/Devonian, which lies below the San Andres/);
  });
});
