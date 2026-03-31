import { NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { calculateDealScore } from "@/lib/document-processing";
import { buildDealScoreInput } from "@/lib/deals/build-deal-score-input";
import { coerceDealScoreResult, dealScoreFromMerged, mergeStructuredFields } from "@/lib/deals/dashboard-normalize";
import {
  developmentSignalsNeedsPersistInMerged,
  extractionFieldsRecordForSignals,
  mergeDevelopmentIntoDealInput,
} from "@/lib/development/apply-development-snapshot";
import {
  drillSnapshotFromDealInput,
  enrichDealScoreInputWithDrillDifficulty,
} from "@/lib/scoring/drillDifficultyEngine";
import { buildFinancialSummary } from "@/lib/financial/financial-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DocJoin = {
  status: string;
  county: string | null;
  state: string | null;
  document_type: string | null;
  processed_at: string | null;
  completed_at: string | null;
};

type ExtractionRescoreRow = {
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

function drillTopLevelPayload(snap: ReturnType<typeof drillSnapshotFromDealInput>) {
  return {
    estimated_formation: snap.estimated_formation,
    estimated_depth_min: snap.estimated_depth_min,
    estimated_depth_max: snap.estimated_depth_max,
    drill_difficulty: snap.drill_difficulty,
    drill_difficulty_score: snap.drill_difficulty_score,
    drill_difficulty_reason: snap.drill_difficulty_reason,
  };
}

function singleDoc(d: DocJoin | DocJoin[]): DocJoin | null {
  if (Array.isArray(d)) {
    const first = d[0];
    return first && typeof first === "object" ? first : null;
  }
  return d && typeof d === "object" ? d : null;
}

function stringFieldFromMerged(merged: Record<string, unknown>, key: string): string | null {
  const v = merged[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseFromRouteRequest(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const { data: rows, error: fetchError } = await supabase
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
      .eq("user_id", user.id)
      .eq("documents.status", "completed");

    if (fetchError) {
      return NextResponse.json(
        { ok: false, error: fetchError.message ?? "Failed to load extractions." },
        { status: 500 }
      );
    }

    const list = (rows as unknown as ExtractionRescoreRow[]) ?? [];
    let updated = 0;

    for (const row of list) {
      const doc = singleDoc(row.documents);
      if (!doc) continue;

      const merged = mergeStructuredFields(row.structured_data, row.structured_json) as Record<string, unknown>;
      const existing = dealScoreFromMerged(merged);
      if (existing != null && existing.score !== 0) continue;

      const baseline: Record<string, unknown> = { ...merged };
      delete baseline.deal_score;

      const parsed = {
        lessor: row.lessor,
        lessee: row.lessee,
        grantor: stringFieldFromMerged(merged, "grantor"),
        grantee: stringFieldFromMerged(merged, "grantee"),
        parties: merged.parties,
        county: row.county,
        state: row.state,
        legal_description: row.legal_description,
        effective_date: row.effective_date,
        recording_date: row.recording_date,
        royalty_rate: row.royalty_rate,
        term_length: row.term_length,
        document_type: row.document_type,
        confidence_score: row.confidence_score,
      };

      const dealScoreInput = buildDealScoreInput({
        optionalBaseline: baseline,
        parsed,
        doc: {
          county: doc.county,
          state: doc.state,
          document_type: doc.document_type,
        },
        extractedText: row.extracted_text ?? "",
        documentProcessedAtIso:
          doc.processed_at ?? doc.completed_at ?? row.created_at ?? null,
      }) as Record<string, unknown>;

      try {
        enrichDealScoreInputWithDrillDifficulty(dealScoreInput);
      } catch {
        // Non-fatal
      }
      mergeDevelopmentIntoDealInput(
        dealScoreInput,
        row.extracted_text ?? "",
        extractionFieldsRecordForSignals({
          legal_description: row.legal_description,
          document_type: row.document_type,
          county: row.county,
          state: row.state,
          lessor: row.lessor,
          lessee: row.lessee,
          grantor: stringFieldFromMerged(merged, "grantor"),
          grantee: stringFieldFromMerged(merged, "grantee"),
          owner: stringFieldFromMerged(merged, "owner"),
          buyer: stringFieldFromMerged(merged, "buyer"),
        }),
      );

      const financialSummary = buildFinancialSummary({
        extractedText: row.extracted_text ?? "",
        dealScoreInput,
        royaltyRateStr: row.royalty_rate,
        county: row.county ?? doc.county,
      });

      const dealScoreCalculated = calculateDealScore(dealScoreInput);
      const dealScore = coerceDealScoreResult(dealScoreCalculated) ?? dealScoreCalculated;
      if (
        existing != null &&
        dealScore.score === existing.score &&
        dealScore.type === existing.type &&
        !developmentSignalsNeedsPersistInMerged(merged, dealScoreInput.development_signals)
      ) {
        continue;
      }

      console.log(`[rescore-deal-scores] SCORE CALCULATED`, {
        document_id: row.document_id,
        score: dealScore.score,
        grade: dealScore.grade,
        type: dealScore.type,
      });

      const drillSnap = drillSnapshotFromDealInput(dealScoreInput);
      const nextStructured = {
        ...merged,
        ...drillSnap,
        development_signals: dealScoreInput.development_signals ?? merged.development_signals,
        deal_score: dealScore,
        financial_summary: financialSummary,
      };
      const drillCols = drillTopLevelPayload(drillSnap);

      const { error: updateBothErr } = await supabase
        .from("document_extractions")
        .update({ structured_data: nextStructured, structured_json: nextStructured, ...drillCols })
        .eq("id", row.id)
        .eq("user_id", user.id);

      if (!updateBothErr) {
        console.log("SCORE SAVED", dealScore.score);
        console.log(`[rescore-deal-scores] SCORE SAVED`, {
          document_id: row.document_id,
          score: dealScore.score,
          grade: dealScore.grade,
          columns: "structured_data+structured_json+drill_columns",
        });
        updated += 1;
        continue;
      }

      const { error: updateError } = await supabase
        .from("document_extractions")
        .update({ structured_data: nextStructured, ...drillCols })
        .eq("id", row.id)
        .eq("user_id", user.id);

      if (!updateError) {
        console.log("SCORE SAVED", dealScore.score);
        console.log(`[rescore-deal-scores] SCORE SAVED`, {
          document_id: row.document_id,
          score: dealScore.score,
          grade: dealScore.grade,
          columns: "structured_data+drill_columns",
        });
        updated += 1;
      }
    }

    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
