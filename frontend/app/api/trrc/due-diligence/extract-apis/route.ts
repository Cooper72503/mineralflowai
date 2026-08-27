/**
 * POST /api/trrc/due-diligence/extract-apis
 *
 * Real request, 2026-08-26: "putting a PDF of 50 API's and receiving
 * overviews of each well" — distinct from the portfolio page's existing
 * paste-a-list textarea, which requires the user to already have a plain
 * text list. This extracts candidate API numbers directly from an
 * uploaded PDF (a well list, a lease schedule, whatever a customer hands
 * over) so that step isn't manual.
 *
 * Deliberately does NOT auto-submit extracted numbers as due-diligence
 * runs. It only extracts and validates candidates, returning them for the
 * user to review/edit before submitting via the existing bulk endpoint —
 * an automated text-extraction pass on an arbitrary PDF WILL have false
 * positives (page numbers, dates, phone numbers, other ID formats that
 * happen to look like an API number), and this project's whole discipline
 * is never silently trusting an unverified guess. The frontend shows the
 * extracted list in the same editable textarea the manual-paste path
 * already uses, so a wrong candidate is a one-line edit, not a silent
 * failure baked into a batch of 50 runs.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";
import { normalizeApiNumber } from "@/lib/trrc/normalization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB — generous for a text-based well list, not a scanned image dump

// Candidate tokens: runs of digits, optionally dash/space-separated,
// 8-14 digits total once separators are stripped — wide enough to catch
// "42-329-42230", "4232942230", "329-42230". Deliberately NOT anchored on
// \b: live-caught against a real table-layout PDF, pdf-parse's text
// extraction drops cell-boundary whitespace ("Well B4216502733" with no
// space), and \b never fires between a letter and a digit since both are
// \w — that silently dropped every API number adjacent to a label. Using
// lookaround on "not another digit" instead of \b still prevents slicing
// a longer number in half, but no longer requires a non-word character
// before/after, so a number glued directly to a letter is still found.
// A run spanning a line break still isn't handled (a real limitation of
// naive text extraction, not attempted here). Every candidate is
// validated by the same normalizeApiNumber() the rest of the app already
// trusts — this regex only proposes, it never decides.
const CANDIDATE_PATTERN = /(?<!\d)\d[\d\s-]{6,18}\d(?!\d)/g;

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseFromRouteRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected multipart/form-data with a 'file' field." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "No file provided." }, { status: 400 });
  }
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ ok: false, error: "Only PDF files are supported." }, { status: 400 });
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json({ ok: false, error: `File too large — ${(file.size / 1_048_576).toFixed(1)}MB, ${MAX_PDF_BYTES / 1_048_576}MB maximum.` }, { status: 400 });
  }

  let text: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    // Import pdf-parse's real implementation (lib/pdf-parse.js) directly,
    // NOT the package's top-level index.js. Confirmed live: index.js
    // guards a debug block with `isDebugMode = !module.parent`, and that
    // block unconditionally tries to read a bundled test fixture
    // (./test/data/05-versions-space.pdf) and crashes with ENOENT when it
    // runs — true whenever module.parent happens to be falsy, which is
    // environment/bundler-dependent and not something to rely on staying
    // safe just because Next.js usually gives it a parent. lib/pdf-parse.js
    // has no such block; it's the same underlying function index.js
    // re-exports, without the fragile debug path.
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const parsed = await pdfParse(buffer);
    text = parsed.text ?? "";
  } catch (err) {
    console.error("[extract-apis] pdf-parse failed:", err);
    return NextResponse.json({ ok: false, error: "Could not read this PDF — it may be a scanned image without extractable text, or corrupted." }, { status: 422 });
  }

  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "No extractable text found in this PDF — if it's a scanned document, OCR isn't run here yet." }, { status: 422 });
  }

  const candidates = text.match(CANDIDATE_PATTERN) ?? [];
  const seen = new Set<string>();
  const found: string[] = [];

  for (const candidate of candidates) {
    // Live-caught, real false positive: an invoice line reading "Invoice
    // #: 20260826" (a plain YYYYMMDD date with the dashes already
    // stripped) validates as a structurally plausible-looking API number
    // once normalizeApiNumber treats it as an 8-digit county+well code —
    // 8-digit sequences are a real, legitimate API format, so this can't
    // be rejected outright; only reject the specific shape that's a date
    // in disguise. Only applies to bare, unseparated digit runs — a
    // candidate that already contains a dash (how API numbers actually
    // appear in real documents, confirmed by every other real number in
    // this same test file) was never in question.
    if (/^\d{8}$/.test(candidate)) {
      const year = Number(candidate.slice(0, 4));
      const month = Number(candidate.slice(4, 6));
      const day = Number(candidate.slice(6, 8));
      const looksLikeDate = year >= 2000 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
      if (looksLikeDate) continue;
    }

    const normalized = normalizeApiNumber(candidate);
    if (!normalized) continue;
    if (seen.has(normalized.api10)) continue;
    seen.add(normalized.api10);
    found.push(normalized.formatted);
  }

  return NextResponse.json({
    ok: true,
    data: {
      candidatesScanned: candidates.length,
      apiNumbersFound: found,
    },
  });
}
