import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { lookupWellsByLocation } from "@/lib/wells";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const county   = searchParams.get("county");
  const state    = searchParams.get("state");
  const township = searchParams.get("township");
  const range    = searchParams.get("range");

  const result = await lookupWellsByLocation({ county, state, township, range });

  return NextResponse.json(
    { ok: true, ...result },
    {
      headers: {
        // Cache for 1 hour — well data doesn't change minute-to-minute
        "Cache-Control": "private, max-age=3600, stale-while-revalidate=600",
      },
    }
  );
}
