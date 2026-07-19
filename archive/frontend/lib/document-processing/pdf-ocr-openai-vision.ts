/**
 * OCR via OpenAI vision (image input). Renders PDF pages with pdf.js + @napi-rs/canvas;
 * no Poppler or Tesseract. Suitable for serverless (e.g. Vercel) when OPENAI_API_KEY is set.
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import OpenAI from "openai";

import type { PdfOcrResult } from "./pdf-ocr";

const EXTRACT_LOG = "[extract]";

const MAX_OCR_PAGES = 25;
/** Moderate DPI to balance readability vs request payload size. */
const VISION_RENDER_DPI = 120;
const VISION_BATCH_SIZE = 4;
const JPEG_QUALITY = 82;

/**
 * Resolve pdfjs-dist root on disk. Do not use `require.resolve("pdfjs-dist/package.json")` here:
 * Next.js/webpack can replace that call with a numeric module id, so `path.dirname` / `path.join`
 * then throw ERR_INVALID_ARG_TYPE (e.g. "path must be string, received number (4273)").
 */
function resolvePdfjsDistRoot(): string {
  if (typeof import.meta.resolve === "function") {
    try {
      const resolved = import.meta.resolve("pdfjs-dist/package.json");
      return dirname(fileURLToPath(resolved));
    } catch {
      /* fall through */
    }
  }
  return join(process.cwd(), "node_modules", "pdfjs-dist");
}

function resolvePdfFontAndCmapUrls(): { standardFontDataUrl: string; cMapUrl: string } {
  const distRoot = resolvePdfjsDistRoot();
  return {
    standardFontDataUrl: pathToFileURL(join(distRoot, "standard_fonts")).href + "/",
    cMapUrl: pathToFileURL(join(distRoot, "cmaps")).href + "/",
  };
}

/**
 * On Node, pdf.js disables real Web Workers and uses a fake worker, but it still loads
 * `WorkerMessageHandler` via `import(GlobalWorkerOptions.workerSrc)`. The library default is
 * `./pdf.worker.mjs`, which is not next to the deployed bundle on Vercel. Supplying the handler
 * from the package entry uses Node module resolution (no workerSrc file path).
 */
async function ensurePdfjsWorkerMainThreadForNode(): Promise<void> {
  const g = globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler: unknown };
  };
  if (g.pdfjsWorker?.WorkerMessageHandler) {
    return;
  }
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  g.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
}

const VISION_OCR_SYSTEM = `You transcribe scanned or photographed document pages. Output ONLY the visible text, preserving reading order and line breaks where reasonable. Do not add labels like "Page 1". Do not describe the document. If a page has no readable text, output a single line: (no text)`;

type VisionStep = "pdf_load" | "worker_setup" | "canvas_create" | "page_render" | "image_encode" | "openai_request";

function logVision(event: "OCR_VISION_START" | "OCR_VISION_SUCCESS" | "OCR_VISION_FAILED", payload: Record<string, unknown>): void {
  console.log(`${EXTRACT_LOG} ${event}`, payload);
}

function logVisionStep(step: VisionStep, payload?: Record<string, unknown>): void {
  console.log(`${EXTRACT_LOG} OCR_VISION_STEP`, { step, ...payload });
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

  let step: VisionStep = "worker_setup";

  try {
    logVision("OCR_VISION_START", { model, renderDpi: VISION_RENDER_DPI, maxPages: MAX_OCR_PAGES });

    await ensurePdfjsWorkerMainThreadForNode();
    logVisionStep("worker_setup", { mode: "no_worker_server" });

    const { standardFontDataUrl, cMapUrl } = resolvePdfFontAndCmapUrls();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { getDocument } = pdfjs;

    step = "pdf_load";
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
    logVisionStep("pdf_load", { byteLength: pdfBuffer.byteLength, numPages: doc.numPages });
    const numPages = Math.min(doc.numPages, MAX_OCR_PAGES);
    if (numPages === 0) {
      await doc.destroy().catch(() => undefined);
      logVision("OCR_VISION_FAILED", { reason: "zero_pages", step: "pdf_load" });
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
      step = "page_render";
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const w = Math.max(1, Math.ceil(viewport.width));
      const h = Math.max(1, Math.ceil(viewport.height));
      logVisionStep("canvas_create", { pageIndex: i, width: w, height: h });
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        await page.cleanup();
        throw new Error("canvas getContext('2d') returned null");
      }
      logVisionStep("page_render", { page: i });
      try {
        await page.render({
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
      } catch (renderErr: unknown) {
        const e = renderErr instanceof Error ? renderErr : new Error(String(renderErr));
        logVision("OCR_VISION_FAILED", {
          reason: "page_render",
          step: "page_render",
          page: i,
          errorMessage: e.message,
          errorStack: e.stack,
        });
        await page.cleanup().catch(() => undefined);
        await doc.destroy().catch(() => undefined);
        return {
          text: "",
          pageCountRasterized: 0,
          engine: "openai-vision",
          skippedReason: "OpenAI vision OCR pipeline error",
          errorMessage: e.message,
        };
      }
      step = "image_encode";
      logVisionStep("image_encode", { pageIndex: i });
      const jpegBuf = await canvas.encode("jpeg", JPEG_QUALITY);
      pageImages.push({ pageIndex: i, jpeg: Buffer.from(jpegBuf) });
      await page.cleanup();
    }

    await doc.destroy().catch(() => undefined);

    const batchCount = Math.ceil(pageImages.length / VISION_BATCH_SIZE);

    const client = new OpenAI({ apiKey });
    const parts: string[] = [];

    for (let b = 0; b < batchCount; b++) {
      step = "openai_request";
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

      logVisionStep("openai_request", {
        batchIndex: b,
        startPage,
        endPage,
        imageCount: slice.length,
        model,
      });
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
          step: "openai_request",
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
      renderDpi: VISION_RENDER_DPI,
    });

    return {
      text,
      pageCountRasterized: pageImages.length,
      engine: "openai-vision",
    };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logVision("OCR_VISION_FAILED", {
      reason: "exception",
      step,
      errorMessage: e.message,
      errorStack: e.stack,
    });
    return {
      text: "",
      pageCountRasterized: 0,
      engine: "openai-vision",
      skippedReason: "OpenAI vision OCR pipeline error",
      errorMessage: e.message,
    };
  }
}
