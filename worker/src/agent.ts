/**
 * TRRC Landman Agent
 *
 * A Claude agent loop that researches TRRC public records the way a
 * real landman would: it reasons about what to look up next based on
 * what it finds, adapts when one path fails, and builds context
 * progressively before drawing conclusions.
 */

import Anthropic from "@anthropic-ai/sdk";
import { TRRC_TOOLS } from "./tools/definitions.js";
import * as ewa from "./tools/ewa.js";
import * as browser from "./tools/browser.js";
import * as countyRecords from "./tools/county-records.js";
import { reportProgress, logStep } from "./progress.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProductionRow } from "./tools/ewa.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a Texas landman conducting mineral rights due diligence using TRRC (Texas Railroad Commission) public records. You have been given an input — API number, lease number, operator name, or some combination — and must produce a thorough research report.

## How to work

**Think like a landman, not a script.** The order you check things matters. Use each result to inform the next query:
- If you get a lease number from any source, use it immediately to pull production.
- If the wellbore PDQ doesn't find an API, try well status — it uses a different index and often finds wells the PDQ misses.
- If you find the well is inactive, immediately check for a plugging deadline.
- If you find the operator number, use it for violations — it's more complete than searching by API.

**Never stop at a single failure.** TRRC has multiple overlapping databases. If one path doesn't find the well, try another before concluding the well doesn't exist.

**Context you must resolve before calling submit_report:**
1. Lease number + district — required for production history
2. Operator number — required for complete violations check
3. Well status (Active / Inactive / Plugged) — always check
4. Production history — the most critical data point for a buyer. Do not submit without attempting this.

## What to flag

CRITICAL (deal-breakers):
- Orphan well
- P-5 status inactive or revoked
- >30% YoY oil production decline
- Open compliance violations (unresolved, penalty unpaid)
- Plugged status with no W-3C on file

IMPORTANT (need follow-up):
- Inactive well with plugging deadline within 12 months
- No P-4 gatherer/purchaser on file for the lease — production cannot legally be sold/transported without one
- Rising water-to-oil ratio
- Zero production months (more than 3)
- Bond amount below $25,000

## Production analytics to compute (when you have the data)

When you have production rows, compute these and include in submit_report:
- 12-month average oil (BBL/month)
- Prior 12-month average oil
- YoY decline % = (prior12 - recent12) / prior12 × 100
- Cumulative oil and gas over all history
- Current WOR = water / oil for last 3 months
- WOR trend vs prior 3 months

## Professional standards

Your narrative must be the kind of thing a mineral buyer would trust — specific, sourced, and honest about gaps. Say what you found, what you didn't find, and what it means. Never say "records not available" without explaining why and whether that is normal for this well type.

The report is what the buyer pays for. Make it count.`;

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

interface AgentState {
  apiNumber:      string | null;
  leaseNumber:    string | null;
  district:       string | null;
  operatorName:   string | null;
  operatorNumber: string | null;
  county:         string | null;
  production:     ProductionRow[];
}

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  state: AgentState,
  runId: string,
  supabase: SupabaseClient,
  callIndex: number,
): Promise<unknown> {
  await logStep(supabase, runId, name, "running");

  let result: unknown;
  let sourceName = name;

  switch (name) {
    case "search_wellbore": {
      const r = await ewa.searchWellbore(String(input.api_number ?? state.apiNumber ?? ""));
      if (r.found) {
        if (r.lease_number    && !state.leaseNumber)    state.leaseNumber    = r.lease_number;
        if (r.district        && !state.district)        state.district        = r.district;
        if (r.operator        && !state.operatorName)    state.operatorName    = r.operator;
        if (r.operator_number && !state.operatorNumber)  state.operatorNumber  = r.operator_number;
        if (r.county          && !state.county)          state.county          = r.county;
      }
      result = r;
      sourceName = "search_by_api";
      break;
    }

    case "search_lease_wells": {
      result = await ewa.searchLeaseWells(String(input.lease_number ?? ""), String(input.district ?? ""));
      sourceName = "search_by_lease";
      break;
    }

    case "search_operator": {
      const r = await browser.searchOperator(
        input.operator_name  ? String(input.operator_name)  : state.operatorName,
        input.operator_number ? String(input.operator_number) : state.operatorNumber,
      );
      if (r.found && r.record?.operator_number && !state.operatorNumber) {
        state.operatorNumber = r.record.operator_number;
      }
      result = r;
      sourceName = "search_by_operator";
      break;
    }

    case "get_well_status": {
      const r = await ewa.getWellStatus(
        String(input.api_number ?? state.apiNumber ?? ""),
        input.lease_number ? String(input.lease_number) : state.leaseNumber,
        input.district     ? String(input.district)     : state.district,
      );
      if (r.found) {
        if (r.lease_number && !state.leaseNumber) state.leaseNumber = r.lease_number;
        if (r.district     && !state.district)     state.district     = r.district;
      }
      result = r;
      sourceName = "fetch_well_status";
      break;
    }

    case "get_production": {
      const r = await ewa.getProduction(
        input.lease_number ? String(input.lease_number) : state.leaseNumber,
        input.district     ? String(input.district)     : state.district,
        input.lease_type   ? String(input.lease_type)   : undefined,
      );
      if (r.found && r.rows.length > 0) {
        state.production.push(...r.rows);
      }
      result = r;
      sourceName = "fetch_production";
      break;
    }

    case "get_p4_gatherer_purchaser":
      result = await ewa.getGathererPurchaser(
        input.lease_number ? String(input.lease_number) : state.leaseNumber,
        input.district     ? String(input.district)     : state.district,
      );
      sourceName = "fetch_p4_records";
      break;

    case "get_completion_records":
      result = await ewa.getCompletionRecords(String(input.api_number ?? state.apiNumber ?? ""));
      sourceName = "fetch_completion_records";
      break;

    case "get_plugging_records":
      result = await ewa.getPluggingRecords(String(input.api_number ?? state.apiNumber ?? ""));
      sourceName = "fetch_plugging_records";
      break;

    case "get_inactive_well_status":
      result = await ewa.getInactiveWellStatus(
        String(input.api_number ?? state.apiNumber ?? ""),
        input.operator_number ? String(input.operator_number) : state.operatorNumber,
      );
      sourceName = "fetch_inactive_well_status";
      break;

    case "get_orphan_well":
      result = await ewa.getOrphanWell(String(input.api_number ?? state.apiNumber ?? ""));
      sourceName = "fetch_orphan_well";
      break;

    case "get_compliance_violations":
      result = await browser.getComplianceViolations(
        input.operator_number ? String(input.operator_number) : state.operatorNumber,
        input.api_number      ? String(input.api_number)      : state.apiNumber,
      );
      sourceName = "fetch_compliance_violations";
      break;

    case "get_severance_records":
      result = await ewa.getSeveranceRecords(
        input.lease_number ? String(input.lease_number) : state.leaseNumber,
        input.district     ? String(input.district)     : state.district,
      );
      sourceName = "fetch_severance_records";
      break;

    case "get_injection_records":
      result = await ewa.getInjectionRecords(
        String(input.api_number ?? state.apiNumber ?? ""),
        input.operator_number ? String(input.operator_number) : state.operatorNumber,
      );
      sourceName = "fetch_injection_records";
      break;

    case "get_drilling_permits":
      result = await ewa.getDrillingPermits(String(input.api_number ?? state.apiNumber ?? ""));
      sourceName = "fetch_drilling_permits";
      break;

    case "get_coda_documents":
      result = await browser.getCodaDocuments(String(input.api_number ?? state.apiNumber ?? ""));
      sourceName = "fetch_coda_records";
      break;

    case "get_county_records":
      result = await countyRecords.getCountyRecords(
        String(input.county ?? state.county ?? ""),
        String(input.search_value ?? state.operatorName ?? ""),
      );
      sourceName = "fetch_county_records";
      break;

    case "get_gis_location":
      result = await ewa.getGisLocation(String(input.api_number ?? state.apiNumber ?? ""));
      sourceName = "fetch_gis_plat";
      break;

    case "submit_report":
      result = { submitted: true };
      break;

    default:
      result = { error: `Unknown tool: ${name}` };
  }

  // Persist the attempt
  const resultData = result as Record<string, unknown>;
  const count =
    Array.isArray(resultData?.["wells"])      ? (resultData["wells"]      as unknown[]).length :
    Array.isArray(resultData?.["records"])    ? (resultData["records"]    as unknown[]).length :
    Array.isArray(resultData?.["violations"]) ? (resultData["violations"] as unknown[]).length :
    Array.isArray(resultData?.["rows"])       ? (resultData["rows"]       as unknown[]).length :
    Array.isArray(resultData?.["documents"])  ? (resultData["documents"]  as unknown[]).length :
    Array.isArray(resultData?.["permits"])    ? (resultData["permits"]    as unknown[]).length :
    resultData?.["found"] === true ? 1 : 0;

  const isOk = resultData?.["error"] == null && name !== "submit_report";

  await supabase.from("trrc_source_attempts").upsert({
    run_id:           runId,
    source_id:        `${sourceName}_${callIndex}`,
    source_name:      sourceName,
    status:           isOk ? "success" : "failed_transient",
    result_count:     count,
    error_message:    isOk ? null : String(resultData?.["error"] ?? resultData?.["message"] ?? ""),
    attempted_at:     new Date().toISOString(),
    result_data_json: name === "submit_report" ? input : result,
  }, { onConflict: "run_id,source_id", ignoreDuplicates: false }).then(null, () => {});

  await logStep(supabase, runId, name, isOk ? "done" : "failed", String(
    (resultData?.["message"] ?? resultData?.["error"] ?? "ok") as string
  ).slice(0, 120));

  return result;
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

export async function runLandmanAgent(
  runId:   string,
  input:   string,
  supabase: SupabaseClient,
): Promise<void> {
  const state: AgentState = {
    apiNumber:      null,
    leaseNumber:    null,
    district:       null,
    operatorName:   null,
    operatorNumber: null,
    county:         null,
    production:     [],
  };

  // Pre-seed from run record
  const { data: runRow } = await supabase
    .from("trrc_due_diligence_runs")
    .select("resolved_primary_api,resolved_lease_number,resolved_district,resolved_operator_number,operator_name")
    .eq("id", runId)
    .single();

  if (runRow) {
    state.apiNumber      = runRow["resolved_primary_api"]     ?? null;
    state.leaseNumber    = runRow["resolved_lease_number"]    ?? null;
    state.district       = runRow["resolved_district"]        ?? null;
    state.operatorNumber = runRow["resolved_operator_number"] ?? null;
    state.operatorName   = runRow["operator_name"]            ?? null;
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Research this TRRC asset thoroughly and produce a complete due diligence report.

INPUT: ${input}
${state.apiNumber      ? `API Number: ${state.apiNumber}` : ""}
${state.leaseNumber    ? `Lease Number: ${state.leaseNumber}` : ""}
${state.district       ? `District: ${state.district}` : ""}
${state.operatorName   ? `Operator: ${state.operatorName}` : ""}

Work through every applicable TRRC source. If one path fails, try another. Do not submit your report until you have attempted production history.`,
    },
  ];

  let stepCount = 0;
  let toolCallIndex = 0;
  const MAX_STEPS = 60;
  let finalReport: Record<string, unknown> | null = null;

  await reportProgress(supabase, runId, 5, "running");

  while (stepCount < MAX_STEPS) {
    stepCount++;

    const response = await anthropic.messages.create({
      model:      "claude-fable-5",
      max_tokens: 8192,
      system:     SYSTEM_PROMPT,
      tools:      TRRC_TOOLS,
      messages,
    });

    // Add assistant response to message history
    messages.push({ role: "assistant", content: response.content });

    // Progress update
    const progressPct = Math.min(90, 5 + Math.round((stepCount / MAX_STEPS) * 85));
    await reportProgress(supabase, runId, progressPct, "running");

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason !== "tool_use") break;

    // Check for cancellation between steps so a cancelled run is not
    // overwritten with "complete" at the end of the loop.
    const { data: statusCheck } = await supabase
      .from("trrc_due_diligence_runs")
      .select("status")
      .eq("id", runId)
      .single();
    if (statusCheck?.["status"] === "cancelled") return;

    // Execute all tool calls in this response
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const toolName  = block.name;
      const toolInput = block.input as Record<string, unknown>;
      toolCallIndex++;

      try {
        const result = await dispatchTool(toolName, toolInput, state, runId, supabase, toolCallIndex);

        if (toolName === "submit_report") {
          finalReport = toolInput as Record<string, unknown>;
        }

        toolResults.push({
          type:       "tool_result",
          tool_use_id: block.id,
          content:    JSON.stringify(result),
        });
      } catch (err) {
        toolResults.push({
          type:        "tool_result",
          tool_use_id: block.id,
          content:     JSON.stringify({ error: String(err) }),
          is_error:    true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (finalReport) break;
  }

  // Persist production rows
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

    // Conflict key excludes api_number because it may be NULL;
    // PostgreSQL NULL != NULL in unique indexes so upsert would insert
    // duplicates instead of deduplicating.
    await supabase.from("trrc_production_monthly").upsert(prodRows, {
      onConflict: "run_id,entity_type,district,lease_number,production_month",
      ignoreDuplicates: true,
    }).then(null, () => {});
  }

  // Build coverage from attempts
  const { data: attempts } = await supabase
    .from("trrc_source_attempts")
    .select("source_name,status,result_count,result_data_json")
    .eq("run_id", runId);

  const successCount = (attempts ?? []).filter(a => a["status"] === "success").length;
  const totalCount   = (attempts ?? []).length;

  const didComplete = finalReport !== null;

  // Guard against clobbering a cancellation that landed after the last
  // in-loop check (e.g. during the final end_turn response or the last
  // tool execution) — .neq("status", "cancelled") makes this update a
  // no-op if the run was cancelled in that window.
  await supabase.from("trrc_due_diligence_runs").update({
    status:                   didComplete ? "complete" : "failed",
    progress_percent:         didComplete ? 100 : 90,
    completed_at:             new Date().toISOString(),
    updated_at:               new Date().toISOString(),
    resolved_primary_api:     state.apiNumber,
    resolved_district:        state.district,
    resolved_lease_number:    state.leaseNumber,
    resolved_operator_number: state.operatorNumber,
    result_summary:           didComplete
      ? `${successCount} of ${totalCount} sources retrieved. ${state.production.length} production months found.`
      : null,
    error_summary:            didComplete
      ? null
      : `Agent exhausted ${MAX_STEPS} steps without submitting a report. ${successCount} of ${totalCount} sources retrieved.`,
  }).eq("id", runId).neq("status", "cancelled");
}
