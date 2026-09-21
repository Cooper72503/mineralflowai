import { getBrowser } from "./browser.js";
import { PDFDocument } from "pdf-lib";

export type CountyDocument = { ok: true; bytes: Buffer; pageCount: number; sourceUrl: string } | { ok: false; error: string };
export function validatePreviewUrl(value: string, documentUrl: string): string {
  const doc = new URL(documentUrl), image = new URL(value);
  const id = doc.pathname.match(/^\/doc\/(\d+)$/)?.[1];
  if (!id || doc.protocol !== "https:" || !/^[a-z]+\.tx\.publicsearch\.us$/.test(doc.hostname) || doc.port || doc.username || doc.password ||
      image.origin !== doc.origin || image.username || image.password || !image.pathname.startsWith(`/files/documents/${id}/images/`)) {
    throw new Error("Untrusted or mismatched county preview URL");
  }
  return image.href;
}

/** Uses only images exposed by the public viewer, preserving all pages and marks.
 * No login, purchase, hidden endpoint, or original-quality download is attempted.
 */
export async function getCountyDocument(sourceUrl: string): Promise<CountyDocument> {
  let context: Awaited<ReturnType<Awaited<ReturnType<typeof getBrowser>>["newContext"]>> | undefined;
  try {
    const doc = new URL(sourceUrl);
    if (doc.protocol !== "https:" || !/^[a-z]+\.tx\.publicsearch\.us$/.test(doc.hostname) || doc.port || doc.username || doc.password || !/^\/doc\/\d+$/.test(doc.pathname) || doc.search) throw new Error("Unsupported county document URL");
    context = await (await getBrowser()).newContext();
    const page = await context.newPage();
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (new URL(page.url()).origin !== doc.origin || new URL(page.url()).pathname !== doc.pathname) throw new Error("County viewer redirected away from the requested document; access not established");
    const control = page.locator('section[aria-label="Document viewer"] input[type="number"]');
    await control.waitFor({ state: "visible", timeout: 20_000 });
    const pageCount = Number(await control.getAttribute("max"));
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20) throw new Error("County document page count unavailable or exceeds 20-page retrieval limit");
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date(0));
    pdf.setModificationDate(new Date(0));
    pdf.setTitle("County public preview — not a certified copy");
    let previousPath = "", totalBytes = 0;
    for (let n = 1; n <= pageCount; n++) {
      await page.waitForFunction(({ n, previousPath }) => {
        const input = document.querySelector('section[aria-label="Document viewer"] input') as HTMLInputElement | null;
        const image = document.querySelector('[aria-label="Document preview image"] image');
        const src = image?.getAttribute("href") ?? image?.getAttribute("xlink:href");
        return input?.value === String(n) && !!src && new URL(src).pathname !== previousPath;
      }, { n, previousPath }, { timeout: 20_000 });
      const src = await page.locator('[aria-label="Document preview image"] image').evaluate(el => el.getAttribute("href") ?? el.getAttribute("xlink:href"));
      const url = validatePreviewUrl(src ?? "", sourceUrl);
      previousPath = new URL(url).pathname;
      const response = await context.request.get(url, { timeout: 30_000, maxRedirects: 0 });
      if (!response.ok()) throw new Error(`County preview request returned HTTP ${response.status()}`);
      const bytes = await response.body();
      totalBytes += bytes.length;
      if (totalBytes > 30 * 1024 * 1024) throw new Error("County preview exceeds 30 MB retrieval limit");
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!isPng && !isJpeg) throw new Error("County preview response is not a PNG/JPEG image");
      const embedded = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      pdf.addPage([embedded.width, embedded.height]).drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
      await response.dispose();
      if (n < pageCount) await page.getByRole("button", { name: "Go To Next Page", exact: true }).click();
    }
    return { ok: true, bytes: Buffer.from(await pdf.save()), pageCount, sourceUrl };
  } catch (e) {
    // Do not persist signed preview URLs or browser error dumps containing them.
    return { ok: false, error: e instanceof Error && /^(County|Unsupported|Untrusted)/.test(e.message) ? e.message : "Public county preview retrieval failed; viewer may require access, be unavailable, or have changed. No complete document stored." };
  } finally { await context?.close(); }
}
