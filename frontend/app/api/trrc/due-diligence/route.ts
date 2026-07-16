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
import { detectInputType, normalizeApiNumber } from "@/lib/trrc/normalization";
import { resolveEntities } from "@/lib/trrc/entity-resolver";
import type { TrrcIdentifierType } from "@/lib/trrc/types";

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

  // 3. Parse and validate body
  let body: {
    input?: string;
    input_type_override?: TrrcIdentifierType;
    county?: string;
    district?: string;
    operator_name?: string;
    lease_name?: string;
    search_historical?: boolean;
    include_offset_wells?: boolean;
    production_months?: number;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const rawInput = body.input?.trim() ?? "";
  if (!rawInput) {
    return NextResponse.json({ ok: false, error: "input is required." }, { status: 400 });
  }
  if (rawInput.length > 500) {
    return NextResponse.json(
      { ok: false, error: "input must be 500 characters or fewer." },
      { status: 400 },
    );
  }

  // 4. Detect and normalize input type
  const detected_input_type = body.input_type_override ?? detectInputType(rawInput);
  const normalizedApi = normalizeApiNumber(rawInput);
  const normalized_input = normalizedApi?.api10 ?? rawInput;

  // 5. Resolve entities
  const resolution = await resolveEntities(
    rawInput,
    body.input_type_override ?? null,
    body.county ?? null,
    body.district ?? null,
    body.operator_name ?? null,
    body.lease_name ?? null,
  );

  if (resolution.error && resolution.entities.length === 0) {
    return NextResponse.json(
      { ok: false, error: `Could not resolve input: ${resolution.error}` },
      { status: 422 },
    );
  }

  const needs_user_selection = resolution.needs_user_selection;
  // Always start as pending — the Edge Function / agent handles entity resolution
  const status = "pending";

  // 6. Insert run row
  const { data: runRow, error: runInsertError } = await supabase
    .from("trrc_due_diligence_runs")
    .insert({
      user_id: user.id,
      original_input: rawInput,
      detected_input_type,
      selected_input_type: resolution.input_type,
      normalized_input: resolution.normalized_input ?? normalized_input,
      status,
      started_at: new Date().toISOString(),
      progress_percent: 0,
      result_summary: null,
      error_summary: null,
      resolved_primary_api: normalizedApi?.api10 ?? null,
      resolved_district: body.district ?? null,
      resolved_lease_number: null,
      resolved_gas_id: null,
      resolved_operator_number: null,
      report_storage_path: null,
      archive_storage_path: null,
      manifest_storage_path: null,
    })
    .select("id, status")
    .single();

  if (runInsertError || !runRow) {
    console.error("[trrc/due-diligence POST] run insert error:", runInsertError);
    return NextResponse.json(
      { ok: false, error: "Failed to create due diligence run." },
      { status: 500 },
    );
  }

  const run_id = runRow.id as string;

  // 7. Insert resolved entities
  if (resolution.entities.length > 0) {
    const entityRows = resolution.entities.map((e) => ({
      run_id,
      entity_type: e.entity_type,
      canonical_identifier: e.canonical_identifier,
      display_name: e.display_name,
      attributes: e.attributes,
      confidence: e.confidence,
      resolution_method: e.resolution_method,
      is_user_selected: e.is_user_selected,
    }));

    const { error: entityInsertError } = await supabase
      .from("trrc_resolved_entities")
      .insert(entityRows);

    if (entityInsertError) {
      console.error("[trrc/due-diligence POST] entity insert error:", entityInsertError);
      // Non-fatal — run row exists; client can still proceed
    }
  }

  return NextResponse.json({
    ok: true,
    data: {
      id: run_id,
      run_id,
      status,
      needs_user_selection,
      entities: resolution.entities,
      normalized_input: resolution.normalized_input,
      input_type: resolution.input_type,
    },
  });
}
