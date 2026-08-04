import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPriceDeck } from "../eia-pricing";

// The live EIA HTTP call itself is verified live only, once a real
// EIA_API_KEY exists — consistent with this codebase's established
// convention of not unit-testing live third-party fetches (see
// county-records.test.ts's own header comment for the same rationale).
// These tests cover the static-fallback path and the pure scenario math,
// both fully deterministic without a network call.

describe("getPriceDeck — static fallback (no EIA_API_KEY)", () => {
  const originalKey = process.env.EIA_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env.EIA_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  });

  it("returns source: static_fallback and never claims to be live", async () => {
    const deck = await getPriceDeck();
    expect(deck.source).toBe("static_fallback");
    expect(deck.wtiSpotUsdBbl).toBeGreaterThan(0);
    expect(deck.henryHubUsdMcf).toBeGreaterThan(0);
  });

  it("scenario ordering is stress <= base <= upside for both commodities", async () => {
    const deck = await getPriceDeck();
    expect(deck.scenarios.stress.oilUsdBbl).toBeLessThanOrEqual(deck.scenarios.base.oilUsdBbl);
    expect(deck.scenarios.base.oilUsdBbl).toBeLessThanOrEqual(deck.scenarios.upside.oilUsdBbl);
    expect(deck.scenarios.stress.gasUsdMcf).toBeLessThanOrEqual(deck.scenarios.base.gasUsdMcf);
    expect(deck.scenarios.base.gasUsdMcf).toBeLessThanOrEqual(deck.scenarios.upside.gasUsdMcf);
  });

  it("base scenario prices match the reported spot prices exactly", async () => {
    const deck = await getPriceDeck();
    expect(deck.scenarios.base.oilUsdBbl).toBe(deck.wtiSpotUsdBbl);
    expect(deck.scenarios.base.gasUsdMcf).toBe(deck.henryHubUsdMcf);
  });
});

describe("getPriceDeck — live fetch failure falls back gracefully", () => {
  const originalKey = process.env.EIA_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.EIA_API_KEY = "test-key-not-real";
    globalThis.fetch = (async () => {
      throw new Error("simulated network failure");
    }) as typeof fetch;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  });

  it("falls back to a static deck rather than throwing when the key is set but the live call fails", async () => {
    const deck = await getPriceDeck();
    expect(deck.source).toBe("static_fallback");
  });
});

describe("getPriceDeck — live fetch success is trusted and labeled correctly", () => {
  const originalKey = process.env.EIA_API_KEY;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.EIA_API_KEY = "test-key-not-real";
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const isWti = call === 1; // Promise.all preserves call order for the two fetches issued
      const body = isWti
        ? { response: { data: [{ period: "2026-07", value: 75 }, { period: "2026-06", value: 65 }] } }
        : { response: { data: [{ period: "2026-07", value: 3.5 }, { period: "2026-06", value: 2.5 }] } };
      return { ok: true, json: async () => body } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = originalKey;
    globalThis.fetch = originalFetch;
  });

  it("uses the most recent period as spot and the average of returned points as the strip proxy", async () => {
    const deck = await getPriceDeck();
    expect(deck.source).toBe("eia_live");
    expect(deck.wtiSpotUsdBbl).toBe(75);
    expect(deck.henryHubUsdMcf).toBe(3.5);
    expect(deck.scenarios.strip.oilUsdBbl).toBeCloseTo(70, 5); // avg(75, 65)
    expect(deck.scenarios.strip.gasUsdMcf).toBeCloseTo(3, 5);  // avg(3.5, 2.5)
  });
});
