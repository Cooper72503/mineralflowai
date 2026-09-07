/**
 * POST /api/trrc/title-chain — create a title-chain research job from one
 * or more API numbers. GET — list the caller's recent jobs.
 *
 * Input parsing never fails the batch: every entry gets its own result
 * (valid, invalid with reason, or duplicate). The job row is created with
 * status "pending" so the worker's title sequencer picks it up; when no
 * entry is a valid API the job goes straight to tract confirmation so the
 * user can supply a legal description or documents instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { parseApiBatch, MAX_APIS_PER_JOB } from "@/lib/trrc/title/api-input";
import { INTEREST_SCOPES, type InterestScope } from "@/lib/trrc/title/chain-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateBody {
  apiNumbers?: unknown;
  interestScope?: unknown;
  researchStartDate?: unknown;
  asOfDate?: unknown;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

  let body: CreateBody;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 }); }

  const rawApis = typeof body.apiNumbers === "string" ? body.apiNumbers : Array.isArray(body.apiNumbers) ? body.apiNumbers.filter((x): x is string => typeof x === "string") : null;
  if (rawApis === null || (typeof rawApis === "string" ? !rawApis.trim() : rawApis.length === 0)) {
    return NextResponse.json({ ok: false, error: "apiNumbers is required (a string or an array of strings)." }, { status: 400 });
  }
  const scopeInput = Array.isArray(body.interestScope) ? body.interestScope.filter((s): s is InterestScope => typeof s === "string" && (INTEREST_SCOPES as string[]).includes(s)) : [];
  const interestScope: InterestScope[] = scopeInput.length > 0 ? Array.from(new Set(scopeInput)) : ["minerals"];
  if (body.researchStartDate !== undefined && body.researchStartDate !== null && body.researchStartDate !== "" && !isIsoDate(body.researchStartDate)) {
    return NextResponse.json({ ok: false, error: "researchStartDate must be YYYY-MM-DD." }, { status: 400 });
  }
  if (body.asOfDate !== undefined && body.asOfDate !== null && body.asOfDate !== "" && !isIsoDate(body.asOfDate)) {
    return NextResponse.json({ ok: false, error: "asOfDate must be YYYY-MM-DD." }, { status: 400 });
  }

  const batch = parseApiBatch(rawApis);
  if (batch.inputs.length === 0) return NextResponse.json({ ok: false, error: "No API numbers found in the input." }, { status: 400 });
  if (batch.validCount > MAX_APIS_PER_JOB) return NextResponse.json({ ok: false, error: `At most ${MAX_APIS_PER_JOB} API numbers per job (${batch.validCount} valid entries supplied).` }, { status: 400 });

  const inputText = Array.isArray(rawApis) ? rawApis.join("\n") : rawApis;
  const initialStatus = batch.validCount > 0 ? "pending" : "awaiting_tract_confirmation";

  const { data: job, error: jobErr } = await supabase.from("title_research_jobs").insert({
    user_id: user.id, status: initialStatus, input_text: inputText.slice(0, 20_000), interest_scope: interestScope,
    research_start_date: isIsoDate(body.researchStartDate) ? body.researchStartDate : null,
    as_of_date: isIsoDate(body.asOfDate) ? body.asOfDate : new Date().toISOString().slice(0, 10),
    started_at: new Date().toISOString(), stage_detail: batch.validCount > 0 ? "Queued for well resolution" : "No valid API numbers — add a tract or documents manually",
  }).select("id, status").single();
  if (jobErr || !job) return NextResponse.json({ ok: false, error: `Could not create job: ${jobErr?.message}` }, { status: 500 });

  const wellRows = batch.inputs.filter(i => !i.duplicateOf).map(i => ({
    job_id: job.id, user_id: user.id, original_input: i.originalInput, api10: i.api10, api14: i.api14, sidetrack_suffix: i.sidetrackSuffix, completion_suffix: i.completionSuffix,
    state_code: i.stateCode, county_code: i.countyCode, county_name: i.countyName, validation_error: i.error,
    resolution_status: i.ok ? "unresolved" : "error", resolution_error: i.ok ? null : i.error,
  }));
  if (wellRows.length > 0) {
    const { error: wellErr } = await supabase.from("title_job_wells").insert(wellRows);
    if (wellErr) return NextResponse.json({ ok: false, error: `Could not record wells: ${wellErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    data: {
      jobId: job.id, status: job.status,
      inputs: batch.inputs, validCount: batch.validCount, invalidCount: batch.invalidCount, duplicateCount: batch.duplicateCount,
    },
  });
}

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

  const { data, error } = await supabase.from("title_research_jobs")
    .select("id, status, stage_detail, progress_percent, input_text, interest_scope, created_at, updated_at, error_summary")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(25);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, data: data ?? [] });
}
