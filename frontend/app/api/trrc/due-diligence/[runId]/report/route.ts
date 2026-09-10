/**
 * GET /api/trrc/due-diligence/[runId]/report
 *
 * Generate and download a PDF due diligence report for a completed run.
 * Loads all run data from the database, calls buildTrrcPdfReport, and
 * streams back the PDF buffer. Logic shared with the bulk report-bundle
 * endpoint via generatePdfReportForRun() so the two can't drift apart.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import {generateGold2ForRun} from "@/lib/trrc/gold2/generate";
import { generatePdfReportForRun } from "@/lib/trrc/generate-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { runId } = await params;
  if (!runId) {
    return NextResponse.json({ ok: false, error: "runId is required." }, { status: 400 });
  }

  const format=request.nextUrl.searchParams.get("format");
  if(format==="gold2"||format==="gold2-json"){
    const result=await generateGold2ForRun(supabase,runId,user.id,format==="gold2"?"pdf":"json");
    if(!result.ok)return NextResponse.json({ok:false,error:result.error},{status:result.status});
    return new NextResponse(new Uint8Array(result.bytes),{status:200,headers:{"Content-Type":result.contentType,"Content-Disposition":`attachment; filename="${result.filename}"`,"Cache-Control":"private, no-store"}});
  }
  const result = await generatePdfReportForRun(supabase, runId, user.id);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return new NextResponse(new Uint8Array(result.pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.pdfBuffer.length),
    },
  });
}
