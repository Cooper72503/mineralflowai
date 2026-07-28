/**
 * Tests for maps-builder.ts. buildStaticMapUrl is pure and tested directly;
 * fetchStaticMapImage's graceful-degradation behavior (never throws, never
 * breaks report generation) is tested against a mocked fetch. The URL
 * mechanism itself — TRRC's ArcGIS MapServer /export operation — was
 * verified live against the real service on 2026-07-27 (confirmed real
 * PNG bytes back for the exact well used throughout tonight's session),
 * and the full image was visually confirmed rendering correctly inside
 * the actual PDF report with the subject-well marker in the right place.
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildStaticMapUrl, fetchStaticMapImage } from "../maps-builder";

function parseBbox(url: string): [number, number, number, number] {
  const match = url.match(/bbox=([^&]+)/);
  if (!match) throw new Error("no bbox param in URL");
  const [xmin, ymin, xmax, ymax] = match[1].split(",").map(Number);
  return [xmin, ymin, xmax, ymax];
}

describe("buildStaticMapUrl", () => {
  it("builds a bbox centered on the given coordinates", () => {
    const lat = 31.66866, lng = -101.94868, delta = 0.01;
    const url = buildStaticMapUrl(lat, lng, { deltaDeg: delta });
    const [xmin, ymin, xmax, ymax] = parseBbox(url);

    expect(xmin).toBeCloseTo(lng - delta, 5);
    expect(xmax).toBeCloseTo(lng + delta, 5);
    expect(ymin).toBeCloseTo(lat - delta, 5);
    expect(ymax).toBeCloseTo(lat + delta, 5);
    expect(url).toContain("bboxSR=4326");
    expect(url).toContain("f=image");
  });

  it("defaults to a tight, readable zoom and standard size", () => {
    const lat = 31.66866, lng = -101.94868;
    const url = buildStaticMapUrl(lat, lng);
    const [xmin, , xmax] = parseBbox(url);

    expect(url).toContain("size=600,450");
    expect(xmax - xmin).toBeCloseTo(0.03, 5); // default deltaDeg 0.015 each side
  });
});

describe("fetchStaticMapImage — graceful degradation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the image bytes on a real image response", async () => {
    const fakeBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const arrayBuffer = fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength);
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => arrayBuffer,
    })) as unknown as typeof fetch;

    const result = await fetchStaticMapImage(31.66866, -101.94868);
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("returns null (not a throw) when ArcGIS returns a non-image error body", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;

    expect(await fetchStaticMapImage(31.66866, -101.94868)).toBeNull();
  });

  it("returns null (not a throw) on a non-2xx response", async () => {
    globalThis.fetch = (async () => ({ ok: false, headers: { get: () => null } })) as unknown as typeof fetch;
    expect(await fetchStaticMapImage(31.66866, -101.94868)).toBeNull();
  });

  it("returns null (not a throw) when the request itself fails", async () => {
    globalThis.fetch = (async () => { throw new Error("network error"); }) as unknown as typeof fetch;
    expect(await fetchStaticMapImage(31.66866, -101.94868)).toBeNull();
  });
});
