import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { calculateDealScore } from "@/lib/document-processing";
import { buildDealScoreInput } from "@/lib/deals/build-deal-score-input";
import {
  coerceDealScoreResult,
  dealScoreFromExtractionColumns,
  mergeStructuredFields,
} from "@/lib/deals/dashboard-normalize";
import { dealGradeFullLabelFromScore, getGradeFromScore } from "@/lib/document-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_PREFIX = "[sync-deal-score]";

type DocJoin = {
  status: string;
  county: string | null;
  state: string | null;
  document_type: string | null;
  processed_at: string | null;
  completed_at: string | null;
};

type ExtractionRow = {
  id: string;
  document_id: string;
  user_id: string;
  extracted_text: string | null;
  lessor: string | null;
  lessee: string | null;
  county: string | null;
  state: string | null;
  legal_description: string | null;
  effective_date: string | null;
  recording_date: string | null;
  royalty_rate: string | null;
  term_length: string | null;
  document_type: string | null;
  confidence_score: number | null;
  structured_data: unknown;
  structured_json: unknown;
  created_at: string;
  documents: DocJoin | DocJoin[];
};

function singleDoc(d: DocJoin | DocJoin[]): DocJoin | null {
  if (Array.isArray(d)) {
    const first = d[0];
    return first && typeof first === "object" ? first : null;
  }
  return d && typeof d === "object" ? d : null;
}

/** Ensure JSONB update receives a plain serializable object (drops undefined, survives structured clones). */
function jsonbSafeClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fetchMergedDealScoreFromExtraction(
  supabase: SupabaseClient,
  extractionId: string,
  userId: string
): Promise<number | null> {
  const { data: verify, error: verifyErr } = await supabase
    .from("document_extractions")
    .select("structured_data, structured_json")
    .eq("id", extractionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (verifyErr || !verify) return null;
  const vrow = verify as { structured_data: unknown; structured_json: unknown };
  return dealScoreFromExtractionColumns(vrow.structured_data, vrow.structured_json)?.score ?? null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: documentId } = await context.params;
    if (!documentId) {
      return NextResponse.json({ ok: false, error: "Missing document id." }, { status: 400 });
    }

    const supabase = await createSupabaseFromRouteRequest(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const { data: row, error: fetchError } = await supabase
      .from("document_extractions")
      .select(
        `
        id,
        document_id,
        user_id,
        extracted_text,
        lessor,
        lessee,
        county,
        state,
        legal_description,
        effective_date,
        recording_date,
        royalty_rate,
        term_length,
        document_type,
        confidence_score,
        structured_data,
        structured_json,
        created_at,
        documents!inner (
          status,
          county,
          state,
          document_type,
          processed_at,
          completed_at
        )
      `
      )
      .eq("document_id", documentId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json(
        { ok: false, error: fetchError.message ?? "Failed to load extraction." },
        { status: 500 }
      );
    }

    if (!row) {
      return NextResponse.json({ ok: false, error: "Extraction not found." }, { status: 404 });
    }

    const ext = row as unknown as ExtractionRow;
    const doc = singleDoc(ext.documents);
    if (!doc || doc.status !== "completed") {
      return NextResponse.json({ ok: true, updated: false, skipped: true, reason: "not_completed" });
    }

    const merged = mergeStructuredFields(ext.structured_data, ext.structured_json);
    const stored = dealScoreFromExtractionColumns(ext.structured_data, ext.structured_json);

    const baseline: Record<string, unknown> = { ...merged };
    delete baseline.deal_score;

    const parsed = {
      lessor: ext.lessor,
      lessee: ext.lessee,
      county: ext.county,
      state: ext.state,
      legal_description: ext.legal_description,
      effective_date: ext.effective_date,
      recording_date: ext.recording_date,
      royalty_rate: ext.royalty_rate,
      term_length: ext.term_length,
      document_type: ext.document_type,
      confidence_score: ext.confidence_score,
    };

    const dealScoreInput = buildDealScoreInput({
      optionalBaseline: baseline,
      parsed,
      doc: {
        county: doc.county,
        state: doc.state,
        document_type: doc.document_type,
      },
      extractedText: ext.extracted_text ?? "",
      documentProcessedAtIso: doc.processed_at ?? doc.completed_at ?? ext.created_at ?? null,
    });

    const dealScoreCalculated = calculateDealScore(dealScoreInput);
    const dealScore = coerceDealScoreResult(dealScoreCalculated) ?? dealScoreCalculated;

    const oldStoredScore = stored?.score ?? null;
    console.log(`${LOG_PREFIX} OLD STORED SCORE`, oldStoredScore);
    console.log("SCORE CALCULATED", dealScore.score);
    console.log(`${LOG_PREFIX} RECALCULATED SCORE`, dealScore.score);

    if (stored != null && stored.score === dealScore.score) {
      const finalAfter = await fetchMergedDealScoreFromExtraction(supabase, ext.id, user.id);
      console.log("SCORE SAVED", dealScore.score);
      console.log(`${LOG_PREFIX} SAVED SCORE`, "(no write)", dealScore.score);
      console.log(`${LOG_PREFIX} FINAL DB SCORE AFTER UPDATE`, finalAfter);
      return NextResponse.json({
        ok: true,
        updated: false,
        deal_score: dealScore,
      });
    }

    const nextStructured = jsonbSafeClone({ ...merged, deal_score: dealScore });
    console.log("SCORE SAVED", dealScore.score);
    console.log(`${LOG_PREFIX} SAVED SCORE`, dealScore.score);

    const { error: upBothErr } = await supabase
      .from("document_extractions")
      .update({ structured_data: nextStructured, structured_json: nextStructured })
      .eq("id", ext.id)
      .eq("user_id", user.id);

    if (upBothErr) {
      const { error: upDataErr } = await supabase
        .from("document_extractions")
        .update({ structured_data: nextStructured })
        .eq("id", ext.id)
        .eq("user_id", user.id);

      if (upDataErr) {
        return NextResponse.json(
          { ok: false, error: upBothErr.message ?? upDataErr.message ?? "Failed to update extraction." },
          { status: 500 }
        );
      }

      const { error: upJsonErr } = await supabase
        .from("document_extractions")
        .update({ structured_json: nextStructured })
        .eq("id", ext.id)
        .eq("user_id", user.id);
      if (upJsonErr) {
        console.warn(`${LOG_PREFIX} structured_json follow-up after structured_data save`, upJsonErr.message);
      }
    }

    let finalDb = await fetchMergedDealScoreFromExtraction(supabase, ext.id, user.id);
    if (dealScore.score > 0 && (finalDb === 0 || finalDb === null)) {
      const retryPayload = jsonbSafeClone({ ...merged, deal_score: dealScore });
      await supabase
        .from("document_extractions")
        .update({ structured_data: retryPayload, structured_json: retryPayload })
        .eq("id", ext.id)
        .eq("user_id", user.id);
      finalDb = await fetchMergedDealScoreFromExtraction(supabase, ext.id, user.id);
    }

    console.log(`${LOG_PREFIX} FINAL DB SCORE AFTER UPDATE`, finalDb);
    console.log("SCORE LOADED", finalDb);
    console.log(
      "GRADE LOADED",
      finalDb != null ? dealGradeFullLabelFromScore(finalDb) : null
    );
    console.log("GRADE FROM SCORE", finalDb != null ? getGradeFromScore(finalDb) : null);

    return NextResponse.json({ ok: true, updated: true, deal_score: dealScore });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
