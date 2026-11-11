/**
 * Page text from pdfjs text items, one line per row of the page (items
 * grouped by baseline, read left to right). pdfjs returns items in drawing
 * order, which on generated statements is not reliably reading order.
 */
export interface PdfTextItem { str: string; transform: number[] }

export function pageTextFromItems(items: PdfTextItem[]): string {
  const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    const row = rows.find(r => Math.abs(r.y - y) < 2.5);
    if (row) row.parts.push({ x, s: it.str }); else rows.push({ y, parts: [{ x, s: it.str }] });
  }
  return rows.sort((a, b) => b.y - a.y).map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.s.trim()).join(" ")).join("\n");
}

/** Hex SHA-256 of a file's bytes, in the browser or Node. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
