import { describe, it, expect, vi } from "vitest";
import { recordEiaSnapshot } from "../eia-snapshots.js";

const eia = (rows: Array<{ period: string; value: number }>) => new Response(JSON.stringify({ response: { data: rows } }), { status: 200 });
function db() {
  const inserted: Record<string, unknown>[] = [];
  return { inserted, from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) };
}

describe("recordEiaSnapshot", () => {
  it("records EIA's latest period, spot values and trailing averages", async () => {
    const d = db();
    const fetchImpl = vi.fn(async (url: string) => String(url).includes("RWTC") ? eia([{ period: "2026-08", value: 83.9 }, { period: "2026-07", value: 80.1 }]) : eia([{ period: "2026-08", value: 2.78 }, { period: "2026-07", value: 3.02 }]));
    const period = await recordEiaSnapshot(d as never, "key", fetchImpl as never);
    expect(period).toBe("2026-08");
    expect(d.inserted[0]).toMatchObject({ period: "2026-08", wti_spot_usd_bbl: 83.9, henry_hub_usd_mmbtu: 2.78 });
    expect(d.inserted[0].wti_trailing_12_usd_bbl).toBeCloseTo(82, 6);
  });
  it("writes nothing when EIA fails or no key is configured", async () => {
    const d = db();
    expect(await recordEiaSnapshot(d as never, "key", (async () => new Response("", { status: 404 })) as never)).toBeNull();
    expect(await recordEiaSnapshot(d as never, undefined)).toBeNull();
    expect(d.inserted).toHaveLength(0);
  });
});
