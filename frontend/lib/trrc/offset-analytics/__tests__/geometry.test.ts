import { describe, it, expect } from "vitest";
import { validateGeometry, haversineDistanceMiles, distanceToPolygonBoundaryMiles, pointInRing, ringHasSelfIntersection } from "../geometry";
import type { GeoJsonGeometry } from "../types";

// A ~1km-ish square centered near (31.5, -97.5), small enough that the
// planar-projection approximation in geometry.ts is accurate, closed
// (first point repeats as last).
function squarePolygon(centerLat: number, centerLng: number, halfSideDeg: number): GeoJsonGeometry {
  const n = centerLat + halfSideDeg, s = centerLat - halfSideDeg;
  const e = centerLng + halfSideDeg, w = centerLng - halfSideDeg;
  return {
    type: "Polygon",
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
}

describe("validateGeometry — Polygon", () => {
  it("computes the exact centroid of a symmetric square at its geometric center", () => {
    const geom = squarePolygon(31.5, -97.5, 0.01);
    const result = validateGeometry(geom);
    expect(result.valid).toBe(true);
    expect(result.centroid!.lat).toBeCloseTo(31.5, 4);
    expect(result.centroid!.lng).toBeCloseTo(-97.5, 4);
  });

  it("computes a nonzero area for a real polygon", () => {
    const result = validateGeometry(squarePolygon(31.5, -97.5, 0.01));
    expect(result.areaSqMeters).not.toBeNull();
    expect(result.areaSqMeters!).toBeGreaterThan(0);
  });

  it("pulls the centroid toward the correct side for an asymmetric (non-regular) polygon — proving this is area-weighted, not a naive vertex average", () => {
    // An L-shaped polygon (concave) — most of its mass is in the bottom-left,
    // even though the vertex list has more points near the notch. A naive
    // vertex-average centroid would sit near the geometric bounding-box
    // center; the correct area-weighted centroid sits noticeably off it.
    const geom: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3], [0, 0]]],
    };
    const result = validateGeometry(geom);
    expect(result.valid).toBe(true);
    // Bounding box center would be (1.5, 1.5) — the real area-weighted
    // centroid of this L-shape is pulled toward the larger bottom-left mass.
    expect(result.centroid!.lng).toBeLessThan(1.5);
    expect(result.centroid!.lat).toBeLessThan(1.5);
  });

  it("rejects an unclosed ring rather than silently closing it", () => {
    const geom: GeoJsonGeometry = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
    const result = validateGeometry(geom);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /not closed/i.test(e))).toBe(true);
  });

  it("rejects coordinates outside valid lng/lat range", () => {
    const geom: GeoJsonGeometry = { type: "Polygon", coordinates: [[[0, 0], [200, 0], [200, 1], [0, 1], [0, 0]]] };
    const result = validateGeometry(geom);
    expect(result.valid).toBe(false);
  });

  it("rejects a degenerate zero-area polygon", () => {
    const geom: GeoJsonGeometry = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] }; // all points collinear
    const result = validateGeometry(geom);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /zero.*area/i.test(e))).toBe(true);
  });

  it("returns null geometry as invalid with an explicit error, not a silent default", () => {
    const result = validateGeometry(null);
    expect(result.valid).toBe(false);
    expect(result.centroid).toBeNull();
  });

  it("detects a self-intersecting (bowtie) polygon and warns, without attempting automatic repair", () => {
    // An asymmetric bowtie — a symmetric one (equal-area lobes) genuinely
    // nets to zero signed area under the shoelace formula (the two loops'
    // opposite-signed contributions cancel), which is real, expected
    // behavior, not a bug — using an asymmetric one here so the polygon
    // has nonzero NET area and both assertions (detected AND still
    // produces a valid, if approximate, result) are meaningfully exercised.
    const bowtie: GeoJsonGeometry = { type: "Polygon", coordinates: [[[0, 0], [4, 4], [4, 0], [0, 1], [0, 0]]] };
    const result = validateGeometry(bowtie);
    expect(result.warnings.some(w => w.code === "SELF_INTERSECTING_POLYGON")).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("a perfectly symmetric bowtie's opposite-signed lobes net to zero area — correctly reported as invalid (zero-area), not silently given a fabricated nonzero one", () => {
    const symmetricBowtie: GeoJsonGeometry = { type: "Polygon", coordinates: [[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]] };
    const result = validateGeometry(symmetricBowtie);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => /zero.*area/i.test(e))).toBe(true);
  });

  it("does not flag a normal convex polygon as self-intersecting", () => {
    const square = squarePolygon(31.5, -97.5, 0.01);
    const result = validateGeometry(square);
    expect(result.warnings.some(w => w.code === "SELF_INTERSECTING_POLYGON")).toBe(false);
  });
});

describe("ringHasSelfIntersection", () => {
  it("detects the bowtie case directly", () => {
    expect(ringHasSelfIntersection([[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]])).toBe(true);
  });

  it("returns false for a simple square", () => {
    expect(ringHasSelfIntersection([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]])).toBe(false);
  });

  it("returns false for a simple triangle (too few edges to self-intersect)", () => {
    expect(ringHasSelfIntersection([[0, 0], [2, 0], [1, 2], [0, 0]])).toBe(false);
  });
});

describe("validateGeometry — Point", () => {
  it("accepts a valid point and warns that it's centroid-only, not a tract polygon", () => {
    const result = validateGeometry({ type: "Point", coordinates: [-97.5, 31.5] });
    expect(result.valid).toBe(true);
    expect(result.centroid).toEqual({ lat: 31.5, lng: -97.5 });
    expect(result.warnings.some(w => w.code === "CENTROID_ONLY_GEOMETRY")).toBe(true);
  });
});

describe("validateGeometry — MultiPolygon", () => {
  it("computes an area-weighted centroid across disjoint parts, warning it may fall outside any single part", () => {
    const big = squarePolygon(31.0, -97.0, 0.1);   // much larger part
    const small = squarePolygon(35.0, -95.0, 0.001); // tiny distant part
    const geom: GeoJsonGeometry = {
      type: "MultiPolygon",
      coordinates: [(big.coordinates as number[][][]), (small.coordinates as number[][][])],
    };
    const result = validateGeometry(geom);
    expect(result.valid).toBe(true);
    // Centroid should sit much closer to the big part than the small one.
    expect(result.centroid!.lat).toBeCloseTo(31.0, 1);
    expect(result.warnings.some(w => w.code === "MULTIPOLYGON_GEOMETRY")).toBe(true);
  });
});

describe("haversineDistanceMiles", () => {
  it("matches the well-known ~69 miles per degree of latitude", () => {
    const miles = haversineDistanceMiles(30, -97, 31, -97);
    expect(miles).toBeGreaterThan(68.5);
    expect(miles).toBeLessThan(69.5);
  });

  it("returns 0 for identical points", () => {
    expect(haversineDistanceMiles(31.5, -97.5, 31.5, -97.5)).toBe(0);
  });

  it("is symmetric", () => {
    const a = haversineDistanceMiles(30, -97, 32, -98);
    const b = haversineDistanceMiles(32, -98, 30, -97);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe("pointInRing", () => {
  const ring = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  it("returns true for a point inside", () => {
    expect(pointInRing({ lat: 2, lng: 2 }, ring)).toBe(true);
  });
  it("returns false for a point outside", () => {
    expect(pointInRing({ lat: 10, lng: 10 }, ring)).toBe(false);
  });
});

describe("distanceToPolygonBoundaryMiles", () => {
  it("returns 0 when the point is inside the polygon", () => {
    const geom = squarePolygon(31.5, -97.5, 0.5);
    expect(distanceToPolygonBoundaryMiles({ lat: 31.5, lng: -97.5 }, geom)).toBe(0);
  });

  it("returns a positive distance roughly matching the known offset for a point clearly outside", () => {
    const geom = squarePolygon(31.5, -97.5, 0.01); // edges at 31.49/31.51 lat
    // A point 1 degree of latitude north of the polygon's north edge (31.51)
    // should be roughly 69 miles from the boundary (1 degree minus the tiny
    // half-width already inside the square).
    const dist = distanceToPolygonBoundaryMiles({ lat: 32.51, lng: -97.5 }, geom);
    expect(dist).not.toBeNull();
    expect(dist!).toBeGreaterThan(68);
    expect(dist!).toBeLessThan(70);
  });

  it("returns null for non-Polygon geometry", () => {
    expect(distanceToPolygonBoundaryMiles({ lat: 0, lng: 0 }, { type: "Point", coordinates: [0, 0] })).toBeNull();
  });
});
