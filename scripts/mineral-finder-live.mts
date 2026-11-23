/** Real-source pilot, no database credentials needed. Captured metadata may be replayed by directory. */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  ingestWellbore,
  ingestGis,
  ingestBeg,
  mergeWells,
} from "../frontend/lib/mineral-finder/ingestion";
import { runFinder } from "../frontend/lib/mineral-finder/run";
import { parseFinderRequest } from "../frontend/lib/mineral-finder/criteria";
import { renderFinderReport } from "../frontend/lib/mineral-finder/report";
import { getProduction } from "../worker/src/tools/ewa";
const value = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i < 0 ? fallback : process.argv[i + 1];
};
const out = path.resolve(value("--output", "/tmp/mineral-finder-live"));
const county = value("--county", "GAINES").toUpperCase();
if (!["GAINES", "FISHER"].includes(county))
  throw Error("Pilot counties: Gaines or Fisher");
const criteria = parseFinderRequest(
  `Find historical plugged and inactive wells in ${county} County before ${value("--before", "1995")}`,
  { limit: Number(value("--limit", "25")) },
);
await mkdir(out, { recursive: true });
async function capture<T>(name: string, load: () => Promise<T>): Promise<T> {
  const file = path.join(out, `${name}.json`);
  if (process.argv.includes("--replay")) {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (name.startsWith("production-") && !saved.retrievedAt)
        saved.retrievedAt = (await stat(file)).mtime.toISOString();
      console.log("Reusing captured source", name);
      return saved;
    } catch {}
  }
  console.log("Fetching", name);
  const data = await load();
  await writeFile(file, JSON.stringify(data));
  return data;
}
const bulk = await capture("rrc-wellbore", () =>
  ingestWellbore(criteria.county),
);
const gis = await capture("rrc-gis", () => ingestGis(criteria.county));
const begEnabled = process.argv.includes("--beg-catalog-research");
const beg = begEnabled
  ? await capture("beg-catalog", () => ingestBeg(criteria.county))
  : null;
const snapshot = {
  wells: mergeWells(criteria.county, bulk.records, gis.rows),
  catalog: beg?.records ?? [],
  sources: [bulk.source, gis.source, ...(beg ? [beg.source] : [])],
};
await writeFile(path.join(out, "snapshot.json"), JSON.stringify(snapshot));
const result = await runFinder(
  null,
  criteria,
  `Find plugged and inactive wells in ${county} County before ${criteria.beforeYear}. Compare producing offsets within ${criteria.radiusMiles} miles and rank up to ${criteria.limit} research leads. ${begEnabled ? "BEG metadata research access only; commercial reuse unconfirmed." : "BEG not requested."}`,
  {
    production: process.argv.includes("--no-production")
      ? undefined
      : async (lease, district, type) =>
          capture(`production-${district}-${type}-${lease}`, async () => ({
            ...(await getProduction(lease, district, type)),
            retrievedAt: new Date().toISOString(),
          })),
    progress: async (stage) => {
      console.log(stage);
    },
  },
  snapshot,
);
await writeFile(path.join(out, "result.json"), JSON.stringify(result, null, 2));
await writeFile(
  path.join(out, "prospects.pdf"),
  await renderFinderReport(result),
);
console.log(
  JSON.stringify(
    {
      wells: result.wells,
      eligible: result.eligible,
      ranked: result.prospects.length,
      catalog: snapshot.catalog.length,
      purchases: result.purchases.length,
      sources: result.sources.map((s) => ({
        id: s.id,
        status: s.status,
        count: s.count,
      })),
      top: result.prospects
        .slice(0, 3)
        .map((p) => ({
          api: p.api,
          score: p.score,
          offsets: p.offsets.length,
          logs: p.catalog.length,
          age: p.ageEvidence,
        })),
      excluded: result.excluded,
      output: out,
    },
    null,
    2,
  ),
);
