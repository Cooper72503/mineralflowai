import type { DealScoreResult } from "@/lib/document-processing/deal-score";
import { parseAcreageFromLegalDescription } from "@/lib/document-processing/parse-acreage-from-legal";

export const EM_DASH = "—";

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

export function isDealScoreResult(value: unknown): value is DealScoreResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (typeof o.score !== "number" || !Number.isFinite(o.score)) return false;
  const g = o.grade;
  if (g !== "A Deal" && g !== "B Deal" && g !== "C Deal") return false;
  if (!Array.isArray(o.reasons) || !o.reasons.every((r) => typeof r === "string")) return false;
  return true;
}

export function dealScoreFromMerged(merged: Record<string, unknown>): DealScoreResult | null {
  const ds = merged.deal_score;
  return isDealScoreResult(ds) ? ds : null;
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

export function gradeLetter(grade: DealScoreResult["grade"] | null | undefined): "A" | "B" | "C" | null {
  if (!grade) return null;
  if (grade === "A Deal") return "A";
  if (grade === "B Deal") return "B";
  if (grade === "C Deal") return "C";
  return null;
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
