/**
 * Text extraction for title documents: PDF text layer via pdf-parse, and
 * OCR (tesseract.js) for images and for PDFs with no text layer (pages are
 * rasterized with pdfjs-dist + @napi-rs/canvas, all already project
 * dependencies and already listed in next.config's external packages).
 *
 * Pages are joined with a form-feed (\f) so downstream parsers can report
 * 1-based page numbers. Every failure is returned as a structured status —
 * never thrown — so a document that cannot be read is recorded as such and
 * routed to the review queue instead of silently dropped.
 */

import { createHash } from "crypto";

export interface DocumentTextResult {
  text: string;
  pageCount: number | null;
  hasTextLayer: boolean | null;
  ocrStatus: "not_needed" | "done" | "failed";
  error: string | null;
}

export const MAX_OCR_PAGES = 25;

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isPdf(mime: string | null, fileName: string | null): boolean {
  return (mime ?? "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(fileName ?? "");
}

export function isImage(mime: string | null, fileName: string | null): boolean {
  return /^image\/(png|jpe?g|tiff?|webp|bmp)$/i.test(mime ?? "") || /\.(png|jpe?g|tiff?|webp|bmp)$/i.test(fileName ?? "");
}

async function pdfTextLayer(buffer: Buffer): Promise<{ text: string; pageCount: number | null }> {
  // lib/pdf-parse.js, not the package index — see extract-apis/route.ts for why.
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  const pages: string[] = [];
  const options: Record<string, unknown> = {
    pagerender: async (pageData: { getTextContent: () => Promise<{ items: Array<{ str: string; transform?: number[] }> }> }) => {
      const content = await pageData.getTextContent();
      let lastY: number | null = null;
      let out = "";
      for (const item of content.items) {
        const y = item.transform?.[5] ?? null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) out += "\n";
        out += item.str + " ";
        lastY = y;
      }
      pages.push(out);
      return out;
    },
  };
  const parsed = await pdfParse(buffer, options as never);
  const text = pages.length > 0 ? pages.join("\f") : (parsed.text ?? "");
  return { text, pageCount: parsed.numpages ?? (pages.length || null) };
}

async function ocrImageBuffer(buffer: Buffer): Promise<string> {
  const tesseract = await import("tesseract.js");
  const worker = await tesseract.createWorker("eng");
  try {
    const { data } = await worker.recognize(buffer);
    return data.text ?? "";
  } finally {
    await worker.terminate();
  }
}

async function ocrPdfPages(buffer: Buffer, maxPages: number): Promise<{ text: string; pageCount: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const canvasMod = await import("@napi-rs/canvas");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, useSystemFonts: false }).promise;
  const pageCount = doc.numPages;
  const tesseract = await import("tesseract.js");
  const worker = await tesseract.createWorker("eng");
  const pages: string[] = [];
  try {
    for (let i = 1; i <= Math.min(pageCount, maxPages); i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      const renderParams = { canvasContext: ctx, viewport, canvas } as unknown as Parameters<typeof page.render>[0];
      await page.render(renderParams).promise;
      const png = canvas.toBuffer("image/png");
      const { data } = await worker.recognize(png);
      pages.push(data.text ?? "");
    }
  } finally {
    await worker.terminate();
  }
  if (pageCount > maxPages) pages.push(`[OCR stopped after ${maxPages} of ${pageCount} pages]`);
  return { text: pages.join("\f"), pageCount };
}

export async function extractDocumentText(buffer: Buffer, mime: string | null, fileName: string | null): Promise<DocumentTextResult> {
  if (isPdf(mime, fileName)) {
    let layer: { text: string; pageCount: number | null } | null = null;
    try {
      layer = await pdfTextLayer(buffer);
    } catch (e) {
      return { text: "", pageCount: null, hasTextLayer: null, ocrStatus: "failed", error: `PDF could not be parsed: ${String(e).slice(0, 200)}` };
    }
    const meaningful = layer.text.replace(/\s+/g, " ").trim().length >= 40;
    if (meaningful) return { text: layer.text, pageCount: layer.pageCount, hasTextLayer: true, ocrStatus: "not_needed", error: null };
    try {
      const ocr = await ocrPdfPages(buffer, MAX_OCR_PAGES);
      const ok = ocr.text.replace(/\s+/g, " ").trim().length >= 40;
      return { text: ocr.text, pageCount: ocr.pageCount, hasTextLayer: false, ocrStatus: ok ? "done" : "failed", error: ok ? null : "OCR produced no legible text" };
    } catch (e) {
      return { text: "", pageCount: layer.pageCount, hasTextLayer: false, ocrStatus: "failed", error: `OCR failed: ${String(e).slice(0, 200)}` };
    }
  }

  if (isImage(mime, fileName)) {
    try {
      const text = await ocrImageBuffer(buffer);
      const ok = text.replace(/\s+/g, " ").trim().length >= 40;
      return { text, pageCount: 1, hasTextLayer: false, ocrStatus: ok ? "done" : "failed", error: ok ? null : "OCR produced no legible text" };
    } catch (e) {
      return { text: "", pageCount: 1, hasTextLayer: false, ocrStatus: "failed", error: `OCR failed: ${String(e).slice(0, 200)}` };
    }
  }

  // Plain text / unknown: treat bytes as UTF-8 text.
  const text = buffer.toString("utf8");
  return { text, pageCount: Math.max(1, text.split("\f").length), hasTextLayer: true, ocrStatus: "not_needed", error: null };
}
