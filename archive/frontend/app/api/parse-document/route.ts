/**
 * /api/parse-document
 *
 * Accepts a multipart form upload of a PDF, TXT, or CSV file and returns
 * the extracted plain text. Used by the underwriting upload flow.
 *
 * POST body: multipart/form-data with a single `file` field.
 * Response:  { ok: true, text: string, pages: number, filename: string }
 *
 * Limits:
 *   PDF max pages: 100 (to keep latency reasonable)
 *   Max file size: 20 MB
 */

import { NextResponse } from "next/server";
import { createSupabaseFromRouteRequest } from "@/lib/supabase/from-route-request";

export const runtime    = "nodejs";
export const dynamic    = "force-dynamic";
export const maxDuration = 30;

// ─── PDF text extraction via pdf-parse (dynamic import avoids edge-runtime issues)

async function extractPdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require("pdf-parse") as (
    buf: Buffer,
    opts?: { max?: number }
  ) => Promise<{ text: string; numpages: number }>;

  const result = await pdfParse(buffer, { max: 100 });
  return { text: result.text ?? "", pages: result.numpages };
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // Auth check
    const supabase = await createSupabaseFromRouteRequest(request);
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ ok: false, error: "Expected multipart/form-data" }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ ok: false, error: "No file in request" }, { status: 400 });
    }

    const fileBlob = file as File;
    const filename = fileBlob.name ?? "upload";
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";

    // 20 MB cap
    const MAX_BYTES = 20 * 1024 * 1024;
    const arrayBuffer = await fileBlob.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "File too large (max 20 MB)" }, { status: 413 });
    }

    const buffer = Buffer.from(arrayBuffer);

    // PDF parsing
    if (ext === "pdf") {
      try {
        const { text, pages } = await extractPdfText(buffer);
        const cleanText = text
          .replace(/\x00/g, " ")           // null bytes
          .replace(/\r\n/g, "\n")          // normalize line endings
          .replace(/\r/g, "\n")
          .replace(/[ \t]+\n/g, "\n")      // trailing spaces before newlines
          .replace(/\n{3,}/g, "\n\n")      // max 2 blank lines
          .trim();

        return NextResponse.json({
          ok: true,
          text: cleanText,
          pages,
          filename,
          char_count: cleanText.length,
        });
      } catch (pdfErr) {
        console.error("[parse-document] pdf-parse error:", pdfErr);
        return NextResponse.json(
          { ok: false, error: "PDF parsing failed — try a text-layer PDF or copy-paste the text directly." },
          { status: 422 },
        );
      }
    }

    // Plain text / CSV / other — decode as UTF-8
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer).trim();
    return NextResponse.json({
      ok: true,
      text,
      pages: 1,
      filename,
      char_count: text.length,
    });

  } catch (err) {
    console.error("[parse-document] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
