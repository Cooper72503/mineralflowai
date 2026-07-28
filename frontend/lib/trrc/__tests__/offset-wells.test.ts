/**
 * Tests for fetchOffsetWells. The radius-query mechanism itself was
 * confirmed live against TRRC's ArcGIS server (2026-07-27): a 1-mile
 * search around the real subject well used throughout tonight's session
 * returned 62 real offset wells with API numbers, well status, and
 * coordinates. distance_miles and bearing here are cross-checked against
 * an independent Python haversine/bearing calculation using the exact
 * real coordinates from that live query, not just internally consistent
 * with themselves.
 */

import { describe, it, expect, afterEach } from "vitest";
import { fetchOffsetWells } from "../offset-wells";

const SUBJECT_LAT = 31.66866209417172;
const SUBJECT_LNG = -101.94867675311859;

// Real captured response shape from the live 1-mile radius query around
// the subject well, trimmed to a few real features for the test.
function mockGisResponse(): string {
  return JSON.stringify({
    features: [
      // The subject well itself — must be excluded from offset results.
      { attributes: { API: "32946771", GIS_WELL_NUMBER: "0371WA", GIS_SYMBOL_DESCRIPTION: "Oil Well" }, geometry: { x: SUBJECT_LNG, y: SUBJECT_LAT } },
      // Real offset well, ground truth cross-checked independently: ~0.729mi, bearing W.
      { attributes: { API: "32930429", GIS_WELL_NUMBER: "1", GIS_SYMBOL_DESCRIPTION: "Plugged Oil Well" }, geometry: { x: -101.96099271274183, y: 31.667402820917623 } },
      { attributes: { API: "32941346", GIS_WELL_NUMBER: "3818AH", GIS_SYMBOL_DESCRIPTION: "Oil Well" }, geometry: { x: -101.9600648724909, y: 31.665998250159795 } },
    ],
  });
}

describe("fetchOffsetWells", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("excludes the subject well itself from the offset list", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => JSON.parse(mockGisResponse()),
    })) as unknown as typeof fetch;

    const wells = await fetchOffsetWells(SUBJECT_LAT, SUBJECT_LNG, "4232946771");
    expect(wells.find(w => w.api === "32946771")).toBeUndefined();
    expect(wells).toHaveLength(2);
  });

  it("computes distance and bearing matching an independent calculation", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => JSON.parse(mockGisResponse()),
    })) as unknown as typeof fetch;

    const wells = await fetchOffsetWells(SUBJECT_LAT, SUBJECT_LNG, "4232946771");
    const well = wells.find(w => w.api === "32930429")!;
    expect(well.distance_miles).toBeCloseTo(0.7294633, 4);
    expect(well.bearing).toBe("W");
  });

  it("sorts results by distance, nearest first", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => JSON.parse(mockGisResponse()),
    })) as unknown as typeof fetch;

    const wells = await fetchOffsetWells(SUBJECT_LAT, SUBJECT_LNG, "4232946771");
    expect(wells[0].distance_miles).toBeLessThanOrEqual(wells[1].distance_miles);
  });

  it("returns an empty array (not a throw) on a failed request", async () => {
    globalThis.fetch = (async () => { throw new Error("network error"); }) as unknown as typeof fetch;
    expect(await fetchOffsetWells(SUBJECT_LAT, SUBJECT_LNG, "4232946771")).toEqual([]);
  });

  it("returns an empty array (not a throw) on a non-2xx response", async () => {
    globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await fetchOffsetWells(SUBJECT_LAT, SUBJECT_LNG, "4232946771")).toEqual([]);
  });
});
