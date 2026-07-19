/**
 * Production OCR path: render PDF pages with pdf.js + @napi-rs/canvas, then tesseract.js.
 * Does not require Poppler (pdftoppm) on PATH.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { PdfOcrResult } from "./pdf-ocr";

const MAX_OCR_PAGES = 25;
const OCR_DPI = 200;

function resolvePdfAssetUrls(): { workerSrc: string; standardFontDataUrl: string; cMapUrl: string } {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("pdfjs-dist/package.json");
  const distRoot = dirname(pkgJson);
  return {
    // Legacy build is required for Node.js (see pdf.js console warning on non-legacy import).
    workerSrc: pathToFileURL(join(distRoot, "legacy", "build", "pdf.worker.mjs")).href,
    standardFontDataUrl: pathToFileURL(join(distRoot, "standard_fonts")).href + "/",
    cMapUrl: pathToFileURL(join(distRoot, "cmaps")).href + "/",
  };
}

/**
 * Rasterize with pdf.js, OCR each page with tesseract.js.
 */
export async function ocrPdfWithPdfJsAndTesseract(pdfBuffer: Buffer): Promise<PdfOcrResult> {
  let createCanvas: typeof import("@napi-rs/canvas").createCanvas;
  try {
    ({ createCanvas } = await import("@napi-rs/canvas"));
  } catch (err: unknown) {
    const e = err instanceof Error ? err.message : String(err);
    return {
      text: "",
      pageCountRasterized: 0,
      engine: "pdf.js+tesseract.js",
      skippedReason: "@napi-rs/canvas failed to load",
      errorMessage: e,
    };
  }

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
      return {
        text: "",
        pageCountRasterized: 0,
        engine: "pdf.js+tesseract.js",
        skippedReason: "pdf.js reported zero pages",
      };
    }

    const { createWorker } = await import("tesseract.js");
    const ocrWorker = await createWorker("eng");
    const parts: string[] = [];
    const pageConfidences: number[] = [];

    try {
      for (let i = 1; i <= numPages; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: OCR_DPI / 72 });
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
        const pngBuf = await canvas.encode("png");
        const { data: tessData } = await ocrWorker.recognize(pngBuf);
        parts.push(typeof tessData?.text === "string" ? tessData.text : "");
        if (typeof tessData?.confidence === "number" && Number.isFinite(tessData.confidence)) {
          pageConfidences.push(tessData.confidence);
        }
        await page.cleanup();
      }
    } finally {
      await ocrWorker.terminate().catch(() => undefined);
      await doc.destroy().catch(() => undefined);
    }

    const text = parts.join("\n\n--- page break ---\n\n").trim();
    const meanConfidence =
      pageConfidences.length > 0
        ? pageConfidences.reduce((a, b) => a + b, 0) / pageConfidences.length
        : undefined;

    return {
      text,
      pageCountRasterized: numPages,
      engine: "pdf.js+tesseract.js",
      meanConfidence,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: "",
      pageCountRasterized: 0,
      engine: "pdf.js+tesseract.js",
      skippedReason: "pdf.js OCR pipeline error",
      errorMessage: msg,
    };
  }
}
