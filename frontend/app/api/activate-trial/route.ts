import { NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseFromRouteRequest(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const now = new Date().toISOString();

    // Upsert the profile row — creates it if missing, updates if already there
    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert(
        {
          id: user.id,
          trial_started_at: now,
          subscription_status: "trialing",
          updated_at: now,
        },
        { onConflict: "id", ignoreDuplicates: false }
      );

    if (upsertError) {
      console.error("[activate-trial] upsert failed:", upsertError.message);
      return NextResponse.json(
        { ok: false, error: "Failed to activate trial. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, trial_started_at: now });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
