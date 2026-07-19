import {
  buildDevelopmentSignalsSnapshot,
  type DevelopmentSignalsSnapshot,
} from "@/lib/development/detect-development-signals";

/** Normalized fields merged with raw text for signal scanning (deterministic). */
export function extractionFieldsRecordForSignals(parsed: {
  legal_description: string | null;
  document_type: string | null;
  county: string | null;
  state: string | null;
  lessor: string | null;
  lessee: string | null;
  grantor: string | null;
  grantee: string | null;
  owner?: string | null;
  buyer?: string | null;
}): Record<string, unknown> {
  return {
    legal_description: parsed.legal_description,
    document_type: parsed.document_type,
    county: parsed.county,
    state: parsed.state,
    lessor: parsed.lessor,
    lessee: parsed.lessee,
    grantor: parsed.grantor,
    grantee: parsed.grantee,
    owner: parsed.owner ?? null,
    buyer: parsed.buyer ?? null,
  };
}

/**
 * Attaches `development_signals` to the deal input after county drill enrichment.
 * Safe to call on any plain object; never throws.
 */
/**
 * True when `merged` JSON is missing `development_signals` or it is stale vs the freshly computed snapshot.
 * Used so sync/rescore still persist `development_signals` when deal score and drill columns are unchanged.
 */
export function developmentSignalsNeedsPersistInMerged(
  merged: Record<string, unknown>,
  next: unknown
): boolean {
  if (next == null || typeof next !== "object") return false;
  const m = merged.development_signals;
  if (m == null || typeof m !== "object") return true;
  const ma = m as Record<string, unknown>;
  const na = next as Record<string, unknown>;
  if (Boolean(na.has_development_signals) && !Boolean(ma.has_development_signals)) return true;
  if (na.extracted_depth_limit_feet !== ma.extracted_depth_limit_feet) return true;
  if (na.display_depth_label !== ma.display_depth_label) return true;
  return false;
}

export function mergeDevelopmentIntoDealInput(
  dealInput: Record<string, unknown>,
  extractedText: string,
  extractedFields: Record<string, unknown>
): DevelopmentSignalsSnapshot {
  try {
    const snap = buildDevelopmentSignalsSnapshot(extractedText, extractedFields, dealInput);
    dealInput.development_signals = snap as unknown as Record<string, unknown>;
    return snap;
  } catch {
    const fallback: DevelopmentSignalsSnapshot = {
      has_development_signals: false,
      matched_signals: [],
      extracted_depth_limit_feet: null,
      referenced_wells: [],
      has_infrastructure_language: false,
      has_legal_development_context: false,
      partial_snapshot: false,
      formation_text_mention: null,
      display_depth_label: null,
      display_wells_note: null,
      display_infrastructure_note: null,
      display_context_note: null,
    };
    dealInput.development_signals = fallback as unknown as Record<string, unknown>;
    return fallback;
  }
}
