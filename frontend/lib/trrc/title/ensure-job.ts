/**
 * ensureTitleJobForApi — create (or reuse) the title research job for an
 * API number at the moment a due-diligence run is created, so a single
 * "API in" produces both halves of the record without a second workflow.
 *
 * Why this exists: on 2026-09-14 a real API-only run produced a GOLD 2.0
 * record whose every title section read "No title research job for this
 * API is present in this account" — because the title job is a separate
 * workflow the user had to start by hand. The product promise is API in →
 * decision record out. This makes the title job part of that.
 *
 * Idempotent: if a live (not cancelled/failed) job already covers this
 * api10 for this user, it is reused rather than duplicated — the GOLD
 * lookup (gold2/title-link.ts) resolves by api10 + owner, so a second
 * job would only make that lookup ambiguous.
 *
 * Same claim-safe insert order as the title-chain POST route: the job row
 * is inserted as "creating" (a status the worker never claims), the well
 * row is attached, then the job flips to "pending". Inserting as
 * "pending" first was a real race, hit live the same day.
 *
 * Never throws into the caller: the due-diligence run must still be
 * created even if the title side fails — the failure is returned so the
 * caller can log it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseApiBatch } from "./api-input";
import type { InterestScope } from "./chain-types";

export interface EnsureTitleJobResult {
  ok: boolean;
  created: boolean;
  jobId: string | null;
  api10: string | null;
  reason: string | null;
}

const DEFAULT_INTEREST_SCOPE: InterestScope[] = ["minerals"];
const LIVE_JOB_STATUSES_EXCLUDED = ["cancelled", "failed"];

export async function ensureTitleJobForApi(
  supabase: SupabaseClient,
  userId: string,
  rawInput: string,
  opts: { interestScope?: InterestScope[]; asOfDate?: string } = {},
): Promise<EnsureTitleJobResult> {
  const batch = parseApiBatch(rawInput);
  const first = batch.inputs.find(i => i.ok && i.api10 && !i.duplicateOf);
  if (!first || !first.api10) {
    return { ok: false, created: false, jobId: null, api10: null, reason: "Input is not a valid Texas API number; no title job created." };
  }
  const api10 = first.api10;

  // Reuse a live job for this api10 if one exists.
  const existingWells = await supabase.from("title_job_wells").select("job_id").eq("user_id", userId).eq("api10", api10);
  if (existingWells.error) {
    return { ok: false, created: false, jobId: null, api10, reason: `Could not check existing title jobs: ${existingWells.error.message}` };
  }
  const ids = [...new Set((existingWells.data ?? []).map(w => String(w.job_id)))];
  if (ids.length > 0) {
    const jobs = await supabase.from("title_research_jobs").select("id, status, updated_at").eq("user_id", userId).in("id", ids).order("updated_at", { ascending: false });
    const live = (jobs.data ?? []).find(j => !LIVE_JOB_STATUSES_EXCLUDED.includes(String(j.status)));
    if (live) return { ok: true, created: false, jobId: String(live.id), api10, reason: null };
  }

  const interestScope = opts.interestScope && opts.interestScope.length > 0 ? opts.interestScope : DEFAULT_INTEREST_SCOPE;
  const asOfDate = opts.asOfDate ?? new Date().toISOString().slice(0, 10);

  const { data: job, error: jobErr } = await supabase.from("title_research_jobs").insert({
    user_id: userId, status: "creating", input_text: rawInput.slice(0, 20_000), interest_scope: interestScope,
    research_start_date: null, as_of_date: asOfDate,
    started_at: new Date().toISOString(), stage_detail: "Queued for well resolution (created with the due-diligence run)",
  }).select("id").single();
  if (jobErr || !job) {
    return { ok: false, created: false, jobId: null, api10, reason: `Could not create title job: ${jobErr?.message ?? "unknown error"}` };
  }

  const { error: wellErr } = await supabase.from("title_job_wells").insert({
    job_id: job.id, user_id: userId, original_input: first.originalInput, api10: first.api10, api14: first.api14,
    sidetrack_suffix: first.sidetrackSuffix, completion_suffix: first.completionSuffix,
    state_code: first.stateCode, county_code: first.countyCode, county_name: first.countyName,
    validation_error: null, resolution_status: "unresolved", resolution_error: null,
  });
  if (wellErr) {
    await supabase.from("title_research_jobs").update({ status: "failed", error_summary: `Could not record well: ${wellErr.message}`, updated_at: new Date().toISOString() }).eq("id", job.id);
    return { ok: false, created: false, jobId: String(job.id), api10, reason: `Could not record well: ${wellErr.message}` };
  }

  const { error: readyErr } = await supabase.from("title_research_jobs").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", job.id).eq("status", "creating");
  if (readyErr) {
    return { ok: false, created: false, jobId: String(job.id), api10, reason: `Could not queue title job: ${readyErr.message}` };
  }
  return { ok: true, created: true, jobId: String(job.id), api10, reason: null };
}
