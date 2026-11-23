/** Independent source-record checks on a captured real pilot. Not a live-account acceptance. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderFinderReport } from "../frontend/lib/mineral-finder/report";
const dir = process.argv[2] ?? "/tmp/mineral-finder-live";
const result = JSON.parse(
  await readFile(path.join(dir, "result.json"), "utf8"),
);
const bulk = JSON.parse(
  await readFile(path.join(dir, "rrc-wellbore.json"), "utf8"),
);
const catalog = JSON.parse(
  await readFile(path.join(dir, "beg-catalog.json"), "utf8"),
);
const gis = JSON.parse(await readFile(path.join(dir, "rrc-gis.json"), "utf8"));
let checked = 0;
assert(result.prospects.length <= 25);
assert.equal(result.classification, "research_screening");
for (const p of result.prospects) {
  assert(bulk.records.some((r: any) => r.api === p.api));
  assert(
    gis.rows.some(
      (r: any) =>
        "42" + String(r.API) === p.api &&
        Math.abs(Number(r.GIS_LAT83) - p.well.lat) < 0.00001,
    ),
  );
  assert(p.ageEvidence.date < `${result.criteria.beforeYear}-01-01`);
  assert.equal(p.economics.status, "insufficient_data");
  assert.equal(p.geologicalConfidence, "low");
  assert.equal(
    p.score,
    p.scoreExplanation.reduce((s: number, e: any) => s + e.points, 0),
  );
  assert(p.risks.some((s: string) => s.includes("rights")));
  for (const o of p.offsets) {
    assert(o.distanceMiles <= result.criteria.radiusMiles);
    const other = bulk.records.filter(
      (r: any) => r.api === o.api && r.association.onSchedule,
    );
    assert(
      other.some(
        (r: any) =>
          r.association.fieldNumber === p.well.association.fieldNumber,
      ),
    );
  }
  for (const c of p.catalog) {
    assert(catalog.records.some((r: any) => r.id === c.id && r.api === p.api));
  }
  for (const r of p.purchases) {
    assert.equal(r.approval, "required");
    assert(p.catalog.some((c: any) => c.id === r.itemId));
    assert(r.estimatedUsd === null || r.pricingCheckedAt);
  }
  checked++;
}
const first = result.prospects[0];
if (first)
  await writeFile(
    path.join(dir, "selected-prospect.pdf"),
    await renderFinderReport(result, first.api),
  );
console.log(
  `PASS: ${checked} real research leads checked against captured official RRC rows/locations and BEG items; field/radius matching, score arithmetic, purchase approval and withheld economics. This does not validate reservoirs or live authenticated app persistence.`,
);
