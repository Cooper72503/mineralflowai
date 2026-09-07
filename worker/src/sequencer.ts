/**
 * Deterministic TRRC Sequencer — replaces agent.ts's Claude-orchestrated
 * tool-selection loop with real control flow. The LLM's job there was
 * never open-ended reasoning: the system prompt it followed was a fully
 * describable, finite rule set (input-priority branching, fixed fallback
 * paths, exact numeric flag thresholds, exact analytics formulas). That
 * rule set is real code here instead of natural-language instructions to
 * a model — see the project plan "Deterministic TRRC Sequencer — Remove
 * the Anthropic Runtime Dependency" for the full rationale and phase
 * breakdown this file implements (Phase 2).
 *
 * Two things this file deliberately does NOT do, because they're already
 * handled elsewhere and porting them here would be pure duplication:
 *   - Input classification: frontend/lib/trrc/create-run.ts already calls
 *     resolveEntities()/detectInputType() once, at run-creation time, and
 *     persists detected_input_type/selected_input_type on the run row.
 *     This file just reads those two columns off the row it already
 *     pre-seeds from.
 *   - Flag/analytics computation: frontend/lib/trrc/report-builder.ts
 *     already exports computeProductionAnalytics()/generateFlags(), pure
 *     functions reading only trrc_source_attempts/trrc_production_monthly
 *     — the exact tables this file writes to. They already run live on
 *     every dashboard poll. This file's only job for those to keep
 *     working is preserving that write contract exactly, which the step
 *     functions below do.
 *
 * runLandmanSequencer has the identical signature to agent.ts's
 * runLandmanAgent so the two are a one-line swap at the call site
 * (worker/src/index.ts, Phase 3).
 */

import * as ewa from "./tools/ewa.js";
import * as browser from "./tools/browser.js";
import * as countyRecords from "./tools/county-records.js";
import { reportProgress, logStep } from "./progress.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductionRow } from "./tools/ewa.js";

export interface AgentState {
  apiNumber:      string | null;
  // True only once search_wellbore has actually matched apiNumber against a
  // real TRRC record. apiNumber can be non-null while this is false — it's
  // pre-seeded from the run's original (unconfirmed, possibly malformed or
  // fake-but-structurally-valid) user input. Downstream persistence must not
  // treat an unconfirmed guess as equivalent to a TRRC-confirmed identity.
  apiNumberConfirmed: boolean;
  leaseNumber:    string | null;
  district:       string | null;
  operatorName:   string | null;
  operatorNumber: string | null;
  county:         string | null;
  production:     ProductionRow[];
}

// ─── Shared persistence (extracted from agent.ts's dispatchTool tail) ─────────

async function persistAttempt(
  supabase: SupabaseClient,
  runId: string,
  sourceName: string,
  callIndex: number,
  result: unknown,
): Promise<void> {
  const resultData = result as Record<string, unknown>;
  const count =
    Array.isArray(resultData?.["wells"])      ? (resultData["wells"]      as unknown[]).length :
    Array.isArray(resultData?.["records"])    ? (resultData["records"]    as unknown[]).length :
    Array.isArray(resultData?.["violations"]) ? (resultData["violations"] as unknown[]).length :
    Array.isArray(resultData?.["rows"])       ? (resultData["rows"]       as unknown[]).length :
    Array.isArray(resultData?.["documents"])  ? (resultData["documents"]  as unknown[]).length :
    Array.isArray(resultData?.["permits"])    ? (resultData["permits"]    as unknown[]).length :
    resultData?.["found"] === true ? 1 : 0;

  const isOk = resultData?.["error"] == null;

  // Write failure here is intentionally not surfaced beyond a console log —
  // matches agent.ts's original .then(null, () => {}) swallow for this
  // specific write (unlike reportProgress, which does surface failures;
  // see progress.ts's own comment on that distinction).
  await supabase.from("trrc_source_attempts").upsert({
    run_id:           runId,
    source_id:        `${sourceName}_${callIndex}`,
    source_name:      sourceName,
    status:           isOk ? "success" : "failed_transient",
    result_count:     count,
    error_message:    isOk ? null : String(resultData?.["error"] ?? resultData?.["message"] ?? ""),
    attempted_at:     new Date().toISOString(),
    result_data_json: result,
  }, { onConflict: "run_id,source_id", ignoreDuplicates: false }).then(null, () => {});

  await logStep(supabase, runId, sourceName, isOk ? "done" : "failed", String(
    (resultData?.["message"] ?? resultData?.["error"] ?? "ok") as string
  ).slice(0, 120));
}

async function persistNotApplicable(
  supabase: SupabaseClient,
  runId: string,
  sourceName: string,
  callIndex: number,
  reason: string,
): Promise<void> {
  await supabase.from("trrc_source_attempts").upsert({
    run_id:        runId,
    source_id:     `${sourceName}_${callIndex}`,
    source_name:   sourceName,
    status:        "not_applicable",
    result_count:  0,
    error_message: reason,
    attempted_at:  new Date().toISOString(),
    result_data_json: null,
  }, { onConflict: "run_id,source_id", ignoreDuplicates: false }).then(null, () => {});

  await logStep(supabase, runId, sourceName, "done", reason);
}

// ─── Step functions ─────────────────────────────────────────────────────────
// Each mirrors one case of agent.ts's dispatchTool switch, mechanically
// extracted: same fetcher call, same state-merge discipline (fill-if-empty
// except search_wellbore's real reconcile logic), same persistence tail.

export async function stepSearchWellbore(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "search_wellbore", "running");
  const r = await ewa.searchWellbore(String(state.apiNumber ?? ""));
  const rr = r as unknown as Record<string, unknown>;
  if (rr["found"]) {
    // Deliberate simplification vs. agent.ts: the LLM could call this tool
    // with an arbitrary api_number for an unrelated offset/analog well
    // lookup, so the original guarded state mutation on "was this actually
    // the subject asset's number". A deterministic sequencer only ever
    // calls search_wellbore for the subject asset — that guard is always
    // true here, so it's dropped rather than carried as dead logic.
    const wells = rr["wells"] as Array<Record<string, unknown>> | undefined;
    const confirmedApi = wells?.[0]?.["api_no"] as string | undefined;
    if (confirmedApi) {
      state.apiNumber = confirmedApi;
      state.apiNumberConfirmed = true;
    }
    const leaseNumber = rr["lease_number"] as string | undefined;
    const district = rr["district"] as string | undefined;
    const operator = rr["operator"] as string | undefined;
    const operatorNumber = rr["operator_number"] as string | undefined;
    const county = rr["county"] as string | undefined;
    if (leaseNumber && !state.leaseNumber) state.leaseNumber = leaseNumber;
    if (district && !state.district) state.district = district;
    if (operator && !state.operatorName) state.operatorName = operator;
    if (operatorNumber && !state.operatorNumber) state.operatorNumber = operatorNumber;
    if (county && !state.county) state.county = county;
  } else if (!state.apiNumberConfirmed) {
    // TRRC itself couldn't confirm this exact number — an unconfirmed
    // guess that TRRC couldn't verify is a disclosed gap, not a resolved
    // fact. Never persist a structurally-valid-but-fake API as if real.
    state.apiNumber = null;
  }
  await persistAttempt(supabase, runId, "search_by_api", callIndex, r);
}

export async function stepSearchLeaseWells(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "search_lease_wells", "running");
  const r = await ewa.searchLeaseWells(String(state.leaseNumber ?? ""), String(state.district ?? ""));
  await persistAttempt(supabase, runId, "search_by_lease", callIndex, r);
}

export async function stepSearchOperator(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "search_operator", "running");
  const r = await browser.searchOperator(state.operatorName, state.operatorNumber);
  const rr = r as unknown as Record<string, unknown>;
  const record = rr["record"] as Record<string, unknown> | undefined;
  if (rr["found"] && record?.["operator_number"] && !state.operatorNumber) {
    state.operatorNumber = record["operator_number"] as string;
  }
  await persistAttempt(supabase, runId, "search_by_operator", callIndex, r);
}

export async function stepGetWellStatus(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_well_status", "running");
  const r = await ewa.getWellStatus(String(state.apiNumber ?? ""), state.leaseNumber, state.district);
  const rr = r as unknown as Record<string, unknown>;
  if (rr["found"]) {
    const leaseNumber = rr["lease_number"] as string | undefined;
    const district = rr["district"] as string | undefined;
    if (leaseNumber && !state.leaseNumber) state.leaseNumber = leaseNumber;
    if (district && !state.district) state.district = district;
  }
  await persistAttempt(supabase, runId, "fetch_well_status", callIndex, r);
}

export async function stepGetProduction(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_production", "running");
  const r = await ewa.getProduction(state.leaseNumber, state.district, undefined);
  const rr = r as unknown as Record<string, unknown>;
  const rows = rr["rows"] as ProductionRow[] | undefined;
  if (rr["found"] && rows && rows.length > 0) {
    state.production.push(...rows);
  }
  await persistAttempt(supabase, runId, "fetch_production", callIndex, r);
}

async function stepGetP4GathererPurchaser(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_p4_gatherer_purchaser", "running");
  const r = await ewa.getGathererPurchaser(state.leaseNumber, state.district);
  await persistAttempt(supabase, runId, "fetch_p4_records", callIndex, r);
}

export async function stepGetCompletionRecords(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_completion_records", "running");
  const r = await ewa.getCompletionRecords(String(state.apiNumber ?? ""));
  await persistAttempt(supabase, runId, "fetch_completion_records", callIndex, r);
}

export async function stepGetPluggingRecords(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_plugging_records", "running");
  const r = await ewa.getPluggingRecords(String(state.apiNumber ?? ""));
  await persistAttempt(supabase, runId, "fetch_plugging_records", callIndex, r);
}

export async function stepGetInactiveWellStatus(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_inactive_well_status", "running");
  const r = await browser.getInactiveWellStatus(String(state.apiNumber ?? ""), state.operatorNumber);
  await persistAttempt(supabase, runId, "fetch_inactive_well_status", callIndex, r);
}

export async function stepGetOrphanWell(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_orphan_well", "running");
  const r = await ewa.getOrphanWell(String(state.apiNumber ?? ""));
  await persistAttempt(supabase, runId, "fetch_orphan_well", callIndex, r);
}

export async function stepGetComplianceViolations(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_compliance_violations", "running");
  const r = await browser.getComplianceViolations(state.operatorNumber, state.apiNumber);
  await persistAttempt(supabase, runId, "fetch_compliance_violations", callIndex, r);
}

export async function stepGetSeveranceRecords(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_severance_records", "running");
  const r = await ewa.getSeveranceRecords(state.leaseNumber, state.district);
  await persistAttempt(supabase, runId, "fetch_severance_records", callIndex, r);
}

export async function stepGetInjectionRecords(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_injection_records", "running");
  const r = await ewa.getInjectionRecords(String(state.apiNumber ?? ""), state.operatorNumber);
  await persistAttempt(supabase, runId, "fetch_injection_records", callIndex, r);
}

export async function stepGetDrillingPermits(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_drilling_permits", "running");
  const r = await ewa.getDrillingPermits(String(state.apiNumber ?? ""));
  await persistAttempt(supabase, runId, "fetch_drilling_permits", callIndex, r);
}

export async function stepGetOilProration(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_oil_proration", "running");
  const r = await ewa.getOilProration(state.leaseNumber, state.district);
  await persistAttempt(supabase, runId, "fetch_oil_proration", callIndex, r);
}

export async function stepGetCodaDocuments(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_coda_documents", "running");
  const r = await browser.getCodaDocuments(String(state.apiNumber ?? ""));
  await persistAttempt(supabase, runId, "fetch_coda_records", callIndex, r);
}

export async function stepGetCountyRecords(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_county_records", "running");
  const r = await countyRecords.getCountyRecords(String(state.county ?? ""), String(state.operatorName ?? ""));
  await persistAttempt(supabase, runId, "fetch_county_records", callIndex, r);
}

export async function stepGetGisLocation(state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number): Promise<void> {
  await logStep(supabase, runId, "get_gis_location", "running");
  const r = await ewa.getGisLocation(String(state.apiNumber ?? ""));
  await persistAttempt(supabase, runId, "fetch_gis_plat", callIndex, r);
}

type Step = (state: AgentState, runId: string, supabase: SupabaseClient, callIndex: number) => Promise<void>;

// Pairs each step with the exact source_name its own internal persistAttempt
// call uses, so a step that throws BEFORE reaching that call (a network
// failure, not a shaped error result) can still be recorded under the same
// name a successful run would have used — the coverage matrix must never
// show a source as silently absent just because it happened to throw.
const SOURCE_NAME: Map<Step, string> = new Map([
  [stepGetProduction, "fetch_production"],
  [stepGetP4GathererPurchaser, "fetch_p4_records"],
  [stepGetSeveranceRecords, "fetch_severance_records"],
  [stepGetOilProration, "fetch_oil_proration"],
  [stepGetCompletionRecords, "fetch_completion_records"],
  [stepGetPluggingRecords, "fetch_plugging_records"],
  [stepGetOrphanWell, "fetch_orphan_well"],
  [stepGetInjectionRecords, "fetch_injection_records"],
  [stepGetDrillingPermits, "fetch_drilling_permits"],
  [stepGetGisLocation, "fetch_gis_plat"],
  [stepGetCodaDocuments, "fetch_coda_records"],
  [stepGetComplianceViolations, "fetch_compliance_violations"],
  [stepGetCountyRecords, "fetch_county_records"],
  [stepGetInactiveWellStatus, "fetch_inactive_well_status"],
  [stepSearchOperator, "search_by_operator"],
]);

// ─── Orchestration ───────────────────────────────────────────────────────────

export async function runLandmanSequencer(
  runId:   string,
  input:   string,
  supabase: SupabaseClient,
): Promise<void> {
  const state: AgentState = {
    apiNumber:      null,
    apiNumberConfirmed: false,
    leaseNumber:    null,
    district:       null,
    operatorName:   null,
    operatorNumber: null,
    county:         null,
    production:     [],
  };

  const { data: runRow } = await supabase
    .from("trrc_due_diligence_runs")
    .select("resolved_primary_api,resolved_lease_number,resolved_district,resolved_operator_number,operator_name,selected_input_type,detected_input_type")
    .eq("id", runId)
    .single();

  if (runRow) {
    state.apiNumber      = runRow["resolved_primary_api"]     ?? null;
    state.leaseNumber    = runRow["resolved_lease_number"]    ?? null;
    state.district       = runRow["resolved_district"]        ?? null;
    state.operatorNumber = runRow["resolved_operator_number"] ?? null;
    state.operatorName   = runRow["operator_name"]            ?? null;
  }
  const inputType: string = (runRow?.["selected_input_type"] ?? runRow?.["detected_input_type"] ?? "unknown") as string;

  let highestPct = 0;
  const reportProgressClamped = async (pct: number, status: string) => {
    highestPct = Math.max(highestPct, pct);
    await reportProgress(supabase, runId, highestPct, status);
  };
  await reportProgressClamped(5, "running");

  const isCancelled = async (): Promise<boolean> => {
    const { data: statusCheck } = await supabase
      .from("trrc_due_diligence_runs")
      .select("status")
      .eq("id", runId)
      .single();
    return statusCheck?.["status"] === "cancelled";
  };

  // ── Entry-point branch ────────────────────────────────────────────────────
  // Mirrors the SYSTEM_PROMPT's input-priority rules from agent.ts as real
  // control flow: identity resolution first, with the documented fallback
  // (wellbore PDQ miss -> well status, a different index that often finds
  // wells PDQ misses).
  let callIndex = 0;
  let entryHandled = false;

  if (state.apiNumber && !(await isCancelled())) {
    callIndex++;
    await stepSearchWellbore(state, runId, supabase, callIndex);
    entryHandled = true;
    if (!state.apiNumber && !state.leaseNumber) {
      // wellbore PDQ found nothing usable for this exact number — well
      // status uses a different TRRC index and often catches wells PDQ
      // misses, per the documented fallback rule.
      callIndex++;
      await stepGetWellStatus(state, runId, supabase, callIndex);
    }
  } else if (inputType === "rrc_lease_number" && state.leaseNumber && state.district) {
    callIndex++;
    await stepSearchLeaseWells(state, runId, supabase, callIndex);
    entryHandled = true;
  }

  if (!entryHandled) {
    if (state.operatorName || state.operatorNumber) {
      callIndex++;
      await stepSearchOperator(state, runId, supabase, callIndex);
    } else {
      // No deterministic TRRC entry point exists for this input shape
      // (bare lease number with no district, legal description, lease
      // name, or genuinely unknown input) — this is not a regression vs.
      // the LLM path, which had no more of a guaranteed answer here
      // either (TRRC's own well-status lookup requires a district
      // alongside a lease number regardless of who's asking). Disclose
      // the gap honestly rather than silently doing nothing.
      callIndex++;
      await persistNotApplicable(
        supabase, runId, "entry_resolution", callIndex,
        `No deterministic TRRC entry point for input type "${inputType}" without a resolvable API number, lease+district, or operator identity.`,
      );
    }
  }

  // ── Fixed, gated sequence ────────────────────────────────────────────────
  const remainingSteps: Step[] = [];
  if (state.leaseNumber && state.district) {
    remainingSteps.push(stepGetProduction, stepGetP4GathererPurchaser, stepGetSeveranceRecords, stepGetOilProration);
  }
  if (state.apiNumber) {
    remainingSteps.push(
      stepGetCompletionRecords, stepGetPluggingRecords, stepGetOrphanWell,
      stepGetInjectionRecords, stepGetDrillingPermits, stepGetGisLocation, stepGetCodaDocuments,
    );
  }
  // Enrichment: search_wellbore sometimes resolves an operator NAME but no
  // operator NUMBER (real, live-observed gap — 2026-09-03 Phase 3
  // validation against well 42-165-02733). get_compliance_violations
  // prefers operator_number ("covers all wells for the operator" per its
  // own tool description) and get_inactive_well_status requires it
  // outright, degrading to an honest "not resolved yet" without it. The
  // LLM path covered this only incidentally, by sometimes choosing to call
  // search_operator itself once it saw a name with no number — the
  // deterministic sequencer needs the same enrichment made an explicit,
  // fixed rule instead of relying on the model to think of it.
  if (!state.operatorNumber && state.operatorName) {
    remainingSteps.push(stepSearchOperator);
  }
  if (state.operatorNumber || state.apiNumber) {
    remainingSteps.push(stepGetComplianceViolations);
  }
  if (state.county) {
    remainingSteps.push(stepGetCountyRecords);
  }
  // Inactive-well plugging-deadline check runs after well status is known —
  // scheduled here unconditionally when an API is known; the fetcher itself
  // reports "not applicable" via its own found:false path if the well
  // turns out to be active, same as the original LLM-driven call would.
  if (state.apiNumber) {
    remainingSteps.push(stepGetInactiveWellStatus);
  }

  const totalApplicableSteps = callIndex + remainingSteps.length;

  for (const step of remainingSteps) {
    if (await isCancelled()) return;
    callIndex++;
    try {
      await step(state, runId, supabase, callIndex);
    } catch {
      // Never stop at a single failure — this source's failure doesn't
      // block independent subsequent sources. Each step already persists
      // its own attempt row internally on success; a thrown exception
      // here (network-level failure before the fetcher's own try/catch
      // could produce a result object) still needs a record so this
      // source doesn't silently vanish from the coverage matrix.
      const sourceName = SOURCE_NAME.get(step) ?? step.name;
      await persistAttempt(supabase, runId, sourceName, callIndex, { error: "step threw before producing a result" });
    }
    const pct = 5 + Math.round((callIndex / Math.max(totalApplicableSteps, 1)) * 85);
    await reportProgressClamped(Math.min(90, pct), "running");
  }

  // ── Persist production rows ──────────────────────────────────────────────
  if (state.production.length > 0) {
    const seen = new Set<string>();
    const prodRows = state.production
      .filter(r => {
        const key = `${state.leaseNumber}:${state.district}:${r.production_month}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(r => ({
        run_id:             runId,
        entity_type:        "lease",
        api_number:         state.apiNumber,
        district:           state.district ?? "",
        lease_number:       state.leaseNumber,
        gas_id:             null,
        operator_number:    state.operatorNumber,
        production_month:   r.production_month,
        oil_bbl:            r.oil_bbl,
        gas_mcf:            r.gas_mcf,
        casinghead_gas_mcf: r.casinghead_gas_mcf,
        condensate_bbl:     r.condensate_bbl,
        water_bbl:          r.water_bbl,
      }));

    const { error: prodUpsertError } = await supabase.from("trrc_production_monthly").upsert(prodRows, {
      onConflict: "run_id,entity_type,api_number,lease_number,production_month",
      ignoreDuplicates: true,
    });
    if (prodUpsertError) {
      console.error(`[${runId}] production upsert failed:`, prodUpsertError.message);
    }
  }

  // ── Terminal update ───────────────────────────────────────────────────────
  const { data: attempts } = await supabase
    .from("trrc_source_attempts")
    .select("source_name,status,result_count,result_data_json")
    .eq("run_id", runId);

  const successCount = (attempts ?? []).filter(a => a["status"] === "success").length;
  const totalCount   = (attempts ?? []).length;

  const didComplete = true; // reached the end of the branch-filtered step list without throwing out of the loop itself

  await supabase.from("trrc_due_diligence_runs").update({
    status:                   didComplete ? "complete" : "failed",
    progress_percent:         didComplete ? 100 : 90,
    completed_at:             new Date().toISOString(),
    updated_at:               new Date().toISOString(),
    resolved_primary_api:     state.apiNumber,
    resolved_district:        state.district,
    resolved_lease_number:    state.leaseNumber,
    resolved_operator_number: state.operatorNumber,
    result_summary:           `${successCount} of ${totalCount} sources retrieved. ${state.production.length} production months found.`,
    error_summary:            null,
  }).eq("id", runId).neq("status", "cancelled");
}
