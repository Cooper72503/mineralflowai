import type { SupabaseClient } from "@supabase/supabase-js";
import type { DealScoreResult } from "@/lib/document-processing";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { dealMatchesUserAlertPrefs } from "./match-deal";

type AlertRow = {
  id: string;
  min_score: number | string | null;
  county: string | null;
  acreage_min: string | number | null;
};

export type SavedExtractionForAlerts = {
  county?: string | null;
  structured_data?: unknown;
  structured_json?: unknown;
} | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMinScore(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = parseFloat(raw.trim());
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}

function readAcreageMin(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = parseFloat(raw.trim());
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}

function readDealScoreFromStructured(structured: unknown): number | null {
  if (!isPlainObject(structured)) return null;
  const ds = structured.deal_score;
  if (!isPlainObject(ds)) return null;
  const s = ds.score;
  if (typeof s === "number" && Number.isFinite(s)) return s;
  if (typeof s === "string") {
    const n = parseFloat(s.trim());
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}

function readCountyFromStructured(structured: unknown): string | null {
  if (!isPlainObject(structured)) return null;
  const c = structured.county;
  if (typeof c === "string") {
    const t = c.trim();
    if (t) return t;
  }
  return null;
}

function readAcreageFromStructured(structured: unknown): number | null {
  if (!isPlainObject(structured)) return null;
  const a = structured.acreage;
  if (typeof a === "number" && Number.isFinite(a)) return a;
  if (typeof a === "string") {
    const n = parseFloat(a.trim());
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Prefer persisted extraction columns and structured_data / structured_json when shapes are valid;
 * otherwise use pipeline fallbacks (same values that were just scored).
 */
function resolveDealAlertFields(args: {
  savedExtraction: SavedExtractionForAlerts;
  dealScore: DealScoreResult;
  countyFallback: string | null;
  acreageFallback: number | null | undefined;
}): { score: number; county: string | null; acreage: number | null } {
  const structured = args.savedExtraction?.structured_data ?? args.savedExtraction?.structured_json;

  const scoreFromStructured = readDealScoreFromStructured(structured);
  const score =
    scoreFromStructured != null && Number.isFinite(scoreFromStructured)
      ? scoreFromStructured
      : args.dealScore.score;

  const savedCounty =
    typeof args.savedExtraction?.county === "string" ? args.savedExtraction.county.trim() || null : null;
  const countyFromStructured = readCountyFromStructured(structured);
  const county = savedCounty ?? countyFromStructured ?? args.countyFallback;

  const acreageFromStructured = readAcreageFromStructured(structured);
  let acreage: number | null =
    acreageFromStructured != null && Number.isFinite(acreageFromStructured)
      ? acreageFromStructured
      : null;
  if (acreage == null) {
    const fb = args.acreageFallback;
    if (typeof fb === "number" && Number.isFinite(fb)) acreage = fb;
    else acreage = null;
  }

  return { score, county, acreage };
}

/**
 * Loads all alert preference rows and logs once per row whose filters match the processed deal.
 * Uses the service role client when SUPABASE_SERVICE_ROLE_KEY is set (required to see every user's row under RLS);
 * otherwise falls back to the request-scoped client (only that user's alerts are visible).
 */
export async function logAlertIfDealMatches(
  supabase: SupabaseClient,
  args: {
    dealId: string;
    dealScore: DealScoreResult;
    county: string | null;
    acreage: number | null | undefined;
    savedExtraction?: SavedExtractionForAlerts;
  }
): Promise<void> {
  const serviceClient = createServiceRoleClient();
  const db = serviceClient ?? supabase;
  const { data, error } = await db.from("alerts").select("id, min_score, county, acreage_min");

  if (error) {
    console.warn("[deal-alerts] could not load alerts", {
      dealId: args.dealId,
      message: error.message,
    });
    return;
  }

  if (!data?.length) return;

  const { score, county, acreage } = resolveDealAlertFields({
    savedExtraction: args.savedExtraction ?? null,
    dealScore: args.dealScore,
    countyFallback: args.county,
    acreageFallback: args.acreage,
  });

  const dealCtx = {
    score,
    county,
    acreage,
  };

  for (const raw of data) {
    const row = raw as AlertRow;
    const minScore = readMinScore(row.min_score);
    if (minScore == null) continue;

    const prefs = {
      min_score: minScore,
      county: row.county,
      acreage_min: readAcreageMin(row.acreage_min),
    };
    if (dealMatchesUserAlertPrefs(prefs, dealCtx)) {
      console.log("ALERT TRIGGERED", { dealId: args.dealId, score, county });
    }
  }
}
