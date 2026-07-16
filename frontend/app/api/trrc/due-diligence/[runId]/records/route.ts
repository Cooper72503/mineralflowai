/**
 * GET /api/trrc/due-diligence/[runId]/records
 *
 * Returns paginated public records retrieved for a run.
 *
 * Query params:
 *   category  — filter by TrrcRecordCategory (optional)
 *   page      — 1-indexed page number (default: 1)
 *   limit     — records per page, max 200 (default: 50)
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  // 1. Auth
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ ok: false, error: "runId is required." }, { status: 400 });
  }

  // 2. Parse query params
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category") ?? null;
  const pageRaw = parseInt(searchParams.get("page") ?? "1", 10);
  const limitRaw = parseInt(searchParams.get("limit") ?? "50", 10);

  const page = isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
  const limit = isNaN(limitRaw) || limitRaw < 1 ? 50 : Math.min(limitRaw, 200);
  const offset = (page - 1) * limit;

  // 3. Verify ownership
  const { data: run, error: runError } = await supabase
    .from("trrc_due_diligence_runs")
    .select("id, user_id")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (runError || !run) {
    return NextResponse.json(
      { ok: false, error: "Run not found or access denied." },
      { status: 404 },
    );
  }

  // 4. Query records with optional category filter
  let query = supabase
    .from("trrc_public_records")
    .select("*", { count: "exact" })
    .eq("run_id", runId)
    .order("filing_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (category) {
    query = query.eq("category", category);
  }

  const { data: records, error: recordsError, count } = await query;

  if (recordsError) {
    console.error("[records] query error:", recordsError);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch records." },
      { status: 500 },
    );
  }

  const total = count ?? 0;
  const total_pages = Math.ceil(total / limit);

  return NextResponse.json({
    ok: true,
    data: {
      records: records ?? [],
      pagination: {
        page,
        limit,
        total,
        total_pages,
        has_next: page < total_pages,
        has_prev: page > 1,
      },
    },
  });
}
