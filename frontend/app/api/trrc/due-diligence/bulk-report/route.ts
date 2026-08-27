/**
 * POST /api/trrc/due-diligence/bulk-report
 *
 * Closes the gap in the 2026-08-18 Novi call's own framing: "you upload a
 * list of APIs... spit out a report for me... you get your actionable
 * decision in one PDF report." Before this endpoint, the portfolio page
 * could run a batch, but getting the actual reports meant clicking into
 * each completed row individually and downloading one at a time — real
 * friction between "upload a list" and "receive a report" that a live
 * demo would expose immediately.
 *
 * Takes the run ids from a completed (or partially completed) portfolio
 * batch and bundles each one's individual PDF report into a single ZIP
 * download — one click, not N. Reuses generatePdfReportForRun() so this
 * can never produce a report that looks different from the one a single
 * well's own /report endpoint would generate.
 *
 * Each well genuinely needs its own report — they're different assets
 * with different evidence — so this bundles individual PDFs rather than
 * fabricating one merged cross-well document, which would blur exactly
 * the kind of evidence lineage this whole product exists to preserve.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { generatePdfReportForRun } from "@/lib/trrc/generate-report";
import { buildZipBuffer, type ArchiveEntry } from "@/lib/trrc/archive-builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 280; // each report can involve several live fetches (GIS map, offset wells, lateral path, EIA pricing); generous headroom for a real batch

// Lower than the 50-well cap on batch creation — deliberately. Creating a
// run is one fast DB insert; generating its report is several live
// network calls plus real PDF layout work. 20 keeps a realistic total
// wall-clock time even processed with concurrency, without a customer
// hitting a serverless timeout on the exact "receive a report" moment
// that matters most in a demo.
const MAX_BULK_REPORT_RUNS = 20;
const CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { runIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.runIds)) {
    return NextResponse.json({ ok: false, error: "runIds must be an array of run ids." }, { status: 400 });
  }
  const runIds = Array.from(new Set(body.runIds.filter((v): v is string => typeof v === "string" && v.length > 0)));

  if (runIds.length === 0) {
    return NextResponse.json({ ok: false, error: "No run ids provided." }, { status: 400 });
  }
  if (runIds.length > MAX_BULK_REPORT_RUNS) {
    return NextResponse.json(
      { ok: false, error: `Too many reports requested — ${runIds.length}, ${MAX_BULK_REPORT_RUNS} maximum per bundle.` },
      { status: 400 },
    );
  }

  const results = await mapWithConcurrency(runIds, CONCURRENCY, async (runId) => {
    const result = await generatePdfReportForRun(supabase, runId, user.id);
    return { runId, result };
  });

  const entries: ArchiveEntry[] = [];
  const failures: { runId: string; error: string }[] = [];
  const usedNames = new Set<string>();

  for (const { runId, result } of results) {
    if (!result.ok) {
      failures.push({ runId, error: result.error });
      continue;
    }
    let name = result.filename;
    // Two different runs can resolve to the same normalized_input-derived
    // filename (e.g. a retried duplicate submission) — never let one
    // silently overwrite another inside the zip.
    let suffix = 2;
    while (usedNames.has(name)) {
      name = result.filename.replace(/\.pdf$/, `_${suffix}.pdf`);
      suffix++;
    }
    usedNames.add(name);
    entries.push({ path: name, content: result.pdfBuffer });
  }

  if (entries.length === 0) {
    return NextResponse.json(
      { ok: false, error: "None of the requested runs could be included.", failures },
      { status: 422 },
    );
  }

  // Never let a partial failure disappear silently — a text manifest
  // inside the zip itself, not just an HTTP response body the download
  // flow may not surface to the person opening the file later.
  if (failures.length > 0) {
    const manifestLines = [
      "Some wells in this batch could not be included in this report bundle:",
      "",
      ...failures.map(f => `  ${f.runId}: ${f.error}`),
      "",
      `${entries.length} of ${runIds.length} reports included below.`,
    ];
    entries.push({ path: "_INCOMPLETE_BATCH_README.txt", content: manifestLines.join("\n") });
  }

  const zipBuffer = await buildZipBuffer(entries);
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `TRRC_DD_Portfolio_Reports_${datePart}.zip`;

  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zipBuffer.length),
    },
  });
}
