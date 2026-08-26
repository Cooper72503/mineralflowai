/**
 * POST /api/trrc/due-diligence
 *
 * Start a new TRRC Due Diligence run.
 * Resolves entities from raw user input, inserts a run row, and returns the
 * run_id immediately. The caller then POSTs to /[runId]/execute to start the
 * retrieval pipeline.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { isTrrcDdEnabled } from "@/lib/trrc/source-registry";
import { createDueDiligenceRun, type CreateRunInput } from "@/lib/trrc/create-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ─── SSRF allowlist ───────────────────────────────────────────────────────────

/** Only permit outbound fetches to TRRC domains. */
function validateTrrcUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "webapps2.rrc.texas.gov" ||
      hostname.endsWith(".rrc.texas.gov")
    );
  } catch {
    return false;
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Auth
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  // 2. Feature flag
  if (!isTrrcDdEnabled()) {
    return NextResponse.json(
      { ok: false, error: "TRRC Due Diligence is not currently available." },
      { status: 503 },
    );
  }

  // 3. Parse body
  let body: CreateRunInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // 4-7. Validate, resolve entities, insert run + resolved entities —
  // shared with the bulk/portfolio endpoint via createDueDiligenceRun so
  // the two never drift out of sync.
  const result = await createDueDiligenceRun(supabase, user.id, body);

  if (!result.ok) {
    const status = result.error.startsWith("Could not resolve") ? 422 : result.error === "Failed to create due diligence run." ? 500 : 400;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    data: {
      id: result.id,
      run_id: result.id,
      status: result.status,
      needs_user_selection: result.needs_user_selection,
      entities: result.entities,
      normalized_input: result.normalized_input,
      input_type: result.input_type,
    },
  });
}
