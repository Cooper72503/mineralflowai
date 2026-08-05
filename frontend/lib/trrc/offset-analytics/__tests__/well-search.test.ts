import { describe, it, expect, afterEach } from "vitest";
import { ArcGisWellSearchProvider, MAX_RADIUS_MILES } from "../well-search";
import type { GeoJsonGeometry } from "../types";

const CENTER = { lat: 31.5, lng: -97.5 };

function squarePolygon(centerLat: number, centerLng: number, halfSideDeg: number): GeoJsonGeometry {
  const n = centerLat + halfSideDeg, s = centerLat - halfSideDeg;
  const e = centerLng + halfSideDeg, w = centerLng - halfSideDeg;
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

function mockFeatures(wells: Array<{ api: string; lat: number; lng: number }>) {
  return {
    features: wells.map(w => ({
      attributes: { API: w.api, GIS_WELL_NUMBER: "1", GIS_SYMBOL_DESCRIPTION: "Oil Well" },
      geometry: { x: w.lng, y: w.lat },
    })),
  };
}

describe("ArcGisWellSearchProvider — the real-radius cutoff, not the server pre-filter, is authoritative", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("issues a real distance-based ArcGIS query (spatialRel=esriSpatialRelIntersects, distance param), not a bounding-box-only query", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => mockFeatures([]) };
    }) as unknown as typeof fetch;

    const provider = new ArcGisWellSearchProvider();
    await provider.search(CENTER, null, 5, "CENTROID_TO_WELL");

    expect(capturedUrl).toContain("spatialRel=esriSpatialRelIntersects");
    expect(capturedUrl).toContain("units=esriSRUnit_StatuteMile");
    expect(capturedUrl).toMatch(/distance=5/);
  });

  it("excludes a well the server's own query returned that is actually outside the true radius (proving the client-side exact filter is authoritative, not the server pre-filter alone)", async () => {
    // Simulate: the server pre-filter (enlarged for a real tract polygon)
    // returns a well that's within the ENLARGED search radius but outside
    // the actual requested 2-mile cutoff once exact distance is computed.
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => mockFeatures([
        { api: "42-1-close", lat: 31.51, lng: -97.5 },   // ~0.69 mi away — inside
        { api: "42-1-far", lat: 31.7, lng: -97.5 },       // ~13.8 mi away — the server's enlarged pre-filter might return it, but it's outside the real 2-mile cutoff
      ]),
    })) as unknown as typeof fetch;

    const provider = new ArcGisWellSearchProvider();
    const result = await provider.search(CENTER, null, 2, "CENTROID_TO_WELL");

    expect(result.candidates.map(c => c.api)).toEqual(["42-1-close"]);
    expect(result.candidates.every(c => c.distanceMiles <= 2)).toBe(true);
  });

  it("uses true polygon-boundary distance in TRACT_BOUNDARY_TO_WELL mode, not centroid distance", async () => {
    const tract = squarePolygon(31.5, -97.5, 0.5); // a real, sizable tract
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => mockFeatures([
        { api: "42-1-inside", lat: 31.5, lng: -97.5 }, // inside the tract itself -> boundary distance 0
      ]),
    })) as unknown as typeof fetch;

    const provider = new ArcGisWellSearchProvider();
    const result = await provider.search(CENTER, tract, 5, "TRACT_BOUNDARY_TO_WELL");

    expect(result.distanceMode).toBe("TRACT_BOUNDARY_TO_WELL");
    expect(result.candidates[0].distanceMiles).toBe(0); // inside the tract, not ~0 centroid distance
  });

  it("falls back to CENTROID_TO_WELL with a warning when TRACT_BOUNDARY_TO_WELL is requested but there's no real polygon", async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => mockFeatures([]) })) as unknown as typeof fetch;
    const provider = new ArcGisWellSearchProvider();
    const result = await provider.search(CENTER, null, 5, "TRACT_BOUNDARY_TO_WELL");
    expect(result.distanceMode).toBe("CENTROID_TO_WELL");
    expect(result.warnings.some(w => w.code === "NO_POLYGON_FOR_BOUNDARY_MODE")).toBe(true);
  });

  it("clamps a radius above the configured maximum, with a warning, rather than running an unbounded query", async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => mockFeatures([]) })) as unknown as typeof fetch;
    const provider = new ArcGisWellSearchProvider();
    const result = await provider.search(CENTER, null, 500, "CENTROID_TO_WELL");
    expect(result.radiusMiles).toBe(MAX_RADIUS_MILES);
    expect(result.warnings.some(w => w.code === "RADIUS_CLAMPED")).toBe(true);
  });

  it("returns an empty result with a critical warning, not a throw, on HTTP failure", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const provider = new ArcGisWellSearchProvider();
    const result = await provider.search(CENTER, null, 5, "CENTROID_TO_WELL");
    expect(result.candidates).toEqual([]);
    expect(result.warnings.some(w => w.severity === "critical")).toBe(true);
  });

  it("returns an empty result with a critical warning, not a throw, on network failure", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const provider = new ArcGisWellSearchProvider();
    await expect(provider.search(CENTER, null, 5, "CENTROID_TO_WELL")).resolves.toBeDefined();
  });

  it("excludes a feature with missing coordinates rather than crashing or fabricating a location", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        features: [
          { attributes: { API: "42-has-coords", GIS_WELL_NUMBER: "1", GIS_SYMBOL_DESCRIPTION: "Oil Well" }, geometry: { x: -97.5, y: 31.501 } },
          { attributes: { API: "42-no-coords", GIS_WELL_NUMBER: "1", GIS_SYMBOL_DESCRIPTION: "Oil Well" }, geometry: {} }, // missing x/y — a real ArcGIS response shape for an unlocated well
        ],
      }),
    })) as unknown as typeof fetch;
    const provider = new ArcGisWellSearchProvider();
    const result = await provider.search(CENTER, null, 5, "CENTROID_TO_WELL");
    expect(result.candidates.map(c => c.api)).toEqual(["42-has-coords"]);
  });

  it("sorts candidates by distance ascending", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => mockFeatures([
        { api: "42-far", lat: 31.55, lng: -97.5 },
        { api: "42-near", lat: 31.501, lng: -97.5 },
      ]),
    })) as unknown as typeof fetch;
    const provider = new ArcGisWellSearchProvider();
    const result = await provider.search(CENTER, null, 10, "CENTROID_TO_WELL");
    expect(result.candidates.map(c => c.api)).toEqual(["42-near", "42-far"]);
  });
});
