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
 * Creation goes through the same atomic RPC the title-chain POST route
 * uses (migration 032, create_title_research_job): the job and its well
 * rows are published in one transaction, so a polling worker can never
 * observe a pending job without inputs. This requires the caller's
 * Supabase client to carry the user's session (auth.uid() is the owner
 * inside the function) — which is the case from createDueDiligenceRun,
 * invoked only by authenticated routes. There is deliberately no
 * fallback to separate inserts.
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

  const { data: job, error: jobErr } = await supabase.rpc("create_title_research_job", {
    p_job: {
      input_text: rawInput.slice(0, 20_000), interest_scope: interestScope,
      research_start_date: null, as_of_date: asOfDate,
    },
    p_wells: [{
      original_input: first.originalInput, api10: first.api10, api14: first.api14,
      sidetrack_suffix: first.sidetrackSuffix, completion_suffix: first.completionSuffix,
      state_code: first.stateCode, county_code: first.countyCode, county_name: first.countyName,
      validation_error: null,
    }],
  });
  const created = job as { id?: string; status?: string } | null;
  if (jobErr || !created?.id) {
    return { ok: false, created: false, jobId: null, api10, reason: `Could not create title job atomically: ${jobErr?.message ?? "no id returned"}` };
  }
  return { ok: true, created: true, jobId: String(created.id), api10, reason: null };
}
