/**
 * Renders the generated Acquisition Decision Record HTML to PDF.
 *
 * Lives in the worker because that is the package that owns Playwright; the
 * HTML it consumes is produced by frontend/scripts/generate-decision-record-sample.ts.
 * Kept as a committed script rather than an ad-hoc command so the page geometry
 * page 1 is laid out against — Letter, 0.5in top, 0.72in bottom to clear the
 * footer, 9.78in usable — is reproducible. Page 1 is a fixed-height decision
 * screen; changing these margins changes what fits on it.
 *
 *   node worker/scripts/render-decision-record-pdf.mjs <html> <pdf>
 */
import { chromium } from "playwright";
import path from "node:path";

const [, , htmlArg, pdfArg] = process.argv;
if (!htmlArg || !pdfArg) {
  console.error("usage: render-decision-record-pdf.mjs <html> <pdf>");
  process.exit(1);
}

const FOOT =
  '<div style="width:100%;font:8px Georgia,serif;color:#8a8378;padding:0 .55in;' +
  'display:flex;justify-content:space-between;letter-spacing:.06em">' +
  "<span>ILLUSTRATIVE SAMPLE &middot; SYNTHETIC DATA &middot; NOT A TITLE OPINION</span>" +
  '<span>MineralFlow AI &nbsp;&middot;&nbsp; Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
  "</div>";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("file://" + path.resolve(htmlArg), { waitUntil: "networkidle" });
await page.emulateMedia({ media: "print" });
await page.evaluate(() => document.fonts.ready);
await page.pdf({
  path: path.resolve(pdfArg),
  format: "Letter",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate: FOOT,
  margin: { top: "0.5in", bottom: "0.72in", left: "0.55in", right: "0.55in" },
});
await browser.close();
console.log("rendered " + path.resolve(pdfArg));
