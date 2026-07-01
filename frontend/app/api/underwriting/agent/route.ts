/**
 * POST /api/underwriting/agent — Agentic Underwriting Pipeline (SSE)
 *
 * Replaces the hardcoded 10-step pipeline with Claude as the analyst.
 * Claude receives the acquisition documents + known identifiers, then
 * decides what to look up in TRRC, handles failures by trying alternate
 * queries, cross-checks every seller claim against verified data, and
 * submits findings when done.
 *
 * SSE event format:  data: <JSON>\n\n
 *   { type: "progress", step: string, detail: string, status: "running"|"complete"|"failed" }
 *   { type: "report",   report: DDReport }
 *   { type: "error",    message: string }
 */

import { NextRequest }                           from "next/server";
import { createSupabaseFromRouteRequest }        from "@/lib/supabase/from-route-request";
import { fetchTrialStatus }                      from "@/lib/trial/trial-status";
import { runAgentLoop }                          from "@/lib/underwriting/agent/loop";
import { buildDDReport }                         from "@/lib/underwriting/report-builder";
import { extractUnderwritingDataFromDocuments }  from "@/lib/underwriting/document-extraction";
import { fetchFinancialContext }                 from "@/lib/underwriting/financial-lookup";
import { getBenchmarkFromCounty }                from "@/lib/underwriting/benchmarks";
import type { UnderwritingInput }                from "@/lib/underwriting/types";
import type { TrrcWellProduction }               from "@/lib/underwriting/report-builder";
import type { AgentContext }                     from "@/lib/underwriting/agent/tool-handlers";

export const runtime     = "nodejs";
export const dynamic     = "force-dynamic";
export const maxDuration = 300;

const enc = new TextEncoder();

function sse(data: object): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req: NextRequest): Promise<Response> {
  // Auth gate
  const supabase = await createSupabaseFromRouteRequest(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return new Response(JSON.stringify({ ok: false, error: "Not authenticated." }), { status: 401 });
  }
  const trialStatus = await fetchTrialStatus(supabase, user.id);
  if (trialStatus.state === "expired" || trialStatus.state === "no_trial") {
    return new Response(JSON.stringify({ ok: false, error: "Subscription required." }), { status: 402 });
  }

  const body = (await req.json().catch(() => ({}))) as UnderwritingInput;

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  runAgent(writer, body).catch(async (err) => {
    try {
      await writer.write(sse({ type: "error", message: String(err) }));
    } catch { /* ignore */ }
    try { await writer.close(); } catch { /* ignore */ }
  });

  return new Response(readable, {
    headers: {
      "Content-Type":      "text/event-stream; charset=utf-8",
      "Cache-Control":     "no-cache, no-transform",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function runAgent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  input:  UnderwritingInput,
): Promise<void> {
  const t0 = Date.now();

  // Step 1: Document extraction (still use AI to pull text + identifiers from PDFs)
  // This runs BEFORE the agent loop so Claude has the full document context
  let extracted: Awaited<ReturnType<typeof extractUnderwritingDataFromDocuments>> | null = null;

  if (input.documents && input.documents.length > 0) {
    await writer.write(sse({ type: "progress", step: "parse_documents", status: "running", label: "Reading acquisition documents…" }));
    try {
      extracted = await extractUnderwritingDataFromDocuments(input.documents);

      // Merge extracted identifiers into input so the agent can see them
      if (extracted?.api_numbers?.length) {
        input.api_numbers = [...(input.api_numbers ?? []), ...extracted.api_numbers]
          .filter((v, i, a) => v && a.indexOf(v) === i);
      }
      if (extracted?.rrc_lease_numbers?.length) {
        input.rrc_lease_numbers = [...(input.rrc_lease_numbers ?? []), ...extracted.rrc_lease_numbers]
          .filter((v, i, a) => v && a.indexOf(v) === i);
      }
      if (!input.operator_name && extracted?.operator_name) input.operator_name = extracted.operator_name;
      if (!input.county && extracted?.county)               input.county        = extracted.county;

      await writer.write(sse({
        type: "progress", step: "parse_documents", status: "complete",
        label: "Documents parsed",
        detail: [
          input.documents.length + " document(s)",
          input.api_numbers?.length ? input.api_numbers.length + " API(s) found" : null,
          input.rrc_lease_numbers?.length ? input.rrc_lease_numbers.length + " lease(s) found" : null,
          input.operator_name ? "Operator: " + input.operator_name : null,
        ].filter(Boolean).join(" · "),
      }));
    } catch (err) {
      await writer.write(sse({ type: "progress", step: "parse_documents", status: "failed", label: "Document parsing failed", detail: String(err) }));
    }
  }

  // Step 2: Run the agentic investigation
  await writer.write(sse({ type: "progress", step: "agent_init", status: "running", label: "Starting AI investigation…", detail: "Claude is analyzing the documents and beginning TRRC queries" }));

  let agentCtx: AgentContext | null = null;

  try {
    agentCtx = await runAgentLoop(input, (event) => {
      if (event.type === "tool_call") {
        writer.write(sse({
          type:   "progress",
          step:   event.tool,
          status: "complete",
          label:  labelForTool(event.tool),
          detail: event.summary,
        })).catch(() => {/* ignore write errors mid-stream */});
      } else if (event.type === "error") {
        writer.write(sse({ type: "progress", step: "agent", status: "failed", label: "Investigation incomplete", detail: event.message }))
          .catch(() => {});
      }
    });
  } catch (err) {
    await writer.write(sse({ type: "error", message: `Agent loop failed: ${String(err)}` }));
    await writer.close();
    return;
  }

  if (!agentCtx?.agentAssessment) {
    await writer.write(sse({ type: "error", message: "Agent did not complete the investigation. Please try again." }));
    await writer.close();
    return;
  }

  // Step 3: Assemble DDReport from TRRC data + agent assessment
  await writer.write(sse({ type: "progress", step: "build_report", status: "running", label: "Assembling report…" }));

  try {
    // Fetch supplemental data in parallel
    const [financialContext, benchmark] = await Promise.all([
      fetchFinancialContext(input.operator_name ?? null).catch(() => null),
      (input.county ? getBenchmarkFromCounty(input.county) : null),
    ]);

    // Build agent-sourced "extracted" object — seller's stated claims for cross-check
    // This is kept SEPARATE from the verified TRRC data so the report builder
    // can show both columns: what seller claimed vs what TRRC shows.
    const agentExtracted = buildExtractedFromAgent(extracted, agentCtx);

    // Convert agent context to BuildReportArgs format
    const trrcWells = buildTrrcWellsFromContext(agentCtx);

    const report = buildDDReport({
      input:               { ...input, documents: input.documents ?? [] },
      extracted:           agentExtracted,
      trrcWells,
      trrcViolations:      agentCtx.trrcViolations,
      trrcInjection:       [],
      trrcInspections:     agentCtx.trrcInspections,
      trrcCompletions:     agentCtx.trrcCompletions ?? [],
      financialContext:    financialContext ?? undefined,
      benchmark:           benchmark ?? undefined,
      nriOverride:         input.nri_decimal ?? undefined,
      wiOverride:          input.wi_decimal ?? undefined,
      processingTimeMs:    Date.now() - t0,
      aiModel:             "claude-opus-4-8 (agentic)",
      scanMode:            "full",
      trrcOperatorProfile: agentCtx.trrcOperatorProfile ?? undefined,
      trrcP5Status:        agentCtx.trrcP5Status ?? undefined,
      leaseWellInventory:  agentCtx.leaseWellInventory ?? undefined,
      // Patch agent's narrative + assessment into report fields
    });

    // Overlay the agent's narrative and cross-check findings onto the report
    const enrichedReport = overlayAgentAssessment(report, agentCtx);

    await writer.write(sse({ type: "progress", step: "build_report", status: "complete", label: "Report assembled", detail: `${agentCtx.trrcViolations.length} violations · ${agentCtx.trrcProductionRows.length} months of production · ${agentCtx.leaseWellInventory?.wells.length ?? "?"} wells` }));
    await writer.write(sse({ type: "report", report: enrichedReport }));
  } catch (err) {
    await writer.write(sse({ type: "error", message: `Report assembly failed: ${String(err)}` }));
  } finally {
    await writer.close();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function labelForTool(tool: string): string {
  const labels: Record<string, string> = {
    verify_api:                "Verifying API number in TRRC",
    fetch_production_by_lease: "Pulling lease production from TRRC",
    fetch_wellbore_count:      "Counting wells on lease",
    fetch_operator_compliance: "Checking operator compliance history",
    fetch_p5_status:           "Checking operator bond status",
    fetch_completions:         "Fetching well completion records",
    fetch_production_by_api:   "Pulling well production by API",
    search_operator_leases:    "Searching operator lease portfolio",
    submit_report:             "Compiling investigation findings",
  };
  return labels[tool] ?? tool;
}

function buildTrrcWellsFromContext(ctx: AgentContext): TrrcWellProduction[] {
  if (ctx.trrcProductionRows.length === 0) return [];

  const rows = ctx.trrcProductionRows;
  const totalOil = rows.reduce((s, r) => s + (r.oil_bbl ?? 0), 0);
  const sorted   = [...rows].sort((a, b) => b.year !== a.year ? b.year - a.year : b.month - a.month);
  const latest   = sorted[0];
  const latestProductionMonth = latest
    ? `${latest.year}-${String(latest.month).padStart(2, "0")}`
    : null;

  return [{
    api:                    ctx.verifiedApis[0] ?? "",
    well_name:              ctx.trrcLeaseNo ?? "Unknown Lease",
    lease_number:           ctx.trrcLeaseNo ?? null,
    district_code:          ctx.trrcDistCode ?? null,
    operator:               null,
    latest_monthly_oil_bbl: latest?.oil_bbl ?? 0,
    latest_production_month: latestProductionMonth,
    cum_oil_bbl:            totalOil,
    monthly_rows:           rows.map(r => ({
      year:      r.year,
      month:     r.month,
      oil_bbl:   r.oil_bbl,
      gas_mcf:   r.gas_mcf ?? 0,
      water_bbl: null,
    })),
  }];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildExtractedFromAgent(
  originalExtracted: any | null,
  ctx: AgentContext,
) {
  // Use original document extraction but CLEAR any production_months
  // so the report builder uses TRRC data (ctx) not seller's numbers.
  // Seller production claims are tracked separately via seller_claim_crosschecks.
  if (!originalExtracted) return null;
  return {
    ...originalExtracted,
    // Clear seller production months so report builder uses TRRC, not these
    production_months: ctx.trrcProductionRows.length > 0 ? [] : originalExtracted.production_months,
  };
}

function overlayAgentAssessment(
  report: import("@/lib/underwriting/types").DDReport,
  ctx: AgentContext,
): import("@/lib/underwriting/types").DDReport {
  const assessment = ctx.agentAssessment;
  if (!assessment) return report;

  // Override the IC memo with agent's narrative
  const agentNarrative = assessment.ic_memo_paragraphs.length > 0
    ? assessment.ic_memo_paragraphs
    : report.underwriting_narrative;

  // Append red flags and data gaps as additional memo paragraphs
  const redFlagPara = assessment.red_flags.length > 0
    ? `⚠️ RED FLAGS: ${assessment.red_flags.join(" | ")}`
    : null;
  const gapPara = assessment.data_gaps.length > 0
    ? `DATA GAPS: ${assessment.data_gaps.join(" | ")}`
    : null;

  const narrative = [
    ...agentNarrative,
    ...(redFlagPara ? [redFlagPara] : []),
    ...(gapPara ? [gapPara] : []),
  ];

  return {
    ...report,
    underwriting_narrative: narrative,
    executive_summary: {
      ...report.executive_summary,
      recommendation: {
        ...report.executive_summary.recommendation,
        value: assessment.recommendation,
      },
      recommendation_rationale: assessment.recommendation_rationale,
      overall_risk_score: {
        ...report.executive_summary.overall_risk_score,
        value: assessment.risk_score,
      },
      top_risks:    assessment.top_risks.length    > 0 ? assessment.top_risks    : report.executive_summary.top_risks,
      value_drivers: assessment.value_drivers.length > 0 ? assessment.value_drivers : report.executive_summary.value_drivers,
    },
    // Embed seller claim crosschecks into truth_check section
    truth_check: {
      ...report.truth_check,
      agent_crosschecks: assessment.seller_claim_crosschecks,
      invalid_apis: ctx.invalidApis,
      compliance_queried: ctx.complianceQueried,
    } as typeof report.truth_check & { agent_crosschecks: typeof assessment.seller_claim_crosschecks; invalid_apis: string[]; compliance_queried: boolean },
  };
}
