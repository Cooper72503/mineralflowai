/**
 * GET /api/trrc/title-chain/[jobId] — the full job bundle for the UI:
 * job, wells, candidate tracts + associations, documents, review queue,
 * search coverage, and the latest analysis summary.
 *
 * Candidate-tract proposal happens here lazily, once, when the worker has
 * finished well resolution and no associations exist yet. The proposal is
 * deterministic (tract-candidates.ts) and keyed by legal-description
 * components, so repeated polls never create duplicate tracts.
 *
 * POST — cancel the job.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { loadJobBundle, tractToRow } from "@/lib/trrc/title/job-store";
import { proposeTracts } from "@/lib/trrc/title/tract-candidates";
import type { TitleChainAnalysis } from "@/lib/trrc/title/chain-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

  const { jobId } = await params;
  let bundle = await loadJobBundle(supabase, jobId, user.id);
  if (!bundle) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });

  const resolvedWells = bundle.wells.filter(w => w.resolutionStatus === "resolved");
  const needsProposal = ["awaiting_tract_confirmation", "awaiting_documents"].includes(bundle.job.status) && bundle.associations.length === 0 && resolvedWells.length > 0;
  if (needsProposal) {
    const proposal = proposeTracts({ wells: bundle.wells, documentLegals: [], existingTracts: bundle.tracts });
    const newTracts = proposal.tracts.filter(t => !bundle!.tracts.some(x => x.id === t.id));
    if (newTracts.length > 0) await supabase.from("title_canonical_tracts").insert(newTracts.map(t => tractToRow(t, jobId)));
    for (const t of proposal.tracts.filter(t => bundle!.tracts.some(x => x.id === t.id))) {
      await supabase.from("title_canonical_tracts").update({ resolution_trace: t.resolutionTrace, confidence: t.confidence }).eq("id", t.id);
    }
    if (proposal.associations.length > 0) {
      await supabase.from("title_well_tract_associations").upsert(proposal.associations.map(a => ({
        job_id: jobId, user_id: user.id, well_id: a.wellId, canonical_tract_id: a.canonicalTractId, association_type: a.associationType,
        confidence: a.confidence, evidence_json: a.evidence, review_status: "proposed",
      })), { onConflict: "well_id,canonical_tract_id,association_type", ignoreDuplicates: true });
    }
    bundle = (await loadJobBundle(supabase, jobId, user.id)) ?? bundle;
  }

  const latest = bundle.latestAnalysis;
  const analysis = latest ? (latest.analysis_json as TitleChainAnalysis) : null;

  return NextResponse.json({
    ok: true,
    data: {
      job: bundle.job,
      wells: bundle.wells,
      tracts: bundle.tracts,
      associations: bundle.associations,
      documents: bundle.documents,
      reviewItems: bundle.reviewItems,
      searchLog: bundle.searchLog,
      latestAnalysis: analysis ? { id: latest!.id, version: latest!.version, status: latest!.status_classification, generatedAt: analysis.generatedAt, findingCount: analysis.findings.length } : null,
    },
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;
  let body: { action?: string } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  if (body.action !== "cancel") return NextResponse.json({ ok: false, error: "Unsupported action." }, { status: 400 });
  const { data, error } = await supabase.from("title_research_jobs").update({ status: "cancelled", stage_detail: "Cancelled by user" })
    .eq("id", jobId).eq("user_id", user.id).in("status", ["pending", "resolving_wells", "searching_records"]).select("id");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data || data.length === 0) return NextResponse.json({ ok: false, error: "Job is not in a cancellable state." }, { status: 409 });
  return NextResponse.json({ ok: true });
}
