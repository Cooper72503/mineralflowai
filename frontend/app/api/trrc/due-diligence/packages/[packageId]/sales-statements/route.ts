/**
 * /api/trrc/due-diligence/packages/[packageId]/sales-statements
 *
 * Purchaser run statements for a deal. The browser reads the PDF's text
 * (lib/trrc/sales/read-pdf-client.ts) and sends only the text and the file's
 * SHA-256, so a large statement bundle is not limited by request size.
 *   POST { fileName, sha256, pages: string[] } — parse and store; the same file twice is one statement.
 *   GET — the package's statements.
 *   DELETE ?id= — remove one.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { parseRunStatements } from "@/lib/trrc/sales/run-statements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  fileName: z.string().trim().min(1).max(300),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pages: z.array(z.string().max(60_000)).min(1).max(400),
}).strict();
const COLUMNS = "id, file_name, file_sha256, page_count, pages_without_text, purchasers, rows_json, warnings_json, created_at";

async function owned(request: NextRequest, packageId: string) {
  const db = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) return { error: NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 }) } as const;
  if (!z.string().uuid().safeParse(packageId).success) return { error: NextResponse.json({ ok: false, error: "Invalid package ID." }, { status: 400 }) } as const;
  const pkg = await db.from("trrc_packages").select("id").eq("id", packageId).eq("user_id", user.id).maybeSingle();
  if (pkg.error) return { error: NextResponse.json({ ok: false, error: "The deal could not be loaded." }, { status: 503 }) } as const;
  if (!pkg.data) return { error: NextResponse.json({ ok: false, error: "Package not found." }, { status: 404 }) } as const;
  return { db, user } as const;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ packageId: string }> }) {
  const { packageId } = await params;
  const o = await owned(request, packageId);
  if ("error" in o) return o.error;
  const r = await o.db.from("trrc_package_sales_statements").select(COLUMNS).eq("package_id", packageId).order("created_at");
  if (r.error) return NextResponse.json({ ok: false, error: "Statements could not be loaded." }, { status: 503 });
  return NextResponse.json({ ok: true, data: r.data }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ packageId: string }> }) {
  const { packageId } = await params;
  const o = await owned(request, packageId);
  if ("error" in o) return o.error;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "Send the file name, its SHA-256 and the text of each page." }, { status: 400 });
  const parsed = parseRunStatements(body.data.pages);
  if (!parsed.rows.length) return NextResponse.json({ ok: false, error: `No run-statement totals were found in "${body.data.fileName}". The engine reads statements that print a sales month, a property and a "TOTALS FOR PROPERTY" line; scanned pages without text cannot be read.` }, { status: 422 });
  const admin = createServiceRoleClient();
  if (!admin) return NextResponse.json({ ok: false, error: "Statements cannot be saved: the server is not configured." }, { status: 503 });
  const row = { package_id: packageId, user_id: o.user.id, file_name: body.data.fileName, file_sha256: body.data.sha256, page_count: body.data.pages.length,
    pages_without_text: parsed.pagesWithoutText, purchasers: parsed.purchasers, rows_json: parsed.rows, warnings_json: parsed.warnings };
  const saved = await admin.from("trrc_package_sales_statements").upsert(row, { onConflict: "package_id,file_sha256", ignoreDuplicates: true }).select(COLUMNS);
  if (saved.error) { console.error("[sales statements]", packageId, saved.error); return NextResponse.json({ ok: false, error: "The statement could not be saved. Upload it again." }, { status: 503 }); }
  const existing = saved.data?.[0] ?? (await o.db.from("trrc_package_sales_statements").select(COLUMNS).eq("package_id", packageId).eq("file_sha256", body.data.sha256).maybeSingle()).data;
  return NextResponse.json({ ok: true, data: existing, duplicate: !saved.data?.length }, { status: saved.data?.length ? 201 : 200 });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ packageId: string }> }) {
  const { packageId } = await params;
  const o = await owned(request, packageId);
  if ("error" in o) return o.error;
  const id = request.nextUrl.searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) return NextResponse.json({ ok: false, error: "Invalid statement ID." }, { status: 400 });
  const admin = createServiceRoleClient();
  if (!admin) return NextResponse.json({ ok: false, error: "The server is not configured." }, { status: 503 });
  const r = await admin.from("trrc_package_sales_statements").delete().eq("id", id).eq("package_id", packageId).eq("user_id", o.user.id).select("id");
  if (r.error) return NextResponse.json({ ok: false, error: "The statement could not be removed." }, { status: 503 });
  if (!r.data?.length) return NextResponse.json({ ok: false, error: "Statement not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
