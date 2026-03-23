/**
 * Rasterize PDF pages with Poppler's pdftoppm (CLI), then OCR PNGs with tesseract.js.
 * Keeps PDF.js / DOMMatrix out of the OCR path so this runs in plain Node.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const execFileAsync = promisify(execFile);

const MAX_OCR_PAGES = 25;
const OCR_DPI = 200;

export type PdfOcrResult = {
  text: string;
  pageCountRasterized: number;
  engine: "poppler+tesseract.js";
  skippedReason?: string;
  errorMessage?: string;
};

function sortPngPages(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const ma = a.match(/(\d+)\.png$/i);
    const mb = b.match(/(\d+)\.png$/i);
    return (parseInt(ma?.[1] ?? "0", 10) || 0) - (parseInt(mb?.[1] ?? "0", 10) || 0);
  });
}

/**
 * OCR a PDF by rasterizing with `pdftoppm` then running tesseract.js on each page image.
 * Returns empty text with skippedReason if Poppler is not installed or rasterization yields no images.
 */
export async function ocrPdfWithPopplerAndTesseract(pdfBuffer: Buffer): Promise<PdfOcrResult> {
  const base = await mkdtemp(path.join(os.tmpdir(), "mineral-pdf-ocr-"));
  const pdfPath = path.join(base, "input.pdf");
  const rasterPrefix = path.join(base, "page");

  try {
    await writeFile(pdfPath, pdfBuffer);

    try {
      await execFileAsync(
        "pdftoppm",
        ["-png", "-r", String(OCR_DPI), "-f", "1", "-l", String(MAX_OCR_PAGES), pdfPath, rasterPrefix],
        { maxBuffer: 50 * 1024 * 1024 }
      );
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e?.code === "ENOENT") {
        return {
          text: "",
          pageCountRasterized: 0,
          engine: "poppler+tesseract.js",
          skippedReason:
            "pdftoppm not found in PATH (install Poppler: macOS `brew install poppler`, Debian/Ubuntu `apt install poppler-utils`).",
        };
      }
      return {
        text: "",
        pageCountRasterized: 0,
        engine: "poppler+tesseract.js",
        skippedReason: "pdftoppm failed",
        errorMessage: e?.message ?? String(err),
      };
    }

    const allFiles = await readdir(base);
    const pngs = sortPngPages(allFiles.filter((f) => f.toLowerCase().endsWith(".png")));

    if (pngs.length === 0) {
      return {
        text: "",
        pageCountRasterized: 0,
        engine: "poppler+tesseract.js",
        skippedReason: "pdftoppm produced no PNG pages (PDF may be empty or unsupported).",
      };
    }

    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    const parts: string[] = [];

    try {
      for (const name of pngs) {
        const fp = path.join(base, name);
        const buf = await readFile(fp);
        const { data } = await worker.recognize(buf);
        parts.push(typeof data?.text === "string" ? data.text : "");
      }
    } finally {
      await worker.terminate().catch(() => undefined);
    }

    const text = parts.join("\n\n--- page break ---\n\n").trim();
    return {
      text,
      pageCountRasterized: pngs.length,
      engine: "poppler+tesseract.js",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: "",
      pageCountRasterized: 0,
      engine: "poppler+tesseract.js",
      skippedReason: "OCR pipeline error",
      errorMessage: msg,
    };
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}
