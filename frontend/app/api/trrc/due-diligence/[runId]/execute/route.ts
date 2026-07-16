/**
 * POST /api/trrc/due-diligence/[runId]/execute
 *
 * Workhorse route: runs the full TRRC agentic investigation for an existing run.
 * Called separately from the initial POST so that initial POST returns fast.
 *
 * Flow:
 *   1. Auth + ownership check
 *   2. Load run + resolved entities from DB
 *   3. Run TrrcAgentLoop (claude-fable-5) — agent investigates TRRC, emits progress events
 *   4. Take ctx.agentReport from the completed agent context
 *   5. Persist findings to trrc_due_diligence_findings (evidence_json column)
 *   6. Persist production rows to trrc_production_monthly
 *   7. Build manifest, PDF, ZIP using existing builders
 *   8. Upload to Supabase Storage
 *   9. Update run status to "complete"
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { runTrrcAgentLoop } from "@/lib/trrc/agent/loop";
import type { TrrcAgentContext } from "@/lib/trrc/agent/tool-handlers";
import { buildManifest } from "@/lib/trrc/manifest-builder";
import { buildTrrcPdfReport } from "@/lib/trrc/report-builder";
import { buildTrrcZipArchive } from "@/lib/trrc/archive-builder";
import { normalizeApiNumber } from "@/lib/trrc/normalization";
import type {
  TrrcDueDiligenceRun,
  ResolvedEntity,
  TrrcFinding,
  AcquisitionScorecard,
  TrrcDDProductionRow,
  ResolvedSearchContext,
  NormalizedApi,
  SourceCoverageStatus,
} from "@/lib/trrc/types";
import type { OrchestratorResult } from "@/lib/trrc/retrieval-orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─── Status guard ──────────────────────────────────────────────────────────────

const TERMINAL_OR_RUNNING = [
  "complete",
  "failed",
  "cancelled",
  "analyzing",
  "generating",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildNormalizedApi(api10: string): NormalizedApi {
  const state_code  = api10.slice(0, 2);
  const county_code = api10.slice(2, 5);
  const well_code   = api10.slice(5, 10);
  return {
    raw: api10,
    api10,
    api14: `${api10}0000`,
    formatted: `${state_code}-${county_code}-${well_code}-00-00`,
    state_code,
    county_code,
    well_code,
    is_texas: state_code === "42",
  };
}

function buildNormalizedApiFromRaw(raw: string): NormalizedApi | null {
  // normalizeApiNumber from @/lib/trrc/normalization returns NormalizedApi | null
  const norm = normalizeApiNumber(raw);
  if (norm) return norm;
  // Last-ditch: strip non-digits and check length
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("42")) {
    return buildNormalizedApi(digits);
  }
  return null;
}

function makeId(): string {
  return `finding_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Map the agent's recommendation string to a canonical AcquisitionRecommendation value.
 * The agent uses lowercase; the scorecard type uses uppercase.
 */
function mapRecommendation(
  rec: string,
): AcquisitionScorecard["recommendation"] {
  switch (rec.toLowerCase()) {
    case "pursue":  return "PURSUE";
    case "blocked": return "BLOCKED";
    case "pass":    return "PASS";
    default:        return "REVIEW";
  }
}

/**
 * Map agent severity string to TrrcFinding severity.
 * Agent uses "warning" (tool schema), DB uses "medium".
 */
function mapSeverity(sev: string): TrrcFinding["severity"] {
  switch (sev.toLowerCase()) {
    case "critical": return "critical";
    case "warning":  return "medium";
    case "info":     return "info";
    default:         return "info";
  }
}

/**
 * Map agent category string to TrrcRecordCategory.
 */
function mapCategory(cat: string): TrrcFinding["category"] {
  switch (cat.toLowerCase()) {
    case "identity":       return "identity";
    case "production":     return "production";
    case "compliance":     return "compliance";
    case "inactive_well":  return "plugging_inactive";
    case "plugging":       return "plugging_inactive";
    case "mechanical":     return "completion";
    case "operator":       return "operator_p5";
    case "data_gap":       return "miscellaneous";
    default:               return "miscellaneous";
  }
}

/**
 * Convert agent findings to TrrcFinding[] for DB persistence and PDF generation.
 */
function agentFindingsToTrrcFindings(
  agentFindings: Array<{
    category: string;
    severity: string;
    title: string;
    detail: string;
    source_ids: string[];
  }>,
): TrrcFinding[] {
  return agentFindings.map((f) => ({
    id: makeId(),
    category: mapCategory(f.category),
    severity: mapSeverity(f.severity),
    finding_type: `agent_${f.category}`,
    title: f.title,
    description: f.detail,
    evidence: { source_ids: f.source_ids, agent_category: f.category },
    source_record_ids: f.source_ids,
    analytical_method: "agent_synthesis",
    confidence: 0.85,
    recommended_action: "Review finding and cross-check with primary TRRC records.",
    is_directly_reported: true,
  }));
}

/**
 * Build an AcquisitionScorecard from the agent's scorecard output.
 */
function buildScorecardFromAgent(
  agentScorecard: {
    overall_score: number;
    dimensions: Array<{
      id: string;
      name: string;
      score: number;
      weight: number;
      key_finding: string;
    }>;
  },
  recommendation: AcquisitionScorecard["recommendation"],
  findings: TrrcFinding[],
  dataGaps: string[],
): AcquisitionScorecard {
  const DEFAULT_DIMS = [
    { id: "record_completeness",    name: "Record Completeness",    weight: 0.10 },
    { id: "identity_confidence",    name: "Identity Confidence",    weight: 0.12 },
    { id: "production_quality",     name: "Production Quality",     weight: 0.15 },
    { id: "production_consistency", name: "Production Consistency", weight: 0.13 },
    { id: "mechanical_integrity",   name: "Mechanical Integrity",   weight: 0.08 },
    { id: "plugging_exposure",      name: "Plugging Exposure",      weight: 0.10 },
    { id: "regulatory_compliance",  name: "Regulatory Compliance",  weight: 0.12 },
    { id: "operator_profile",       name: "Operator Profile",       weight: 0.08 },
    { id: "development_activity",   name: "Development Activity",   weight: 0.07 },
    { id: "data_confidence",        name: "Data Confidence",        weight: 0.05 },
  ] as const;

  type DimKey = keyof AcquisitionScorecard["dimensions"];

  // Build a map from the agent's dimension array
  const dimMap = new Map(agentScorecard.dimensions.map((d) => [d.id, d]));

  const buildDim = (id: string, name: string, weight: number) => {
    const agentDim = dimMap.get(id);
    return {
      label: name,
      score: agentDim?.score ?? 50,
      weight,
      rationale: agentDim?.key_finding ?? "Not assessed.",
      data_points: [],
    };
  };

  const dimensions = {} as AcquisitionScorecard["dimensions"];
  for (const d of DEFAULT_DIMS) {
    (dimensions as Record<DimKey, AcquisitionScorecard["dimensions"][DimKey]>)[d.id as DimKey] = buildDim(d.id, d.name, d.weight);
  }

  // Compute weighted sum for risk/opportunity scores
  const weightedSum = DEFAULT_DIMS.reduce((sum, d) => {
    const score = (dimensions as Record<string, { score: number }>)[d.id]?.score ?? 50;
    return sum + score * d.weight;
  }, 0);

  const overallScore = Math.round(agentScorecard.overall_score ?? weightedSum);

  // Separate findings
  const criticals = findings.filter((f) => f.severity === "critical");
  const highs     = findings.filter((f) => f.severity === "high" || f.severity === "medium");

  const gating_conditions = criticals.map((f) => f.title);
  const missing_critical_evidence = dataGaps.slice(0, 5);

  const reasons_for = findings
    .filter((f) => f.severity === "info")
    .slice(0, 3)
    .map((f) => f.title);

  const reasons_against = criticals
    .slice(0, 3)
    .map((f) => f.title)
    .concat(highs.slice(0, 2).map((f) => f.title))
    .slice(0, 5);

  return {
    dimensions,
    opportunity_score: Math.max(0, Math.min(100, overallScore)),
    risk_score: Math.max(0, Math.min(100, 100 - overallScore + criticals.length * 5)),
    overall_confidence: Math.max(0, Math.min(100, overallScore)),
    recommendation,
    gating_conditions,
    missing_critical_evidence,
    reasons_for,
    reasons_against,
  };
}

/**
 * Convert raw production rows collected in TrrcAgentContext to TrrcDDProductionRow[]
 * suitable for DB persistence and PDF generation.
 */
function buildProductionRows(
  ctx: TrrcAgentContext,
  runId: string,
): TrrcDDProductionRow[] {
  const rows: TrrcDDProductionRow[] = [];
  const seen = new Set<string>();

  for (const raw of ctx.production) {
    // The raw rows come from fetchTrrcProductionByLease or fetchTrrcProductionHistory
    // Both return TrrcMonthlyRow objects: { year, month, oil_bbl, gas_mcf, ... }
    const r = raw as Record<string, unknown>;
    const year  = r["year"]  as number | undefined;
    const month = r["month"] as number | undefined;
    if (!year || !month) continue;

    const productionMonth = `${year}-${String(month).padStart(2, "0")}`;
    const key = `${ctx.lease_number ?? ""}:${ctx.district ?? ""}:${productionMonth}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      entity_type: "lease",
      api_number: ctx.api_numbers[0] ?? null,
      district: ctx.district ?? "",
      lease_number: ctx.lease_number ?? null,
      gas_id: null,
      operator_number: ctx.operator_number ?? null,
      production_month: productionMonth,
      oil_bbl: typeof r["oil_bbl"] === "number" ? r["oil_bbl"] : null,
      casinghead_gas_mcf: null,
      gas_mcf: typeof r["gas_mcf"] === "number" ? r["gas_mcf"] : null,
      condensate_bbl: null,
      water_bbl: typeof r["water_bbl"] === "number" ? r["water_bbl"] : null,
    });
  }

  // Suppress unused-variable warning — runId used for future per-run keys if needed
  void runId;
  return rows;
}

/**
 * Build a minimal OrchestratorResult stub so the existing manifest builder
 * can be called without modification.
 */
function buildOrchestratorStub(
  ctx: TrrcAgentContext,
  production: TrrcDDProductionRow[],
  _findings: TrrcFinding[],
  runId: string,
): OrchestratorResult {
  const coverage: SourceCoverageStatus[] = [
    {
      category: "production",
      label: "Production Records",
      status: ctx.production.length > 0 ? "complete" : "no_applicable_record",
      records_found: production.length,
      data_current_through: null,
      sources_checked: ["fetch_production"],
      notes: ctx.production.length > 0 ? "Retrieved by agent." : "No production data retrieved.",
    },
    {
      category: "compliance",
      label: "Compliance Violations",
      status: ctx.compliance_violations.length > 0 ? "complete" : "partial",
      records_found: ctx.compliance_violations.length,
      data_current_through: null,
      sources_checked: ["fetch_compliance_violations"],
      notes: ctx.compliance_violations.length > 0
        ? `${ctx.compliance_violations.length} violation(s) found.`
        : "Query returned no violations — may be clean or query miss.",
    },
    {
      category: "plugging_inactive",
      label: "Plugging & Inactive Wells",
      status: ctx.plugging_records.length > 0 || ctx.inactive_wells.length > 0 ? "complete" : "no_applicable_record",
      records_found: ctx.plugging_records.length + ctx.inactive_wells.length,
      data_current_through: null,
      sources_checked: ["fetch_plugging_records", "fetch_inactive_well_status"],
      notes: null,
    },
    {
      category: "operator_p5",
      label: "Operator P-5 Record",
      status: ctx.p5_record ? "complete" : "no_applicable_record",
      records_found: ctx.p5_record ? 1 : 0,
      data_current_through: null,
      sources_checked: ["search_by_operator"],
      notes: null,
    },
    {
      category: "completion",
      label: "Completion Records",
      status: ctx.completions.length > 0 ? "complete" : "no_applicable_record",
      records_found: ctx.completions.length,
      data_current_through: null,
      sources_checked: ["fetch_completion_records"],
      notes: null,
    },
  ];

  const totalRecords = coverage.reduce((s, c) => s + c.records_found, 0);

  return {
    run_id: runId,
    production,
    findings_raw: [],
    source_attempts: [],
    coverage,
    total_records_found: totalRecords,
    manual_required_count: 0,
    error: null,
  };
}

// ─── POST ──────────────────────────────────────────────────────────────────────

export async function POST(
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

  // 2. Load run + verify ownership and status
  const { data: runRaw, error: runError } = await supabase
    .from("trrc_due_diligence_runs")
    .select("*")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (runError || !runRaw) {
    return NextResponse.json(
      { ok: false, error: "Run not found or access denied." },
      { status: 404 },
    );
  }

  const runStatus = runRaw["status"] as string;
  if (TERMINAL_OR_RUNNING.includes(runStatus)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "retrieving" or "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  if (runStatus !== "retrieving" && runStatus !== "pending") {
    return NextResponse.json(
      {
        ok: false,
        error: `Run is in status "${runStatus}" — only "retrieving" or "pending" runs can be executed.`,
      },
      { status: 409 },
    );
  }

  // Wrap entire pipeline to never leave run stuck in "retrieving"
  try {
    // 3. Load resolved entities from DB
    const { data: entityRows } = await supabase
      .from("trrc_resolved_entities")
      .select("*")
      .eq("run_id", runId)
      .order("confidence", { ascending: false });

    const entities: ResolvedEntity[] = (entityRows ?? []).map((e) => ({
      id: e["id"] as string,
      entity_type: e["entity_type"] as ResolvedEntity["entity_type"],
      canonical_identifier: e["canonical_identifier"] as string,
      display_name: e["display_name"] as string,
      // DB column is attributes_json
      attributes: (e["attributes_json"] ?? {}) as Record<string, unknown>,
      confidence: e["confidence"] as number,
      resolution_method: e["resolution_method"] as string,
      is_user_selected: e["is_user_selected"] as boolean,
    }));

    // 4. Run agent loop
    let progressCount = 0;

    const agentCtx = await runTrrcAgentLoop(
      {
        raw_input: runRaw["original_input"] as string,
        input_type: runRaw["selected_input_type"] as string,
        resolved_entities: entities.map((e) => ({
          entity_type: e.entity_type,
          canonical_identifier: e.canonical_identifier,
          display_name: e.display_name,
          attributes: e.attributes,
        })),
      },
      async (event) => {
        if (event.type === "tool_call") {
          progressCount++;
          // Scale progress 10% → 85% over MAX_TOOL_CALLS=50 tool calls
          const progressPct = Math.min(85, 10 + progressCount * 1.5);

          await supabase
            .from("trrc_due_diligence_runs")
            .update({
              progress_percent: Math.round(progressPct),
              updated_at: new Date().toISOString(),
            })
            .eq("id", runId);

          console.log(`[trrc-agent] [${runId}] ${event.tool}: ${event.summary}`);
        } else if (event.type === "error") {
          console.error(`[trrc-agent] [${runId}] error: ${event.message}`);
        }
      },
    );

    // 5. Persist discovered identifiers back to the run
    const primaryApi = agentCtx.api_numbers[0] ?? null;
    await supabase
      .from("trrc_due_diligence_runs")
      .update({
        resolved_primary_api: primaryApi,
        resolved_district: agentCtx.district,
        resolved_lease_number: agentCtx.lease_number,
        resolved_operator_number: agentCtx.operator_number,
        status: "analyzing",
        progress_percent: 88,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);

    // Upsert newly discovered wellbore entities so they appear in the report
    if (agentCtx.api_numbers.length > 0) {
      const existingIds = new Set(entities.map((e) => e.canonical_identifier));
      const newEntityRows = agentCtx.api_numbers
        .filter((api) => !existingIds.has(api))
        .map((api) => {
          const norm = buildNormalizedApiFromRaw(api);
          return {
            run_id: runId,
            entity_type: "wellbore",
            canonical_identifier: api,
            display_name: norm ? `API ${norm.formatted}` : `API ${api}`,
            attributes_json: { discovered_by: "trrc_agent" },
            confidence: 0.9,
            resolution_method: "agent_discovery",
            is_user_selected: false,
          };
        });

      if (newEntityRows.length > 0) {
        const { error: entityErr } = await supabase
          .from("trrc_resolved_entities")
          .insert(newEntityRows);
        if (entityErr) {
          console.error("[trrc-agent] entity insert error:", entityErr);
        }
      }
    }

    // 6. Convert agent output to typed findings
    const agentReport = agentCtx.agentReport;
    const agentFindings = agentReport?.findings ?? [];
    const findings: TrrcFinding[] = agentFindingsToTrrcFindings(agentFindings);
    const recommendation = mapRecommendation(agentReport?.recommendation ?? "review");

    // 7. Build scorecard from agent's scorecard output
    const scorecard = buildScorecardFromAgent(
      agentReport?.scorecard ?? { overall_score: 50, dimensions: [] },
      recommendation,
      findings,
      agentReport?.data_gaps ?? [],
    );

    // 8. Persist findings (evidence_json is the DB column name)
    if (findings.length > 0) {
      const findingRows = findings.map((f) => ({
        run_id: runId,
        finding_id: f.id,
        category: f.category,
        severity: f.severity,
        finding_type: f.finding_type,
        title: f.title,
        description: f.description,
        evidence_json: f.evidence,            // DB col: evidence_json
        source_record_ids: f.source_record_ids,
        analytical_method: f.analytical_method,
        confidence: f.confidence,
        recommended_action: f.recommended_action,
        is_directly_reported: f.is_directly_reported,
      }));

      const { error: findingsErr } = await supabase
        .from("trrc_due_diligence_findings")
        .insert(findingRows);
      if (findingsErr) {
        console.error("[trrc-agent] findings insert error:", findingsErr);
      }
    }

    // 9. Build and persist production rows
    const production = buildProductionRows(agentCtx, runId);

    if (production.length > 0) {
      const prodRows = production.map((p) => ({
        run_id: runId,
        entity_type: p.entity_type,
        api_number: p.api_number,
        district: p.district,
        lease_number: p.lease_number,
        gas_id: p.gas_id,
        operator_number: p.operator_number,
        production_month: p.production_month,
        oil_bbl: p.oil_bbl,
        casinghead_gas_mcf: p.casinghead_gas_mcf,
        gas_mcf: p.gas_mcf,
        condensate_bbl: p.condensate_bbl,
        water_bbl: p.water_bbl,
      }));

      const { error: prodErr } = await supabase
        .from("trrc_production_monthly")
        .upsert(prodRows, {
          onConflict: "run_id,entity_type,api_number,lease_number,production_month",
          ignoreDuplicates: true,
        });
      if (prodErr) {
        console.error("[trrc-agent] production upsert error:", prodErr);
      }
    }

    // Mark as generating
    await supabase
      .from("trrc_due_diligence_runs")
      .update({ status: "generating", progress_percent: 93, updated_at: new Date().toISOString() })
      .eq("id", runId);

    // 10. Build run object for builders
    const resolvedEntitiesForRun: ResolvedEntity[] = [
      ...entities,
      ...agentCtx.api_numbers
        .filter((api) => !entities.find((e) => e.canonical_identifier === api))
        .map((api) => {
          const norm = buildNormalizedApiFromRaw(api);
          return {
            id: `agent_${api}`,
            entity_type: "wellbore" as ResolvedEntity["entity_type"],
            canonical_identifier: api,
            display_name: norm ? `API ${norm.formatted}` : `API ${api}`,
            attributes: { discovered_by: "trrc_agent" },
            confidence: 0.9,
            resolution_method: "agent_discovery",
            is_user_selected: false,
          };
        }),
    ];

    const runForBuilders: TrrcDueDiligenceRun = {
      id: runId,
      user_id: user.id,
      original_input: runRaw["original_input"] as string,
      detected_input_type: runRaw["detected_input_type"] as TrrcDueDiligenceRun["detected_input_type"],
      selected_input_type: runRaw["selected_input_type"] as TrrcDueDiligenceRun["selected_input_type"],
      normalized_input: runRaw["normalized_input"] as string,
      status: "complete",
      started_at: runRaw["started_at"] as string,
      completed_at: new Date().toISOString(),
      progress_percent: 100,
      result_summary: null,
      error_summary: null,
      resolved_primary_api: primaryApi,
      resolved_district: agentCtx.district,
      resolved_lease_number: agentCtx.lease_number,
      resolved_gas_id: null,
      resolved_operator_number: agentCtx.operator_number,
      report_storage_path: null,
      archive_storage_path: null,
      manifest_storage_path: null,
      created_at: runRaw["created_at"] as string,
      updated_at: new Date().toISOString(),
      entities: resolvedEntitiesForRun,
    };

    // Build a minimal ResolvedSearchContext for the manifest builder
    const normalizedApis: NormalizedApi[] = agentCtx.api_numbers
      .map(buildNormalizedApiFromRaw)
      .filter((a): a is NormalizedApi => a !== null);

    const searchCtx: ResolvedSearchContext = {
      run_id: runId,
      input_type: runRaw["selected_input_type"] as ResolvedSearchContext["input_type"],
      raw_input: runRaw["original_input"] as string,
      normalized_input: runRaw["normalized_input"] as string,
      api_numbers: normalizedApis,
      district: agentCtx.district,
      lease_number: agentCtx.lease_number,
      gas_id: null,
      operator_name: agentCtx.operator_name,
      operator_number: agentCtx.operator_number,
      county: agentCtx.county,
      lease_name: null,
      legal_description: null,
      search_historical: false,
      include_offset_wells: false,
      production_months: 36,
    };

    // Build orchestrator stub for manifest builder
    const orchestratorStub = buildOrchestratorStub(agentCtx, production, findings, runId);

    // 11. Build manifest
    const manifest = buildManifest(
      runForBuilders,
      searchCtx,
      orchestratorStub,
      findings,
      scorecard,
      process.env["npm_package_version"] ?? "1.0.0",
    );

    // 12. Build PDF and ZIP
    const adminClient = createServiceRoleClient();
    let report_storage_path: string | null = null;
    let archive_storage_path: string | null = null;
    let manifest_storage_path: string | null = null;

    const coverage = orchestratorStub.coverage;

    if (adminClient) {
      const baseStoragePath = `trrc-due-diligence/${user.id}/${runId}`;

      // Upload manifest
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
      const { error: manifestErr } = await adminClient.storage
        .from("trrc-due-diligence")
        .upload(`${baseStoragePath}/manifest.json`, manifestBytes, {
          contentType: "application/json",
          upsert: true,
        });
      if (manifestErr) {
        console.error("[trrc-agent] manifest upload error:", manifestErr);
      } else {
        manifest_storage_path = `${baseStoragePath}/manifest.json`;
      }

      // Build and upload PDF
      try {
        const pdfBuffer = await buildTrrcPdfReport(
          runForBuilders,
          manifest,
          findings,
          scorecard,
          production,
          coverage,
        );

        const { error: pdfErr } = await adminClient.storage
          .from("trrc-due-diligence")
          .upload(`${baseStoragePath}/report.pdf`, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true,
          });
        if (pdfErr) {
          console.error("[trrc-agent] PDF upload error:", pdfErr);
        } else {
          report_storage_path = `${baseStoragePath}/report.pdf`;

          // Build and upload ZIP
          try {
            const zipBuffer = await buildTrrcZipArchive(
              runForBuilders,
              manifest,
              pdfBuffer,
              production,
              findings,
              coverage,
            );

            const { error: zipErr } = await adminClient.storage
              .from("trrc-due-diligence")
              .upload(`${baseStoragePath}/archive.zip`, zipBuffer, {
                contentType: "application/zip",
                upsert: true,
              });
            if (zipErr) {
              console.error("[trrc-agent] ZIP upload error:", zipErr);
            } else {
              archive_storage_path = `${baseStoragePath}/archive.zip`;
            }
          } catch (zipBuildErr) {
            console.error("[trrc-agent] ZIP build error:", zipBuildErr);
          }
        }
      } catch (pdfBuildErr) {
        console.error("[trrc-agent] PDF build error:", pdfBuildErr);
      }
    }

    // 13. Update run to complete
    const { error: updateError } = await supabase
      .from("trrc_due_diligence_runs")
      .update({
        status: "complete",
        progress_percent: 100,
        completed_at: new Date().toISOString(),
        resolved_primary_api: primaryApi,
        resolved_district: agentCtx.district,
        resolved_lease_number: agentCtx.lease_number,
        resolved_gas_id: null,
        resolved_operator_number: agentCtx.operator_number,
        scorecard_json: scorecard as unknown as Record<string, unknown>,
        coverage_json: coverage as unknown as Record<string, unknown>[],
        manifest_storage_path,
        report_storage_path,
        archive_storage_path,
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);

    if (updateError) {
      console.error("[trrc-agent] run update error:", updateError);
      return NextResponse.json(
        { ok: false, error: "Pipeline completed but failed to update run status." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      data: { status: "complete", run_id: runId },
    });
  } catch (err) {
    // Error recovery — never leave run stuck in "retrieving"
    console.error("[trrc-agent] unhandled pipeline error:", err);

    try {
      await supabase
        .from("trrc_due_diligence_runs")
        .update({
          status: "failed",
          error_summary: err instanceof Error ? err.message : String(err),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId);
    } catch (updateErr) {
      console.error("[trrc-agent] failed to update run status to failed:", updateErr);
    }

    return NextResponse.json({ ok: false, error: "Pipeline failed." }, { status: 500 });
  }
}
