import {
  dealGradeFullLabelFromScore,
  getGradeFromScore,
  type DealScoreResult,
} from "@/lib/document-processing/deal-score";

export { getGradeFromScore, dealGradeFullLabelFromScore };
import { parseAcreageFromLegalDescription } from "@/lib/document-processing/parse-acreage-from-legal";

export const EM_DASH = "—";

/** Numeric score, or a fixed label when scoring was skipped for incomplete extraction. */
export function dealScoreDisplayValue(dealScore: DealScoreResult | null | undefined): string {
  if (dealScore == null) return EM_DASH;
  if (dealScore.incomplete_data) return "Incomplete data";
  return String(dealScore.score);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept JSON object or JSON string from Supabase JSONB / text. */
export function coerceStructuredRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(value) ? value : null;
}

/**
 * Legacy structured blob first (e.g. old `structured_json` column), then `structured_data` overwrites.
 * Pass a single coalesced blob as the first arg when the DB only exposes `structured_data`.
 */
export function mergeStructuredFields(
  structured_data: unknown,
  structured_json?: unknown
): Record<string, unknown> {
  const fromLegacy = coerceStructuredRecord(structured_json) ?? {};
  const fromPrimary = coerceStructuredRecord(structured_data) ?? {};
  return { ...fromLegacy, ...fromPrimary };
}

function normalizedNumericScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function isDealScoreResult(value: unknown): value is DealScoreResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (normalizedNumericScore(o.score) == null) return false;
  const reasons = o.reasons;
  if (reasons != null && (!Array.isArray(reasons) || !reasons.every((r) => typeof r === "string"))) {
    return false;
  }
  return true;
}

/**
 * Coerces any persisted/API `deal_score` blob: numeric score is canonical; grade is always recomputed.
 */
export function coerceDealScoreResult(value: unknown): DealScoreResult | null {
  if (!isDealScoreResult(value)) return null;
  const o = value as Record<string, unknown>;
  const n = normalizedNumericScore(o.score);
  if (n == null) return null;
  const clamped = Math.round(Math.max(0, Math.min(100, n)));
  const reasonsRaw = o.reasons;
  const reasons =
    Array.isArray(reasonsRaw) && reasonsRaw.every((r) => typeof r === "string")
      ? [...reasonsRaw]
      : [];
  const incomplete = o.incomplete_data === true;
  return {
    score: clamped,
    grade: dealGradeFullLabelFromScore(clamped),
    reasons,
    ...(incomplete ? { incomplete_data: true as const } : {}),
  };
}

export function dealScoreFromMerged(merged: Record<string, unknown>): DealScoreResult | null {
  const ds = merged.deal_score;
  if (ds == null || typeof ds !== "object" || Array.isArray(ds)) return null;
  return coerceDealScoreResult(ds);
}

/** `deal_score` from one JSON column only (no merge with the other column). */
export function dealScoreFromStructuredBlobOnly(blob: unknown): DealScoreResult | null {
  const r = coerceStructuredRecord(blob);
  if (!r) return null;
  return dealScoreFromMerged(r);
}

/** Same merge as dashboard / leads: `structured_json` then `structured_data` overwrites (including `deal_score`). */
export function dealScoreFromExtractionColumns(
  structured_data: unknown,
  structured_json: unknown
): DealScoreResult | null {
  return dealScoreFromMerged(mergeStructuredFields(structured_data, structured_json));
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.trim().replace(/,/g, ""));
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return undefined;
}

export function ownerFromStructured(
  merged: Record<string, unknown>,
  columnLessor: string | null | undefined
): string {
  const fromStruct =
    readNonEmptyString(merged.owner) ??
    readNonEmptyString(merged.lessor) ??
    readNonEmptyString(merged.grantor) ??
    readNonEmptyString(merged.owner_name) ??
    readNonEmptyString(merged.ownerName);
  const col = readNonEmptyString(columnLessor);
  return fromStruct ?? col ?? EM_DASH;
}

export function acreageDisplayFromStructured(merged: Record<string, unknown>): string {
  const n =
    readFiniteNumber(merged.acreage) ??
    readFiniteNumber(merged.net_acreage) ??
    readFiniteNumber(merged.net_mineral_acres);
  if (n !== undefined) return String(n);
  const legal = readNonEmptyString(merged.legal_description);
  if (legal) {
    const parsed = parseAcreageFromLegalDescription(legal);
    if (parsed !== undefined) return String(parsed);
  }
  return EM_DASH;
}

export function leaseStatusFromStructured(merged: Record<string, unknown>): string {
  return readNonEmptyString(merged.lease_status) ?? EM_DASH;
}

export function documentTypeDisplay(
  merged: Record<string, unknown>,
  fallback: string | null | undefined
): string {
  return readNonEmptyString(merged.document_type) ?? readNonEmptyString(fallback) ?? EM_DASH;
}

/** Badge/filter letter — always from numeric score, never from stored grade text. */
export function gradeLetterFromDealScore(
  dealScore: DealScoreResult | null | undefined
): "A" | "B" | "C" | "D" | null {
  if (dealScore == null) return null;
  return getGradeFromScore(dealScore.score);
}

export function completedTimestampMs(
  completed_at: string | null | undefined,
  processed_at: string | null | undefined
): number {
  const raw = completed_at ?? processed_at ?? null;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}
