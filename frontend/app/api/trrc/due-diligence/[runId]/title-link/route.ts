import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Selection = z.object({ jobId: z.string().uuid() }).strict();

/** Explicit scope selection for legacy runs or competing research jobs.
 * Migration 033 enforces both account and API membership inside the database.
 * This selects research only; it never confirms a tract or approves ownership.
 */
export async function POST(request: NextRequest, {params}: {params: Promise<{runId: string}>}) {
  const db = await createSupabaseFromRouteRequest(request);
  const {data: {user}, error} = await db.auth.getUser();
  if (error || !user) return NextResponse.json({ok:false,error:"Not authenticated."},{status:401});
  const {runId} = await params;
  if (!z.string().uuid().safeParse(runId).success) return NextResponse.json({ok:false,error:"Invalid run ID."},{status:400});
  const parsed = Selection.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) return NextResponse.json({ok:false,error:"A valid title job ID is required."},{status:400});
  const job = await db.from("title_research_jobs").select("id,status").eq("id",parsed.data.jobId).eq("user_id",user.id).maybeSingle();
  if (job.error) return NextResponse.json({ok:false,error:"Could not verify title research scope."},{status:503});
  if (!job.data || ["failed","cancelled"].includes(job.data.status)) return NextResponse.json({ok:false,error:"Active title research scope not found."},{status:404});
  const linked = await db.from("trrc_due_diligence_runs").update({title_research_job_id:parsed.data.jobId})
    .eq("id",runId).eq("user_id",user.id).select("id,title_research_job_id").maybeSingle();
  if (linked.error) return NextResponse.json({ok:false,error:"Title scope could not be linked. It must match this run's API and account; migration 033 must be installed."},{status:409});
  if (!linked.data) return NextResponse.json({ok:false,error:"Run not found or access denied."},{status:404});
  return NextResponse.json({ok:true,data:linked.data});
}
