import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import {
  CriteriaSchema,
  parseFinderRequest,
} from "@/lib/mineral-finder/criteria";
export const dynamic = "force-dynamic";
const Input = z
  .object({
    requestKey: z.string().uuid(),
    query: z.string().trim().min(1).max(2000),
    criteria: CriteriaSchema.partial().optional(),
  })
  .strict();
const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: NextRequest) {
  const db = await createSupabaseFromRouteRequest(request);
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user)
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401, headers },
    );
  if (process.env.MINERAL_FINDER_ENABLED !== "true")
    return NextResponse.json(
      { error: "Mineral Finder pilot is not enabled on this deployment." },
      { status: 503, headers },
    );
  const input = Input.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return NextResponse.json(
      {
        error:
          "Provide a request key, research request and valid pilot filters.",
      },
      { status: 400, headers },
    );
  let criteria;
  try {
    criteria = parseFinderRequest(input.data.query, input.data.criteria);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unsupported request" },
      { status: 400, headers },
    );
  }
  const r = await db.rpc("enqueue_mineral_finder", {
    p_key: input.data.requestKey,
    p_request: { query: input.data.query, criteria },
  });
  if (r.error || !r.data)
    return NextResponse.json(
      {
        error:
          "Research run could not be confirmed. Retry the same request key. " +
          (r.error?.message ?? ""),
      },
      { status: 503, headers },
    );
  return NextResponse.json({ id: r.data, criteria }, { status: 202, headers });
}
export async function GET(request: NextRequest) {
  const db = await createSupabaseFromRouteRequest(request);
  const {
    data: { user },
    error,
  } = await db.auth.getUser();
  if (error || !user)
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401, headers },
    );
  const r = await db
    .from("mineral_finder_jobs")
    .select("id,status,stage,created_at,request_json,error_summary")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);
  if (r.error)
    return NextResponse.json(
      {
        error:
          "Research history unavailable; confirm migration 044 is applied.",
      },
      { status: 503, headers },
    );
  return NextResponse.json({ data: r.data }, { headers });
}
