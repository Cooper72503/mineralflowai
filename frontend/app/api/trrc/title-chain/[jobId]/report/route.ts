/**
 * GET /api/trrc/title-chain/[jobId]/report?format=json|txt|view
 *
 * Renders the latest persisted analysis. `json` downloads the structured
 * report (the validated analysis plus its executive summary); `txt`
 * downloads the chronological table rendered from the same object; `view`
 * returns the report inline for the UI. Nothing is recomputed here.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { buildTitleChainReport, renderChronologyText } from "@/lib/trrc/title/report";
import type { TitleChainAnalysis } from "@/lib/trrc/title/chain-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  const { jobId } = await params;
  const format = request.nextUrl.searchParams.get("format") ?? "view";
  const versionParam = request.nextUrl.searchParams.get("version");

  let query = supabase.from("title_analyses").select("id, version, analysis_json").eq("job_id", jobId).eq("user_id", user.id).order("version", { ascending: false }).limit(1);
  if (versionParam && /^\d+$/.test(versionParam)) query = supabase.from("title_analyses").select("id, version, analysis_json").eq("job_id", jobId).eq("user_id", user.id).eq("version", Number(versionParam)).limit(1);
  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const row = data?.[0];
  if (!row) return NextResponse.json({ ok: false, error: "No analysis has been generated for this job yet." }, { status: 404 });

  const report = buildTitleChainReport(row.analysis_json as TitleChainAnalysis);
  const stamp = report.generatedAt.slice(0, 10).replace(/-/g, "");

  if (format === "json") {
    return new NextResponse(JSON.stringify(report, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="title-chain-${jobId.slice(0, 8)}-v${report.version}-${stamp}.json"` },
    });
  }
  if (format === "txt") {
    const text = [
      `MineralFlow AI — Title Chain Research (job ${jobId}, analysis v${report.version}, ${report.generatedAt})`,
      `Status: ${report.executiveSummary.status} [${report.executiveSummary.statusCode}]`,
      report.statement, "",
      renderChronologyText(report.chronology),
    ].join("\n");
    return new NextResponse(text, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="title-chain-${jobId.slice(0, 8)}-v${report.version}-${stamp}.txt"` } });
  }
  return NextResponse.json({ ok: true, data: report });
}
