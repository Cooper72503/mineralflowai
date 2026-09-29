import { describe, it, expect } from "vitest";
import { lateralFromSurface, pathShares, pointInRings } from "../gis-lateral.js";

type Pt = [number, number];
const square = (x0: number, y0: number, x1: number, y1: number): Pt[][] => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];

describe("lateral geometry", () => {
  it("measures the share of a lateral inside each section, and a boundary touch as none", () => {
    // Three stacked 1x1 sections; the lateral runs from y=0.5 to y=2.8 down the middle.
    const path: Pt[] = [[0.5, 0.5], [0.5, 2.8]];
    const sections = [square(0, 0, 1, 1), square(0, 1, 1, 2), square(0, 2, 1, 3), square(1, 0, 2, 3)];
    const shares = pathShares(path, sections);
    expect(shares[0]).toBeCloseTo(0.5 / 2.3, 2);
    expect(shares[1]).toBeCloseTo(1 / 2.3, 2);
    expect(shares[2]).toBeCloseTo(0.8 / 2.3, 2);
    expect(shares[3]).toBe(0);
  });
  it("finds the one line that starts at the surface location, oriented from it", () => {
    const surface: Pt = [10, 10];
    expect(lateralFromSurface(surface, [[[11, 11], [10.000001, 10]], [[20, 20], [21, 21]]])).toEqual([[10.000001, 10], [11, 11]]);
    expect(lateralFromSurface(surface, [[[10, 10], [11, 11]], [[10, 10.000001], [9, 9]]])).toBeNull();
    expect(lateralFromSurface(surface, [[[12, 12], [13, 13]]])).toBeNull();
  });
  it("tests points against polygon rings", () => {
    expect(pointInRings([0.5, 0.5], square(0, 0, 1, 1))).toBe(true);
    expect(pointInRings([1.5, 0.5], square(0, 0, 1, 1))).toBe(false);
  });
});
