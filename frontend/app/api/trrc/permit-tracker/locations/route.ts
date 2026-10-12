/**
 * POST /api/trrc/permit-tracker/locations
 *
 * Surface-location coordinates for a batch of W-1 permits, read from each
 * permit's public detail page. The search results table doesn't carry
 * coordinates, so the tracker page calls this in small batches after a
 * search returns. Requests are made one at a time and paced, in keeping
 * with RRC's warning about automated volume (see session.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { RrcSession } from "@/lib/trrc/permit-tracker/session";
import { detailPathFor, parsePermitLocation, type PermitLocation } from "@/lib/trrc/permit-tracker/permit-location";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PER_REQUEST = 10;
const REQUEST_SPACING_MS = 250;

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const docNos: unknown = body?.docNos;
  if (
    !Array.isArray(docNos) || docNos.length === 0 || docNos.length > MAX_PER_REQUEST ||
    !docNos.every((d) => typeof d === "string" && /^\d{1,12}$/.test(d))
  ) {
    return NextResponse.json({ ok: false, error: `Provide 1–${MAX_PER_REQUEST} permit document numbers.` }, { status: 400 });
  }

  // null = the permit states no coordinates; absent = the lookup failed and can be retried.
  const locations: Record<string, PermitLocation | null> = {};
  const session = new RrcSession();
  for (const [i, docNo] of (docNos as string[]).entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    try {
      locations[docNo] = parsePermitLocation(await session.get(detailPathFor(docNo)));
    } catch (err) {
      console.warn(`[permit-tracker] location lookup failed for ${docNo}:`, err);
    }
  }

  return NextResponse.json({ ok: true, data: { locations } }, { headers: { "Cache-Control": "private, no-store" } });
}
