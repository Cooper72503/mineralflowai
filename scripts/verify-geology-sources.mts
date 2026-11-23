/**
 * Verify the geological evidence against the original PDFs, then rebuild every
 * reservoir study so its numbers can be compared run to run.
 *
 *   node --import tsx scripts/verify-geology-sources.mts <directory holding the PDFs>
 *
 * Checks: each registered PDF's SHA-256 and page count; for documents with a
 * text layer, that the exact words recorded for each value are on the cited PDF
 * page (pdftotext). Scanned documents are listed as image-transcribed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CALIBRATIONS, DOCUMENTS, EVIDENCE_VERSION, MEASUREMENTS } from "../frontend/lib/geology/evidence/registry.ts";
import { validateEvidence } from "../frontend/lib/geology/evidence/validate.ts";
import { buildReservoirStudy } from "../frontend/lib/geology/reservoir-study.ts";
import { RESERVOIRS } from "../frontend/lib/geology/reservoirs.ts";

const dir = process.argv[2];
if (!dir) throw Error("usage: verify-geology-sources.mts <directory holding the source PDFs>");
let failures = 0;
const ok = (pass: boolean, line: string) => { if (!pass) failures++; console.log(`${pass ? "PASS" : "FAIL"}  ${line}`); };
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

for (const e of validateEvidence(DOCUMENTS, MEASUREMENTS, CALIBRATIONS)) ok(false, `registry: ${e}`);
for (const d of DOCUMENTS) {
  const file = path.join(dir, d.fileName);
  if (!existsSync(file)) { ok(false, `${d.id}: ${d.fileName} not found in ${dir}`); continue; }
  ok(createHash("sha256").update(readFileSync(file)).digest("hex") === d.sha256, `${d.id}: SHA-256 matches the registered file`);
  const pages = Number(execFileSync("pdfinfo", [file]).toString().match(/^Pages:\s+(\d+)/m)?.[1]);
  ok(pages === d.pdfPages, `${d.id}: ${pages} pages`);
  for (const m of MEASUREMENTS.filter(x => x.source.documentId === d.id)) {
    if (!d.textLayer) { console.log(`  —   ${m.id}: transcribed from the page image, PDF p. ${m.source.pdfPage} (${m.source.locator})`); continue; }
    const text = squash(execFileSync("pdftotext", ["-f", String(m.source.pdfPage), "-l", String(m.source.pdfPage), "-layout", file, "-"]).toString());
    for (const words of m.extraction.verifyText ?? []) ok(text.includes(squash(words)), `${m.id}: "${words}" is on PDF p. ${m.source.pdfPage}`);
  }
}

console.log(`\nStudies (evidence ${EVIDENCE_VERSION}):`);
for (const r of RESERVOIRS) {
  const s = buildReservoirStudy(r);
  const v = s.hcpv.status === "calculated" ? s.hcpv.value : null;
  console.log(`  ${r.id}: ${s.status}; fingerprint ${s.fingerprint}${v ? `; HCPV ${Math.round(v.low!).toLocaleString()} / ${Math.round(v.central).toLocaleString()} / ${Math.round(v.high!).toLocaleString()} rb` : ""}; missing: ${s.missing.map(x => x.label).join(", ") || "none"}`);
}
console.log(failures ? `\nFAILED: ${failures} check(s)` : "\nAll source checks passed.");
process.exit(failures ? 1 : 0);
