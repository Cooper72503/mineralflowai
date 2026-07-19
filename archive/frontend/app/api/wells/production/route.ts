/**
 * GET /api/wells/production?api=42151XXXXX[,47006YYYYY,...]
 *
 * Fetches actual monthly production from state agency public data for one or
 * more API numbers. Routes by state prefix:
 *   42… → Texas Railroad Commission PDQ (TRRC)
 *   47… → WV DEP Office of Oil and Gas
 *
 * Tries each API number in order and returns the first successful result.
 *
 * Response: StateProductionResult (from lib/wells/production-types.ts)
 *   or 404 if no production data is available.
 */

import { NextResponse } from "next/server";
import type { StateProductionResult } from "@/lib/wells/production-types";
import { fetchBestTrrcProduction, normalizeApiNumber as normalizeTxApi } from "@/lib/wells/trrc-production";
import { fetchBestWvdepProduction, normalizeWvApiNumber } from "@/lib/wells/wvdep-production";

export const dynamic    = "force-dynamic";
// Allow up to 25s — WV DEP HTML scrape can be slow
export const maxDuration = 25;

/** Detect state from API number prefix (first 2 digits after stripping dashes). */
function detectState(api: string): "TX" | "WV" | null {
  const digits = api.replace(/[-\s]/g, "");
  if (digits.startsWith("42")) return "TX";
  if (digits.startsWith("47")) return "WV";
  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const apiParam = searchParams.get("api");

  if (!apiParam) {
    return NextResponse.json({ error: "api parameter required" }, { status: 400 });
  }

  const apiNumbers = apiParam.split(",").map(a => a.trim()).filter(Boolean);
  if (apiNumbers.length === 0) {
    return NextResponse.json({ error: "no valid API numbers provided" }, { status: 400 });
  }

  // Split by state
  const txApis: string[] = [];
  const wvApis: string[] = [];

  for (const api of apiNumbers) {
    const state = detectState(api);
    if (state === "TX") txApis.push(api);
    else if (state === "WV") wvApis.push(api);
  }

  // Try TX first (if any TX API numbers provided)
  if (txApis.length > 0) {
    const txResult = await fetchBestTrrcProduction(txApis, 36);
    if (txResult) {
      const response: StateProductionResult = {
        api_number:    txResult.api_number,
        rows:          txResult.rows,
        months_count:  txResult.months_count,
        source:        "trrc_actual",
        district_code: txResult.district_code,
        lease_number:  txResult.lease_number,
      };
      return NextResponse.json(response);
    }
  }

  // Try WV next
  if (wvApis.length > 0) {
    const wvResult = await fetchBestWvdepProduction(wvApis, 36);
    if (wvResult) {
      const response: StateProductionResult = {
        api_number:   wvResult.api_number,
        rows:         wvResult.rows,
        months_count: wvResult.months_count,
        source:       "wvdep_actual",
      };
      return NextResponse.json(response);
    }
  }

  return NextResponse.json(
    { error: "No production data available for the provided API numbers" },
    { status: 404 },
  );
}
