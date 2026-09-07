/**
 * POST /api/trrc/title-chain/[jobId]/tracts — tract confirmation.
 *
 * Body:
 *   { confirm?: string[]; reject?: string[];            // canonical tract ids
 *     associations?: Array<{ id: string; reviewStatus: "confirmed" | "rejected" }>;
 *     manual?: { legalDescriptionText: string; county?: string; wellId?: string | null } }
 *
 * A manual tract is a user-supplied legal description (the fallback when
 * automated discovery cannot establish the tract). It is created as a
 * confirmed tract with a "user_supplied" association when a well is named.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { parseTexasLegalDescription, normalizeAbstractNumber } from "@/lib/trrc/offset-analytics/legal-description";
import { tractLabelFor } from "@/lib/trrc/title/tract-candidates";
import { tractToRow } from "@/lib/trrc/title/job-store";
import type { CandidateTract } from "@/lib/trrc/title/chain-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  confirm?: unknown; reject?: unknown; associations?: unknown;
  manual?: { legalDescriptionText?: unknown; county?: unknown; wellId?: unknown };
}

const ids = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;

  const { data: job } = await supabase.from("title_research_jobs").select("id, status").eq("id", jobId).eq("user_id", user.id).maybeSingle();
  if (!job) return NextResponse.json({ ok: false, error: "Job not found or access denied." }, { status: 404 });

  let body: Body;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 }); }

  const confirm = ids(body.confirm), reject = ids(body.reject);
  if (confirm.length > 0) await supabase.from("title_canonical_tracts").update({ match_status: "confirmed", needs_user_selection: false }).eq("job_id", jobId).in("id", confirm);
  if (reject.length > 0) await supabase.from("title_canonical_tracts").update({ match_status: "rejected", needs_user_selection: false }).eq("job_id", jobId).in("id", reject);
  if (confirm.length > 0) await supabase.from("title_well_tract_associations").update({ review_status: "confirmed", reviewed_at: new Date().toISOString() }).eq("job_id", jobId).in("canonical_tract_id", confirm).eq("review_status", "proposed");
  if (reject.length > 0) await supabase.from("title_well_tract_associations").update({ review_status: "rejected", reviewed_at: new Date().toISOString() }).eq("job_id", jobId).in("canonical_tract_id", reject);

  if (Array.isArray(body.associations)) {
    for (const a of body.associations as Array<{ id?: unknown; reviewStatus?: unknown }>) {
      if (typeof a.id !== "string" || (a.reviewStatus !== "confirmed" && a.reviewStatus !== "rejected")) continue;
      await supabase.from("title_well_tract_associations").update({ review_status: a.reviewStatus, reviewed_at: new Date().toISOString() }).eq("job_id", jobId).eq("id", a.id);
    }
  }

  let createdTract: CandidateTract | null = null;
  if (body.manual && typeof body.manual.legalDescriptionText === "string" && body.manual.legalDescriptionText.trim()) {
    const text = body.manual.legalDescriptionText.trim().slice(0, 2000);
    const county = typeof body.manual.county === "string" && body.manual.county.trim() ? body.manual.county.trim() : null;
    const parsed = parseTexasLegalDescription(text);
    const fields = {
      county: parsed?.county ?? county, abstractNumber: parsed?.canonicalAbstractNumber ?? normalizeAbstractNumber(text), surveyName: parsed?.surveyName ?? null,
      blockNumber: parsed?.block ?? null, sectionName: parsed?.section ?? null, legalDescription: text, grossAcres: parsed?.grossAcres ?? null,
    };
    createdTract = {
      id: randomUUID(), tractLabel: tractLabelFor(fields), ...fields, confidence: 0.7, resolutionMethod: "user_supplied_legal_description",
      resolutionTrace: ["Legal description entered by the user"], needsUserSelection: false, matchStatus: "confirmed",
    };
    const { error } = await supabase.from("title_canonical_tracts").insert({ ...tractToRow(createdTract, jobId), source_json: [{ kind: "user_supplied", text }] });
    if (error) return NextResponse.json({ ok: false, error: `Could not create tract: ${error.message}` }, { status: 500 });
    const wellId = typeof body.manual.wellId === "string" ? body.manual.wellId : null;
    if (wellId) {
      await supabase.from("title_well_tract_associations").insert({
        job_id: jobId, user_id: user.id, well_id: wellId, canonical_tract_id: createdTract.id, association_type: "user_supplied", confidence: 0.7,
        evidence_json: [{ documentId: null, instrumentId: null, page: null, excerpt: text.slice(0, 300), sourceUrl: null, label: "User-supplied legal description" }],
        review_status: "confirmed", reviewed_at: new Date().toISOString(),
      });
    }
  }

  // Advance the job once at least one tract is confirmed.
  const { count } = await supabase.from("title_canonical_tracts").select("id", { count: "exact", head: true }).eq("job_id", jobId).eq("match_status", "confirmed");
  if ((count ?? 0) > 0 && ["awaiting_tract_confirmation", "pending"].includes(job.status as string)) {
    await supabase.from("title_research_jobs").update({ status: "awaiting_documents", stage_detail: "Tract confirmed — retrieve, upload, or paste instruments, then run the analysis" }).eq("id", jobId);
  }

  return NextResponse.json({ ok: true, data: { confirmed: confirm.length, rejected: reject.length, createdTract } });
}
