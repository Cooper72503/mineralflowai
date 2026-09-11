/**
 * POST /api/trrc/offset-analytics
 *
 * Standalone entry point to the real Offset Analytics engine
 * (lib/trrc/offset-analytics/service.ts's runOffsetAnalytics) — the same
 * evidence-first analog-well / type-curve / ownership-resolved proxy
 * valuation pipeline that already runs inside PDF Section 9 of a due
 * diligence report, now exposed for a standalone pre-drill run against
 * ANY real Texas legal description, not tied to an existing due-diligence
 * run's TRRC-derived context.
 *
 * Ownership fields (ownershipType, mineralFraction, leaseRoyaltyFraction,
 * netRevenueInterest, workingInterest) are collected directly here — the
 * existing report-builder.ts call site hardcodes ownershipType: "UNKNOWN"
 * because the due-diligence intake form has no acreage/ownership field at
 * all. This route is what actually exercises the royalty-owner vs.
 * working-interest distinction ownership-economics.ts was built for.
 *
 * Latency: this is a genuinely multi-request live TRRC operation (up to
 * ~15 enriched analog candidates, each 4-6 live fetches) — confirmed
 * worst case is tens of seconds to a few minutes, not a quick call.
 * Synchronous, matching the same pattern already proven in production by
 * app/api/trrc/due-diligence/[runId]/report/route.ts (maxDuration 120) and
 * bulk-report/route.ts (maxDuration 280) — not a new background-job
 * pattern for v1; see the Phase 0 plan for why.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { runOffsetAnalytics, ALLOWED_RADII_MILES, type RunOffsetAnalyticsInput } from "@/lib/trrc/offset-analytics";
import { getPriceDeck } from "@/lib/trrc/eia-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 280;

interface RequestBody {
  legalDescriptionText?: unknown;
  grossAcres?: unknown;
  netMineralAcres?: unknown;
  ownershipType?: unknown;
  mineralFraction?: unknown;
  leaseRoyaltyFraction?: unknown;
  netRevenueInterest?: unknown;
  workingInterest?: unknown;
  radiusMiles?: unknown;
  distanceMode?: unknown;
  subjectFieldName?: unknown;
  subjectLateralLengthFt?: unknown;
  subjectCompletionYear?: unknown;
  subjectTvdFt?: unknown;
  subjectState?: unknown;
}

const OWNERSHIP_TYPES = new Set(["ROYALTY_INTEREST", "WORKING_INTEREST", "UNKNOWN"]);
const DISTANCE_MODES = new Set(["CENTROID_TO_WELL", "TRACT_BOUNDARY_TO_WELL"]);

/** number|null if present and finite, undefined if absent, or an error string if present but invalid. */
function parseOptionalNumber(value: unknown, field: string, opts?: { min?: number; max?: number }): { value: number | null | undefined; error?: string } {
  if (value === undefined || value === null || value === "") return { value: undefined };
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return { value: undefined, error: `${field} must be a number.` };
  if (opts?.min !== undefined && n < opts.min) return { value: undefined, error: `${field} must be at least ${opts.min}.` };
  if (opts?.max !== undefined && n > opts.max) return { value: undefined, error: `${field} must be at most ${opts.max}.` };
  return { value: n };
}

export async function POST(request: NextRequest) {
  // 1. Auth — identical pattern to every other TRRC route.
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  // 2. Parse body.
  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // 3. Validate. Fail fast with a clear message per field rather than
  // letting a malformed value silently reach the engine — defense in
  // depth on top of ownership-economics.ts's own fraction validation.
  const legalDescriptionText = typeof body.legalDescriptionText === "string" ? body.legalDescriptionText.trim() : "";
  if (!legalDescriptionText) {
    return NextResponse.json({ ok: false, error: "Enter a legal description (Survey/Abstract/County, or a Township-Range-Section description)." }, { status: 400 });
  }
  if (legalDescriptionText.length > 500) {
    return NextResponse.json({ ok: false, error: "Legal description is too long (500 characters max)." }, { status: 400 });
  }

  const ownershipType = typeof body.ownershipType === "string" && OWNERSHIP_TYPES.has(body.ownershipType)
    ? (body.ownershipType as RunOffsetAnalyticsInput["ownershipType"])
    : "UNKNOWN";
  const distanceMode = typeof body.distanceMode === "string" && DISTANCE_MODES.has(body.distanceMode)
    ? (body.distanceMode as RunOffsetAnalyticsInput["distanceMode"])
    : undefined;

  const numericFields: Array<[keyof RequestBody, string, { min?: number; max?: number } | undefined]> = [
    ["grossAcres", "Gross acres", { min: 0 }],
    ["netMineralAcres", "Net mineral acres", { min: 0 }],
    ["mineralFraction", "Mineral fraction", { min: 0, max: 1 }],
    ["leaseRoyaltyFraction", "Lease royalty fraction", { min: 0, max: 1 }],
    ["netRevenueInterest", "Net revenue interest", { min: 0, max: 1 }],
    ["workingInterest", "Working interest", { min: 0, max: 1 }],
    ["subjectLateralLengthFt", "Lateral length", { min: 0 }],
    ["subjectCompletionYear", "Completion year", { min: 1900, max: 2100 }],
    ["subjectTvdFt", "True vertical depth", { min: 0 }],
  ];
  const numericValues: Record<string, number | null | undefined> = {};
  for (const [field, label, opts] of numericFields) {
    const { value, error } = parseOptionalNumber(body[field], label, opts);
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
    numericValues[field] = value;
  }

  let radiusMiles: number | undefined;
  if (body.radiusMiles !== undefined && body.radiusMiles !== null && body.radiusMiles !== "") {
    const n = Number(body.radiusMiles);
    if (!Number.isFinite(n) || !(ALLOWED_RADII_MILES as readonly number[]).includes(n)) {
      return NextResponse.json({ ok: false, error: `Search radius must be one of: ${ALLOWED_RADII_MILES.join(", ")} miles.` }, { status: 400 });
    }
    radiusMiles = n;
  }

  const subjectFieldName = typeof body.subjectFieldName === "string" && body.subjectFieldName.trim() ? body.subjectFieldName.trim() : null;
  const subjectState = typeof body.subjectState === "string" && body.subjectState.trim() ? body.subjectState.trim().toUpperCase().slice(0, 2) : null;

  const input: RunOffsetAnalyticsInput = {
    legalDescriptionText,
    grossAcres: numericValues.grossAcres ?? null,
    netMineralAcres: numericValues.netMineralAcres ?? null,
    ownershipType,
    mineralFraction: numericValues.mineralFraction ?? null,
    leaseRoyaltyFraction: numericValues.leaseRoyaltyFraction ?? null,
    netRevenueInterest: numericValues.netRevenueInterest ?? null,
    workingInterest: numericValues.workingInterest ?? null,
    radiusMiles,
    distanceMode,
    subjectFieldName,
    subjectLateralLengthFt: numericValues.subjectLateralLengthFt ?? null,
    subjectCompletionYear: numericValues.subjectCompletionYear ?? null,
    subjectTvdFt: numericValues.subjectTvdFt ?? null,
    subjectState,
    priceDeck: await getPriceDeck(),
  };

  // 4. Run the real engine. Errors are surfaced, not swallowed — this
  // tool's entire point is showing a real result, including a real
  // failure, rather than going quiet the way the PDF call site does.
  try {
    const result = await runOffsetAnalytics(input);
    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Offset analytics run failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
