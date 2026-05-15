/**
 * GET /api/wells/production?api=42151XXXXX[,42151YYYYY,...]
 *
 * Fetches actual monthly oil production from the Texas Railroad Commission PDQ
 * for one or more API numbers. Tries each in order and returns the first
 * successful result.
 *
 * Response: TrrcProductionResult (from lib/wells/trrc-production.ts)
 *   or 404 if no production data is available.
 */

import { NextResponse } from "next/server";
import { fetchBestTrrcProduction } from "@/lib/wells/trrc-production";

export const dynamic = "force-dynamic";
// Allow up to 20s for TRRC to respond (two-step HTTP scrape)
export const maxDuration = 20;

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

  const result = await fetchBestTrrcProduction(apiNumbers, 36);

  if (!result) {
    return NextResponse.json(
      { error: "No TRRC production data available for the provided API numbers" },
      { status: 404 },
    );
  }

  return NextResponse.json(result);
}
