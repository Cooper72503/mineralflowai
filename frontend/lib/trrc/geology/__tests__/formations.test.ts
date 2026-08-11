import { describe, it, expect } from "vitest";
import { resolveFormationDepthContext } from "../formations";

const baseInputs = {
  subjectFieldName: null as string | null,
  permittedFormationRaw: null as string | null,
  subjectTvdFt: null as number | null,
  subjectTvdSource: null as string | null,
  referenceElevationFt: null as number | null,
  referenceElevationSource: null as string | null,
};

describe("resolveFormationDepthContext", () => {
  it("always reports formationTopsAvailable=false and a real data-gap note", () => {
    const ctx = resolveFormationDepthContext(baseInputs);
    expect(ctx.formationTopsAvailable).toBe(false);
    expect(ctx.dataGapNote).toContain("not available");
  });

  it("computes TVDSS only when both TVD and reference elevation are supplied", () => {
    const noElevation = resolveFormationDepthContext({ ...baseInputs, subjectTvdFt: 10500, subjectTvdSource: "completion report" });
    expect(noElevation.subjectTvdssFt).toBeNull();
    expect(noElevation.tvdssMethodology).toBeNull();

    const noTvd = resolveFormationDepthContext({ ...baseInputs, referenceElevationFt: 2800, referenceElevationSource: "USGS" });
    expect(noTvd.subjectTvdssFt).toBeNull();

    const both = resolveFormationDepthContext({
      ...baseInputs, subjectTvdFt: 10500, subjectTvdSource: "completion report",
      referenceElevationFt: 2800, referenceElevationSource: "USGS",
    });
    expect(both.subjectTvdssFt).toBe(7700);
    expect(both.tvdssMethodology).toContain("TVDSS = TVD");
    expect(both.tvdssMethodology).toContain("10500");
    expect(both.tvdssMethodology).toContain("2800");
  });

  it("derives canonical formation from field-name text when supplied", () => {
    const ctx = resolveFormationDepthContext({ ...baseInputs, subjectFieldName: "WOLFCAMP (A)", permittedFormationRaw: "SPRABERRY TREND AREA" });
    expect(ctx.subjectFormation).toBeTruthy();
    expect(ctx.producingFormation).toBe(ctx.subjectFormation);
    expect(ctx.permittedFormation).toBeTruthy();
  });

  it("returns null formation fields rather than a guess when no field name is supplied", () => {
    const ctx = resolveFormationDepthContext(baseInputs);
    expect(ctx.subjectFormation).toBeNull();
    expect(ctx.permittedFormation).toBeNull();
  });
});
