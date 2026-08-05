import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runOffsetAnalytics } from "../service";
import type { PriceDeck } from "../../eia-pricing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const otlsFixture = fs.readFileSync(path.join(__dirname, "fixtures/otls-abstract-309693.json"), "utf8");

const flatPriceDeck: PriceDeck = {
  source: "static_fallback", asOf: "test", wtiSpotUsdBbl: 70, henryHubUsdMcf: 3,
  scenarios: {
    stress: { oilUsdBbl: 52.5, gasUsdMcf: 2.25 }, base: { oilUsdBbl: 70, gasUsdMcf: 3 },
    strip: { oilUsdBbl: 70, gasUsdMcf: 3 }, upside: { oilUsdBbl: 87.5, gasUsdMcf: 3.75 },
  },
};

function wellSearchResponse(apis: string[]) {
  return JSON.stringify({
    features: apis.map((api, i) => ({
      attributes: { API: api, GIS_WELL_NUMBER: "1", GIS_SYMBOL_DESCRIPTION: "Oil Well" },
      geometry: { x: -97.34 + i * 0.01, y: 31.42 + i * 0.01 },
    })),
  });
}

function wellboreHtml(api: string, leaseNo: string, dist: string, fieldName: string) {
  // Real TRRC table cells show the SHORT 7-8 digit API (no "42" state
  // prefix) — e.g. "16502733", confirmed live 2026-08-04. Full API only
  // appears in the lease-detail link's query string.
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

function setupMockFetch(apis: string[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, options?: { method?: string }) => {
    const u = String(url);
    if (u.includes("Original_Texas_Land_Survey")) {
      return { ok: true, json: async () => JSON.parse(otlsFixture) } as unknown as Response;
    }
    if (u.includes("MapServer/1/query")) {
      return { ok: true, json: async () => JSON.parse(wellSearchResponse(apis)) } as unknown as Response;
    }
    if (u.includes("wellboreQueryAction.do")) {
      if (options?.method !== "POST") return { ok: true, headers: { get: () => null }, text: async () => "<html></html>" } as unknown as Response;
      // crude: pull the api out of the referer-free request by matching order — just cycle through apis deterministically via a shared counter
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
let wellboreCallCount = 0;

describe("runOffsetAnalytics — full pipeline integration", () => {
  afterEach(() => { wellboreCallCount = 0; });

  it("produces a valid payload with real analog wells, a composite curve, and a proxy PV-10 for a well-formed Texas legal description", async () => {
    const restore = setupMockFetch(["42111111111", "42222222222", "42333333333"]);
    try {
      const result = await runOffsetAnalytics({
        legalDescriptionText: "John Smith Survey, Abstract 693, McLennan County, Texas",
        grossAcres: 320, netMineralAcres: 40,
        ownershipType: "ROYALTY_INTEREST", mineralFraction: 0.125, leaseRoyaltyFraction: 0.1875,
        subjectFieldName: "SPRABERRY (TREND AREA)",
        priceDeck: flatPriceDeck,
      });

      expect(result.schemaVersion).toBe("1.0.0");
      expect(result.geocode.matchMethod).not.toBe("UNMAPPABLE");
      expect(result.search.candidatesFound).toBe(3);
      expect(result.analogWells.length).toBeGreaterThan(0);
      expect(result.economics).not.toBeNull();
      expect(result.economics!.valuationType).toBe("ROYALTY_OWNER_PROXY_PV10");
      expect(result.validationStatus).not.toBe("INVALID");
    } finally {
      restore();
    }
  });

  it("NEVER produces a real owner PV-10 valuationType when ownership inputs are NMA-only — the core end-to-end guard", async () => {
    const restore = setupMockFetch(["42111111111", "42222222222"]);
    try {
      const result = await runOffsetAnalytics({
        legalDescriptionText: "John Smith Survey, Abstract 693, McLennan County, Texas",
        grossAcres: 320, netMineralAcres: 40,
        ownershipType: "ROYALTY_INTEREST", // NMA present, but no mineralFraction/leaseRoyaltyFraction supplied
        subjectFieldName: "SPRABERRY (TREND AREA)",
        priceDeck: flatPriceDeck,
      });
      expect(result.economics?.valuationType).not.toBe("ROYALTY_OWNER_PROXY_PV10");
      expect(result.economics?.valuationType).not.toBe("WORKING_INTEREST_OWNER_PROXY_PV10");
      if (result.economics) expect(result.economics.valuationType).toBe("GROSS_TRACT_PROXY_PV10");
    } finally {
      restore();
    }
  });

  it("returns validationStatus:INVALID and no analogs, not a crash, for an unmappable legal description", async () => {
    const result = await runOffsetAnalytics({
      legalDescriptionText: "completely vague text with no real identifiers at all",
      priceDeck: flatPriceDeck,
    });
    expect(result.validationStatus).toBe("INVALID");
    expect(result.analogWells).toEqual([]);
    expect(result.geocode.matchMethod).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("returns an analysisId unique per run", async () => {
    const a = await runOffsetAnalytics({ legalDescriptionText: "vague", priceDeck: flatPriceDeck });
    const b = await runOffsetAnalytics({ legalDescriptionText: "vague", priceDeck: flatPriceDeck });
    expect(a.analysisId).not.toBe(b.analysisId);
  });

  it("never emits the same warning code more than once — found live in Section 9 of a real generated PDF (ownership fallback warnings rendered twice; traced to proxy-valuation.ts double-including ownership.warnings)", async () => {
    const restore = setupMockFetch(["42111111111", "42222222222", "42333333333"]);
    try {
      const result = await runOffsetAnalytics({
        legalDescriptionText: "John Smith Survey, Abstract 693, McLennan County, Texas",
        grossAcres: 320,
        ownershipType: "UNKNOWN", // triggers the gross-tract-proxy ownership fallback path that exposed the duplicate
        subjectFieldName: "SPRABERRY (TREND AREA)",
        priceDeck: flatPriceDeck,
      });
      const codeCounts = new Map<string, number>();
      for (const w of result.warnings) codeCounts.set(w.code, (codeCounts.get(w.code) ?? 0) + 1);
      const duplicated = Array.from(codeCounts.entries()).filter(([, count]) => count > 1);
      expect(duplicated).toEqual([]);
    } finally {
      restore();
    }
  });

  it("carries provenance entries for every real pipeline step, not an empty array", async () => {
    const result = await runOffsetAnalytics({ legalDescriptionText: "vague text", priceDeck: flatPriceDeck });
    expect(result.provenance.length).toBeGreaterThan(0);
    expect(result.provenance.some(p => p.step === "parse_legal_description")).toBe(true);
    expect(result.provenance.some(p => p.step === "geocode")).toBe(true);
  });
});

describe("runOffsetAnalytics — PLSS end-to-end (non-Texas subject, BLM cadastral geocode through the full pipeline)", () => {
  afterEach(() => { wellboreCallCount = 0; });

  // The BLM centroid mocked below (39.0, -97.5) is nowhere near the TX
  // well-search fixture's hardcoded McLennan-county coordinates — the
  // client-side exact-radius filter in well-search.ts is authoritative, so
  // reusing wellSearchResponse()'s fixed offsets would have every candidate
  // silently dropped as out-of-radius. Wells here are generated close to
  // the actual BLM centroid instead.
  function plssWellSearchResponse(apis: string[]) {
    return JSON.stringify({
      features: apis.map((api, i) => ({
        attributes: { API: api, GIS_WELL_NUMBER: "1", GIS_SYMBOL_DESCRIPTION: "Oil Well" },
        geometry: { x: -97.5 + i * 0.01, y: 39.0 + i * 0.01 },
      })),
    });
  }

  function setupPlssMockFetch(apis: string[]) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, options?: { method?: string }) => {
      const u = String(url);
      if (u.includes("gis.blm.gov")) {
        return { ok: true, json: async () => ({ features: [{ centroid: { x: -97.5, y: 39.0 } }] }) } as unknown as Response;
      }
      if (u.includes("gis.rrc.texas.gov") && u.includes("MapServer/1/query")) {
        return { ok: true, json: async () => JSON.parse(plssWellSearchResponse(apis)) } as unknown as Response;
      }
      if (u.includes("wellboreQueryAction.do")) {
        if (options?.method !== "POST") return { ok: true, headers: { get: () => null }, text: async () => "<html></html>" } as unknown as Response;
        const idx = wellboreCallCount++ % apis.length;
        return { ok: true, headers: { get: () => null }, text: async () => wellboreHtml(apis[idx], `${2000 + idx}`, "08", "SPRABERRY (TREND AREA)") } as unknown as Response;
      }
      if (u.includes("specificLeaseQueryAction.do")) {
        if (options?.method !== "POST") return { ok: true, headers: { get: () => null }, text: async () => "<html></html>" } as unknown as Response;
        return { ok: true, headers: { get: () => null }, text: async () => productionHtml(generateCurve(1800, 0.06, 0.85, 36)) } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  it("with subjectState supplied, resolves a PLSS description via BLM to a real centroid and produces qualified analogs — proving the PLSS path works end-to-end, not just in geocoding.test.ts isolation", async () => {
    const restore = setupPlssMockFetch(["42111111111", "42222222222", "42333333333"]);
    try {
      const result = await runOffsetAnalytics({
        legalDescriptionText: "Township 5 North, Range 10 West, Section 22, 6th Principal Meridian, NE/4",
        subjectState: "KS",
        subjectFieldName: "SPRABERRY (TREND AREA)",
        priceDeck: flatPriceDeck,
      });

      expect(result.subjectAsset.legalDescription.jurisdiction).toBe("PLSS");
      expect(result.geocode.sourceProvider).toBe("BLM_PLSS_CADNSDI");
      expect(result.geocode.matchMethod).not.toBe("UNMAPPABLE");
      expect(result.geocode.centroidLatitude).not.toBeNull();
      expect(result.search.candidatesFound).toBe(3);
      expect(result.analogWells.length).toBeGreaterThan(0);
      expect(result.validationStatus).not.toBe("INVALID");
    } finally {
      restore();
    }
  });

  it("without subjectState, a well-formed PLSS description is still UNMAPPABLE — documents the real limitation rather than hiding it", async () => {
    const restore = setupPlssMockFetch(["42111111111"]);
    try {
      const result = await runOffsetAnalytics({
        legalDescriptionText: "Township 5 North, Range 10 West, Section 22, 6th Principal Meridian, NE/4",
        priceDeck: flatPriceDeck,
      });
      expect(result.subjectAsset.legalDescription.jurisdiction).toBe("PLSS");
      expect(result.geocode.matchMethod).toBe("UNMAPPABLE");
      expect(result.validationStatus).toBe("INVALID");
    } finally {
      restore();
    }
  });

  it("a PLSS description explicitly for Texas is rejected even with subjectState supplied — Texas was never surveyed under PLSS", async () => {
    const result = await runOffsetAnalytics({
      legalDescriptionText: "Township 5 North, Range 10 West, Section 22, 6th Principal Meridian, NE/4",
      subjectState: "TX",
      priceDeck: flatPriceDeck,
    });
    expect(result.geocode.matchMethod).toBe("UNMAPPABLE");
    expect(result.geocode.warnings.some(w => w.code === "TEXAS_NOT_PLSS")).toBe(true);
  });
});
