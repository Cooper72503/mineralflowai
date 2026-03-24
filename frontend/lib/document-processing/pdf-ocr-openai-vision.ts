/**
 * OCR via OpenAI vision (image input). Renders PDF pages with pdf.js + @napi-rs/canvas;
 * no Poppler or Tesseract. Suitable for serverless (e.g. Vercel) when OPENAI_API_KEY is set.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import OpenAI from "openai";

import type { PdfOcrResult } from "./pdf-ocr";

const EXTRACT_LOG = "[extract]";

const MAX_OCR_PAGES = 25;
/** Moderate DPI to balance readability vs request payload size. */
const VISION_RENDER_DPI = 120;
const VISION_BATCH_SIZE = 4;
const JPEG_QUALITY = 82;

function resolvePdfAssetUrls(): { workerSrc: string; standardFontDataUrl: string; cMapUrl: string } {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("pdfjs-dist/package.json");
  const distRoot = dirname(pkgJson);
  return {
    workerSrc: pathToFileURL(join(distRoot, "legacy", "build", "pdf.worker.mjs")).href,
    standardFontDataUrl: pathToFileURL(join(distRoot, "standard_fonts")).href + "/",
    cMapUrl: pathToFileURL(join(distRoot, "cmaps")).href + "/",
  };
}

const VISION_OCR_SYSTEM = `You transcribe scanned or photographed document pages. Output ONLY the visible text, preserving reading order and line breaks where reasonable. Do not add labels like "Page 1". Do not describe the document. If a page has no readable text, output a single line: (no text)`;

function logVision(event: "OCR_VISION_START" | "OCR_VISION_SUCCESS" | "OCR_VISION_FAILED", payload: Record<string, unknown>): void {
  console.log(`${EXTRACT_LOG} ${event}`, payload);
}

/**
 * Render PDF pages to JPEGs and transcribe with OpenAI vision. No system binaries.
 */
export async function ocrPdfWithOpenAiVision(
  pdfBuffer: Buffer,
  options?: { model?: string }
): Promise<PdfOcrResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    logVision("OCR_VISION_FAILED", { reason: "OPENAI_API_KEY missing" });
    return {
      text: "",
      pageCountRasterized: 0,
      engine: "openai-vision",
      skippedReason: "OPENAI_API_KEY missing — vision OCR unavailable.",
    };
  }

  let createCanvas: typeof import("@napi-rs/canvas").createCanvas;
  try {
    ({ createCanvas } = await import("@napi-rs/canvas"));
  } catch (err: unknown) {
    const e = err instanceof Error ? err.message : String(err);
    logVision("OCR_VISION_FAILED", { reason: "canvas_load", errorMessage: e });
    return {
      text: "",
      pageCountRasterized: 0,
      engine: "openai-vision",
      skippedReason: "@napi-rs/canvas failed to load",
      errorMessage: e,
    };
  }

  const model = options?.model?.trim() || process.env.OPENAI_OCR_MODEL?.trim() || "gpt-4o-mini";

  try {
    const { workerSrc, standardFontDataUrl, cMapUrl } = resolvePdfAssetUrls();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { getDocument, GlobalWorkerOptions } = pdfjs;
    GlobalWorkerOptions.workerSrc = workerSrc;

    const data = new Uint8Array(pdfBuffer.byteLength);
    data.set(pdfBuffer);

    const loadingTask = getDocument({
      data,
      useSystemFonts: true,
      standardFontDataUrl,
      cMapUrl,
      cMapPacked: true,
      useWorkerFetch: false,
      isEvalSupported: false,
    });

    const doc = await loadingTask.promise;
    const numPages = Math.min(doc.numPages, MAX_OCR_PAGES);
    if (numPages === 0) {
      await doc.destroy().catch(() => undefined);
      logVision("OCR_VISION_FAILED", { reason: "zero_pages" });
      return {
        text: "",
        pageCountRasterized: 0,
        engine: "openai-vision",
        skippedReason: "pdf.js reported zero pages",
      };
    }

    const scale = VISION_RENDER_DPI / 72;
    const pageImages: { pageIndex: number; jpeg: Buffer }[] = [];

    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const w = Math.max(1, Math.ceil(viewport.width));
      const h = Math.max(1, Math.ceil(viewport.height));
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        await page.cleanup();
        throw new Error("canvas getContext('2d') returned null");
      }
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const jpegBuf = await canvas.encode("jpeg", JPEG_QUALITY);
      pageImages.push({ pageIndex: i, jpeg: Buffer.from(jpegBuf) });
      await page.cleanup();
    }

    await doc.destroy().catch(() => undefined);

    const batchCount = Math.ceil(pageImages.length / VISION_BATCH_SIZE);
    logVision("OCR_VISION_START", {
      pageCount: pageImages.length,
      batchCount,
      model,
      renderDpi: VISION_RENDER_DPI,
    });

    const client = new OpenAI({ apiKey });
    const parts: string[] = [];

    for (let b = 0; b < batchCount; b++) {
      const slice = pageImages.slice(b * VISION_BATCH_SIZE, (b + 1) * VISION_BATCH_SIZE);
      const startPage = slice[0]?.pageIndex ?? 1;
      const endPage = slice[slice.length - 1]?.pageIndex ?? startPage;

      const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
        {
          type: "text",
          text: `These are PDF pages ${startPage}–${endPage} (document has ${numPages} page(s) in this OCR pass). Transcribe all visible text. For each page, output the text for that page only; separate pages using exactly this delimiter on its own line:\n\n--- page break ---\n\nIf a page has no text, output (no text) for that page.`,
        },
      ];

      for (const { jpeg } of slice) {
        const b64 = jpeg.toString("base64");
        userContent.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
        });
      }

      const completion = await client.chat.completions.create({
        model,
        max_tokens: 8192,
        temperature: 0,
        messages: [
          { role: "system", content: VISION_OCR_SYSTEM },
          { role: "user", content: userContent },
        ],
      });

      const choice = completion.choices[0];
      const raw = choice?.message?.content;
      const chunk = typeof raw === "string" ? raw.trim() : "";
      if (!chunk) {
        logVision("OCR_VISION_FAILED", {
          reason: "empty_completion",
          batchIndex: b,
          startPage,
          endPage,
        });
        return {
          text: "",
          pageCountRasterized: pageImages.length,
          engine: "openai-vision",
          skippedReason: "OpenAI vision returned empty content for a batch",
          errorMessage: `batch ${b + 1}/${batchCount} pages ${startPage}-${endPage}`,
        };
      }
      parts.push(chunk);
    }

    const text = parts.join("\n\n--- page break ---\n\n").trim();
    logVision("OCR_VISION_SUCCESS", {
      textLen: text.length,
      pageCount: pageImages.length,
      batchCount,
      model,
    });

    return {
      text,
      pageCountRasterized: pageImages.length,
      engine: "openai-vision",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logVision("OCR_VISION_FAILED", { reason: "exception", errorMessage: msg });
    return {
      text: "",
      pageCountRasterized: 0,
      engine: "openai-vision",
      skippedReason: "OpenAI vision OCR pipeline error",
      errorMessage: msg,
    };
  }
}
