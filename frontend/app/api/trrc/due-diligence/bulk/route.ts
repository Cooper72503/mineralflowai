/**
 * POST /api/trrc/due-diligence/bulk
 *
 * Portfolio upload — asked for directly in the 2026-08-18 Novi call:
 * "do I load into your software a bunch of APIs?" Accepts a list of raw
 * inputs (API numbers, one per line/entry) and creates one run per input,
 * reusing createDueDiligenceRun so this never drifts from the single-run
 * route's validation/resolution behavior.
 *
 * Each run is independently created and independently claimed by the
 * worker's own poller — this endpoint only creates the rows; it does not
 * orchestrate the batch itself. A frontend that submitted N inputs polls
 * the N returned run ids the same way it already polls one.
 *
 * V1 scope, deliberately: no new database table tracking "this batch of
 * runs belongs together" — the caller holds the returned id list
 * (currently client-side state, not persisted). A refresh mid-batch loses
 * the grouping, same tradeoff every other in-flight run already has
 * before this endpoint existed. A real "portfolio" table that survives a
 * refresh is a fast-follow, not shipped half-done here.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { isTrrcDdEnabled } from "@/lib/trrc/source-registry";
import { createDueDiligenceRun } from "@/lib/trrc/create-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Real, deliberate cap — not arbitrary. MAX_CONCURRENT on the worker is 3
// (raised tonight from 1); a batch far larger than that just sits in a
// long pending queue with no different failure mode, but a very large
// paste (thousands of lines) turns one request into thousands of
// sequential Supabase inserts and TRRC entity-resolution calls, which is
// its own reliability risk distinct from "the worker is busy." 50 is
// generous headroom above what a real single diligence session needs.
const MAX_BULK_INPUTS = 50;

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  if (!isTrrcDdEnabled()) {
    return NextResponse.json({ ok: false, error: "TRRC Due Diligence is not currently available." }, { status: 503 });
  }

  let body: { inputs?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.inputs)) {
    return NextResponse.json({ ok: false, error: "inputs must be an array of strings." }, { status: 400 });
  }

  const inputs = body.inputs
    .filter((v): v is string => typeof v === "string")
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // De-dupe — a pasted list commonly has accidental repeats (copy-paste
  // overlap between two source lists), and running the same well twice in
  // one batch wastes a worker slot for zero new information.
  const uniqueInputs = Array.from(new Set(inputs));

  if (uniqueInputs.length === 0) {
    return NextResponse.json({ ok: false, error: "No valid inputs provided." }, { status: 400 });
  }
  if (uniqueInputs.length > MAX_BULK_INPUTS) {
    return NextResponse.json(
      { ok: false, error: `Too many inputs — ${uniqueInputs.length} provided, ${MAX_BULK_INPUTS} maximum per batch.` },
      { status: 400 },
    );
  }

  // Independent creates, run concurrently — one bad input (unresolvable,
  // malformed) must not block or fail the rest of the batch.
  const results = await Promise.all(
    uniqueInputs.map(async (input) => {
      const result = await createDueDiligenceRun(supabase, user.id, { input });
      return result.ok
        ? { original_input: input, ok: true as const, id: result.id, status: result.status, needs_user_selection: result.needs_user_selection }
        : { original_input: input, ok: false as const, error: result.error };
    }),
  );

  const succeeded = results.filter(r => r.ok).length;

  return NextResponse.json({
    ok: true,
    data: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    },
  });
}
