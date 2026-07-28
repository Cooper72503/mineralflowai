/**
 * Tests for fetchLateralPath against real captured fixtures — a real
 * horizontal well's drainhole point (API 32946771, the well used
 * throughout tonight's session) and a real confirmed-vertical well with
 * no row in the layer (API 15101734). Length is cross-checked against an
 * independent Python haversine calculation using the real coordinates.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchLateralPath } from "../lateral-path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drainholeFoundJson = fs.readFileSync(path.join(__dirname, "fixtures/gis-drainhole-found.json"), "utf8");
const drainholeEmptyJson = fs.readFileSync(path.join(__dirname, "fixtures/gis-drainhole-empty.json"), "utf8");

const SURFACE_LAT = 31.66866209417172;
const SURFACE_LNG = -101.94867675311859;

describe("fetchLateralPath", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("resolves a real horizontal well's drainhole point with correct length and bearing", async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => JSON.parse(drainholeFoundJson) })) as unknown as typeof fetch;

    const result = await fetchLateralPath("4232946771", SURFACE_LAT, SURFACE_LNG);
    expect(result).not.toBeNull();
    expect(result!.straight_line_length_ft).toBeCloseTo(11545.96, 1);
    expect(result!.drainhole_latitude).toBeCloseTo(31.69978, 4);
    expect(result!.drainhole_longitude).toBeCloseTo(-101.95545, 4);
    expect(result!.bearing).toBe("N");
  });

  it("returns null (not a fabricated path) for a real confirmed-vertical well", async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => JSON.parse(drainholeEmptyJson) })) as unknown as typeof fetch;

    const result = await fetchLateralPath("4215101734", 32.845, -100.273);
    expect(result).toBeNull();
  });

  it("returns null (not a throw) on a request failure", async () => {
    globalThis.fetch = (async () => { throw new Error("network error"); }) as unknown as typeof fetch;
    expect(await fetchLateralPath("4232946771", SURFACE_LAT, SURFACE_LNG)).toBeNull();
  });
});
