import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";

const otlsFixturePath = path.join(process.cwd(), "lib/trrc/offset-analytics/__tests__/fixtures/otls-abstract-309693.json");
const otlsFixture = fs.readFileSync(otlsFixturePath, "utf8");

const flatPriceDeck = {
  source: "static_fallback" as const, asOf: "test", wtiSpotUsdBbl: 70, henryHubUsdMcf: 3,
  scenarios: {
    stress: { oilUsdBbl: 52.5, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 70, gasUsdMcf: 3 },
    strip: { oilUsdBbl: 70, gasUsdMcf: 3 }, upside: { oilUsdBbl: 87.5, gasUsdMcf: 3.75 },
  },
};

vi.mock("@/lib/trrc/eia-pricing", () => ({
  getPriceDeck: vi.fn(async () => flatPriceDeck),
}));

// Same fixture-driven mock-fetch approach proven in
// offset-analytics/__tests__/service.test.ts — reused rather than
// reinvented so this route test and the engine's own integration test stay
// consistent with each other.
function wellSearchResponse(apis: string[]) {
  return JSON.stringify({
    features: apis.map((api, i) => ({
      attributes: { API: api, GIS_WELL_NUMBER: "1", GIS_SYMBOL_DESCRIPTION: "Oil Well" },
      geometry: { x: -97.34 + i * 0.01, y: 31.42 + i * 0.01 },
    })),
  });
}
function wellboreHtml(api: string, leaseNo: string, dist: string, fieldName: string) {
  const shortApi = api.replace(/\D/g, "").slice(-8);
  return `<html><body>
<a href="leaseDetailAction.do?distCode=${dist}&leaseNo=${leaseNo}&apiNo=${api}">detail</a>
<table><tr><th>API No.</th><th>District</th><th>Lease No.</th><th>Lease Name</th><th>Well No.</th><th>Field Name</th></tr>
<tr><td>${shortApi}</td><td>${dist}</td><td>${leaseNo}</td><td>UNIT 1</td><td>1</td><td>${fieldName}</td></tr></table>
</body></html>`;
}
function generateCurve(qi: number, di: number, b: number, months: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < months; t++) out.push(b === 0 ? qi * Math.exp(-di * t) : qi * Math.pow(1 + b * di * t, -1 / b));
  return out;
}
function productionHtml(series: number[]) {
  const rows = series.map((v, i) => {
    const year = 2020 + Math.floor(i / 12), month = (i % 12) + 1;
    const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1];
    return `<tr><td>${monthName} ${year}</td><td>${Math.round(v)}</td><td>${Math.round(v)}</td><td>0</td><td>0</td></tr>`;
  }).join("");
  return `<html><body><table class="DataGrid">
<tr><td colspan="9">${series.length} results</td></tr>
<tr><th rowspan="2">Date</th><th colspan="2">OIL (BBL)</th><th colspan="2">Casinghead (MCF)</th></tr>
<tr><th>Production</th><th>Disposition</th><th>Production</th><th>Disposition</th></tr>
${rows}
</table></body></html>`;
}
let wellboreCallCount = 0;
function setupMockFetch(apis: string[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, options?: { method?: string }) => {
    const u = String(url);
    if (u.includes("Original_Texas_Land_Survey")) return { ok: true, json: async () => JSON.parse(otlsFixture) } as unknown as Response;
    if (u.includes("MapServer/1/query")) return { ok: true, json: async () => JSON.parse(wellSearchResponse(apis)) } as unknown as Response;
    if (u.includes("wellboreQueryAction.do")) {
      if (options?.method !== "POST") return { ok: true, headers: { get: () => null }, text: async () => "<html></html>" } as unknown as Response;
      const idx = wellboreCallCount++ % apis.length;
      return { ok: true, headers: { get: () => null }, text: async () => wellboreHtml(apis[idx], `${1000 + idx}`, "08", idx === 0 ? "SPRABERRY (TREND AREA)" : "SOME OTHER FIELD") } as unknown as Response;
    }
    if (u.includes("specificLeaseQueryAction.do")) {
      if (options?.method !== "POST") return { ok: true, headers: { get: () => null }, text: async () => "<html></html>" } as unknown as Response;
      return { ok: true, headers: { get: () => null }, text: async () => productionHtml(generateCurve(2000, 0.05, 0.9, 36)) } as unknown as Response;
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function makeRequest(body: unknown, authenticated: boolean) {
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/trrc/offset-analytics", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer test-token" } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/trrc/offset-analytics", () => {
  afterEach(() => { vi.resetModules(); wellboreCallCount = 0; });

  it("rejects an unauthenticated request with 401", async () => {
    vi.doMock("@/lib/supabase/from-route-request", () => ({
      createSupabaseFromRouteRequest: vi.fn(async () => ({
        auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: { message: "no session" } })) },
      })),
    }));
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ legalDescriptionText: "anything" }, false));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects an empty legal description with 400", async () => {
    vi.doMock("@/lib/supabase/from-route-request", () => ({
      createSupabaseFromRouteRequest: vi.fn(async () => ({
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) },
      })),
    }));
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ legalDescriptionText: "   " }, true));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/legal description/i);
  });

  it("rejects an out-of-range ownership fraction with 400", async () => {
    vi.doMock("@/lib/supabase/from-route-request", () => ({
      createSupabaseFromRouteRequest: vi.fn(async () => ({
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) },
      })),
    }));
    const { POST } = await import("../route");
    const res = await POST(makeRequest({
      legalDescriptionText: "John Smith Survey, Abstract 693, McLennan County, Texas",
      ownershipType: "ROYALTY_INTEREST",
      mineralFraction: 1.5,
    }, true));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("runs the real engine end-to-end for a well-formed request and returns a valid payload", async () => {
    vi.doMock("@/lib/supabase/from-route-request", () => ({
      createSupabaseFromRouteRequest: vi.fn(async () => ({
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null })) },
      })),
    }));
    const restore = setupMockFetch(["42111111111", "42222222222", "42333333333"]);
    try {
      const { POST } = await import("../route");
      const res = await POST(makeRequest({
        legalDescriptionText: "John Smith Survey, Abstract 693, McLennan County, Texas",
        grossAcres: 320, netMineralAcres: 40,
        ownershipType: "ROYALTY_INTEREST", mineralFraction: 0.125, leaseRoyaltyFraction: 0.1875,
        subjectFieldName: "SPRABERRY (TREND AREA)",
      }, true));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.data.schemaVersion).toBe("1.0.0");
      expect(json.data.geocode.matchMethod).not.toBe("UNMAPPABLE");
      expect(json.data.analogWells.length).toBeGreaterThan(0);
      expect(json.data.economics).not.toBeNull();
      expect(json.data.economics.valuationType).toBe("ROYALTY_OWNER_PROXY_PV10");
      expect(json.data.validationStatus).not.toBe("INVALID");
    } finally {
      restore();
    }
  });
});
