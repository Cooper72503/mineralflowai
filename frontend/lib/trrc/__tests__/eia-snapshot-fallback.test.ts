import { describe, it, expect, beforeEach } from "vitest";
import { getPriceDeck } from "../eia-pricing";

const snapshot = (retrievedAt: string) => ({
  from: () => { const q: Record<string, unknown> = { select: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: { period: "2026-08", wti_spot_usd_bbl: 83.9, henry_hub_usd_mmbtu: 2.78, wti_trailing_12_usd_bbl: 80, henry_hub_trailing_12_usd_mmbtu: 3, retrieved_at: retrievedAt }, error: null }) }; return q; },
});

describe("getPriceDeck without live EIA", () => {
  beforeEach(() => { delete process.env.EIA_API_KEY; });
  it("uses the latest recorded EIA deck and says so", async () => {
    const deck = await getPriceDeck(snapshot(new Date(Date.now() - 3 * 3600_000).toISOString()) as never);
    expect(deck).toMatchObject({ source: "eia_live", asOf: "2026-08", wtiSpotUsdBbl: 83.9, henryHubUsdMcf: 2.78, fromSnapshot: true });
    expect(deck.scenarios.stress.oilUsdBbl).toBeCloseTo(83.9 * 0.75, 10);
  });
  it("never uses a stale recording, and never values on the placeholder", async () => {
    const deck = await getPriceDeck(snapshot(new Date(Date.now() - 90 * 86_400_000).toISOString()) as never);
    expect(deck.source).toBe("static_fallback");
    expect((await getPriceDeck()).source).toBe("static_fallback");
  });
});
