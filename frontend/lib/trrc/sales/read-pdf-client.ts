"use client";

/**
 * Reads a PDF's text in the browser, so a large statement (a 37-page scan
 * bundle is ~16 MB) never has to pass the server's request-size limit; only
 * the text and the file's hash are sent.
 */
import { pageTextFromItems, sha256Hex, type PdfTextItem } from "./pdf-text";

export async function readPdfText(file: File): Promise<{ fileName: string; sha256: string; pages: string[] }> {
  const pdfjs = await import("pdfjs-dist");
  // Served from public/ (scripts/copy-pdf-worker.mjs): the bundler's minifier cannot parse the worker module.
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(pageTextFromItems(content.items.filter((i): i is PdfTextItem & typeof i => "str" in i) as PdfTextItem[]));
  }
  await doc.destroy();
  return { fileName: file.name, sha256, pages };
}
