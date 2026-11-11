import { describe, it, expect } from "vitest";
import { api8From, formatApi, exportImageUrl, metresPerPixel, OVERLAY_LAYERS, TRRC_GIS } from "../gis";

describe("well map GIS helpers", () => {
  it("reads every API form TRRC and users write, and nothing else", () => {
    for (const input of ["42-165-02084", "4216502084", "16502084", "421650208400", "42165020840000", " 42 165 02084 "]) expect(api8From(input)).toBe("16502084");
    expect(api8From("35-165-02084")).toBeNull(); // not Texas
    expect(api8From("165-0208")).toBeNull();
    expect(formatApi("16502084")).toBe("42-165-02084");
  });

  it("asks TRRC for one transparent image of the view in Web Mercator", () => {
    const url = new URL(exportImageUrl([-11293000, 4271000, -11288000, 4276000], 1199.6, 800));
    expect(`${url.origin}${url.pathname}`).toBe(`${TRRC_GIS}/export`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ bbox: "-11293000,4271000,-11288000,4276000", bboxSR: "3857", imageSR: "3857", size: "1200,800", transparent: "true", format: "png32", f: "image", layers: `show:${OVERLAY_LAYERS.join(",")}` });
  });

  it("sizes a click's search radius from the zoom", () => {
    expect(metresPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
    expect(metresPerPixel(32, 15)).toBeCloseTo(4.05, 2); // ~40 m for a 10-pixel radius in the Permian at street zoom
  });
});
