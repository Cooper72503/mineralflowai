/**
 * Records EIA's published spot prices so a report can still be priced when
 * the live EIA call fails at report time (migration 040). Same routes and
 * series as frontend/lib/trrc/eia-pricing.ts; a failed pull writes nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithRetry } from "./tools/ewa.js";

const SERIES = [
  { route: "petroleum/pri/spt", series: "RWTC" },
  { route: "natural-gas/pri/fut", series: "RNGWHHD" },
] as const;

type Point = { period: string; value: number };

export async function fetchEiaSeries(route: string, series: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<Point[]> {
  const url = `https://api.eia.gov/v2/${route}/data/?api_key=${encodeURIComponent(apiKey)}&frequency=monthly&data[0]=value&facets[series][]=${series}&sort[0][column]=period&sort[0][direction]=desc&length=12`;
  const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(20_000) }, { label: `EIA ${series}`, fetchImpl });
  if (!res.ok) throw new Error(`EIA ${series} returned HTTP ${res.status}`);
  const json = await res.json() as { response?: { data?: Array<{ period?: string; value?: number | string }> } };
  return (json.response?.data ?? []).map(r => ({ period: String(r.period ?? ""), value: Number(r.value) })).filter(r => r.period && Number.isFinite(r.value) && r.value > 0);
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Returns the period recorded, or null when EIA is unavailable or no key is configured. */
export async function recordEiaSnapshot(supabase: SupabaseClient, apiKey = process.env.EIA_API_KEY, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const [wti, hh] = await Promise.all(SERIES.map(s => fetchEiaSeries(s.route, s.series, apiKey, fetchImpl)));
    if (!wti.length || !hh.length) return null;
    const { error } = await supabase.from("eia_price_snapshots").insert({
      period: wti[0].period, wti_spot_usd_bbl: wti[0].value, henry_hub_usd_mmbtu: hh[0].value,
      wti_trailing_12_usd_bbl: avg(wti.map(p => p.value)), henry_hub_trailing_12_usd_mmbtu: avg(hh.map(p => p.value)),
      series: SERIES.map(s => ({ ...s, periods: s.series === "RWTC" ? wti.map(p => p.period) : hh.map(p => p.period) })),
    });
    if (error) { console.error("[eia] snapshot insert failed:", error.message); return null; }
    return wti[0].period;
  } catch (e) {
    console.error("[eia] snapshot pull failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
