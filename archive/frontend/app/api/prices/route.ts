/**
 * GET /api/prices
 *
 * Public endpoint — no auth required.
 * Returns current WTI crude and Henry Hub natural gas prices with
 * week-over-week change, sourced from EIA API v2.
 *
 * Cached for 30 minutes at the CDN edge so the landing page stays fast
 * without hammering EIA on every visitor.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export type PriceData = {
  wti_usd:        number;
  wti_change:     number;       // week-over-week $ change
  wti_change_pct: number;       // week-over-week % change
  hh_usd:         number;       // Henry Hub $/MMBtu
  hh_change:      number;
  hh_change_pct:  number;
  period:         string;       // "YYYY-MM-DD" of the most recent data point
  source:         "eia" | "fallback";
  updated_at:     string;       // ISO timestamp of this response
};

// Hardcoded fallback — kept current; used when EIA is unreachable or key missing
const FALLBACK: PriceData = {
  wti_usd:        72.00,
  wti_change:     0.48,
  wti_change_pct: 0.67,
  hh_usd:         2.65,
  hh_change:      -0.04,
  hh_change_pct:  -1.49,
  period:         "2026-05-30",
  source:         "fallback",
  updated_at:     new Date().toISOString(),
};

export async function GET(): Promise<NextResponse<PriceData>> {
  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { ...FALLBACK, updated_at: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
      }
    );
  }

  try {
    // Fetch last 2 weekly data points so we can compute week-over-week change
    const [wtiRes, hhRes] = await Promise.all([
      fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${apiKey}` +
          `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=2`,
        { signal: AbortSignal.timeout(6_000) }
      ),
      fetch(
        `https://api.eia.gov/v2/natural-gas/pri/fut/data/?api_key=${apiKey}` +
          `&frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=2`,
        { signal: AbortSignal.timeout(6_000) }
      ),
    ]);

    const wtiJson = await wtiRes.json();
    const hhJson  = await hhRes.json();

    const wtiRows: { value: string; period: string }[] =
      wtiJson?.response?.data ?? [];
    const hhRows: { value: string; period: string }[] =
      hhJson?.response?.data ?? [];

    if (wtiRows.length === 0 || hhRows.length === 0) {
      throw new Error("empty EIA response");
    }

    const wtiCurrent  = parseFloat(wtiRows[0].value);
    const wtiPrevious = wtiRows.length > 1 ? parseFloat(wtiRows[1].value) : wtiCurrent;
    const wtiChange   = Math.round((wtiCurrent - wtiPrevious) * 100) / 100;
    const wtiChangePct =
      wtiPrevious > 0
        ? Math.round(((wtiCurrent - wtiPrevious) / wtiPrevious) * 10000) / 100
        : 0;

    const hhCurrent  = parseFloat(hhRows[0].value);
    const hhPrevious = hhRows.length > 1 ? parseFloat(hhRows[1].value) : hhCurrent;
    const hhChange   = Math.round((hhCurrent - hhPrevious) * 100) / 100;
    const hhChangePct =
      hhPrevious > 0
        ? Math.round(((hhCurrent - hhPrevious) / hhPrevious) * 10000) / 100
        : 0;

    const data: PriceData = {
      wti_usd:        Math.round(wtiCurrent * 100) / 100,
      wti_change:     wtiChange,
      wti_change_pct: wtiChangePct,
      hh_usd:         Math.round(hhCurrent * 100) / 100,
      hh_change:      hhChange,
      hh_change_pct:  hhChangePct,
      period:         wtiRows[0].period,
      source:         "eia",
      updated_at:     new Date().toISOString(),
    };

    return NextResponse.json(data, {
      headers: {
        // Cache 30 min at CDN; serve stale for 1 hr while revalidating
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch {
    return NextResponse.json(
      { ...FALLBACK, updated_at: new Date().toISOString() },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    );
  }
}
