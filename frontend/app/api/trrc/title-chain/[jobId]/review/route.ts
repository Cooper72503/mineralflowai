/**
 * POST /api/trrc/title-chain/[jobId]/review — resolve a review-queue item.
 *
 * Body: { itemId, action: "resolve" | "dismiss", resolution?: {...} }
 *   identity_match  resolution.sameParty: boolean — true merges the two
 *                   parties' canonical ids (B -> A); false records them as
 *                   distinct (nothing else changes).
 *   tract_match     resolution.canonicalTractId: string — links the
 *                   instrument's unlinked tracts/claims to that tract;
 *                   resolution.reject: true rejects the proposed tract.
 *   others          resolution is stored for the record only.
 * Resolving an item does not re-run analysis; the next analysis picks up
 * the changed state through its fingerprint.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;

  let body: { itemId?: unknown; action?: unknown; resolution?: Record<string, unknown> };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 }); }
  if (typeof body.itemId !== "string" || (body.action !== "resolve" && body.action !== "dismiss")) {
    return NextResponse.json({ ok: false, error: "itemId and action (resolve|dismiss) are required." }, { status: 400 });
  }
  const resolution = body.resolution ?? {};

  const { data: item } = await supabase.from("title_review_items").select("*").eq("id", body.itemId).eq("job_id", jobId).eq("user_id", user.id).maybeSingle();
  if (!item) return NextResponse.json({ ok: false, error: "Review item not found." }, { status: 404 });
  if (item.status !== "open") return NextResponse.json({ ok: false, error: "Review item is already closed." }, { status: 409 });

  const payload = (item.payload_json ?? {}) as Record<string, unknown>;
  const applied: string[] = [];

  if (body.action === "resolve") {
    if (item.kind === "identity_match" && resolution.sameParty === true && typeof payload.partyIdA === "string" && typeof payload.partyIdB === "string") {
      const { data: a } = await supabase.from("title_instrument_parties").select("canonical_party_id").eq("id", payload.partyIdA).maybeSingle();
      const { data: b } = await supabase.from("title_instrument_parties").select("canonical_party_id").eq("id", payload.partyIdB).maybeSingle();
      const target = (a?.canonical_party_id as string | null) ?? null;
      const source = (b?.canonical_party_id as string | null) ?? null;
      if (target && source && target !== source) {
        await supabase.from("title_instrument_parties").update({ canonical_party_id: target }).eq("job_id", jobId).eq("canonical_party_id", source);
        await supabase.from("title_party_aliases").insert({ canonical_party_id: target, job_id: jobId, run_id: null, alias_name: String(payload.nameB ?? ""), source_instrument_party_id: payload.partyIdB });
        await supabase.from("title_canonical_parties").update({ match_status: "confirmed", resolution_method: "user_confirmed_identity" }).eq("id", target);
        applied.push(`Merged "${payload.nameB}" into "${payload.nameA}"`);
      }
    }
    if (item.kind === "tract_match") {
      if (resolution.reject === true && typeof payload.canonicalTractId === "string") {
        await supabase.from("title_canonical_tracts").update({ match_status: "rejected" }).eq("id", payload.canonicalTractId).eq("job_id", jobId);
        applied.push("Rejected proposed tract");
      } else if (typeof resolution.canonicalTractId === "string" && typeof payload.instrumentId === "string") {
        await supabase.from("title_instrument_tracts").update({ canonical_tract_id: resolution.canonicalTractId }).eq("instrument_id", payload.instrumentId).eq("job_id", jobId);
        await supabase.from("title_claims").update({ canonical_asset_id: resolution.canonicalTractId, human_review_status: "corrected" }).eq("instrument_id", payload.instrumentId).eq("job_id", jobId);
        applied.push("Linked instrument to tract");
      } else if (resolution.confirmProposed === true && typeof payload.canonicalTractId === "string") {
        await supabase.from("title_canonical_tracts").update({ match_status: "confirmed", needs_user_selection: false }).eq("id", payload.canonicalTractId).eq("job_id", jobId);
        applied.push("Confirmed proposed tract");
      }
    }
  }

  await supabase.from("title_review_items").update({ status: body.action === "resolve" ? "resolved" : "dismissed", resolution_json: { ...resolution, applied }, resolved_at: new Date().toISOString() }).eq("id", item.id);
  return NextResponse.json({ ok: true, data: { applied } });
}
