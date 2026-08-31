/**
 * Full backfill for `basin_operators` — crawls TRRC's public W-1 New Drill
 * search across every Permian Basin + Eagle Ford county individually
 * (not combined into one multi-county query — see below), covering
 * January 2015 onward (the modern unconventional/shale era in both
 * basins), and aggregates every distinct operator seen into the
 * basin_operators table.
 *
 * Two corners deliberately NOT cut, both found the hard way:
 *
 * 1. Per-county, not combined. A combined query across all 55 counties
 *    and a wide date range silently returns ZERO rows past some internal
 *    TRRC threshold instead of erroring or truncating — confirmed
 *    reproducible (same window, re-run twice, same silent empty result).
 *    Querying one county at a time keeps each request's real result
 *    volume low enough to stay clear of that failure mode entirely, and
 *    was verified clean even on the busiest county (Midland) at 300+
 *    real rows per 90-day window.
 * 2. maxPages is set high (not left at the default 15-page/300-row cap
 *    used by the live on-demand search) so a busy county/window is fully
 *    paginated instead of silently truncated. Confirmed against real data:
 *    Midland alone, one 90-day window, returned 370 rows with the raised
 *    cap — 70 more than the default cap would have captured.
 *
 * Run with: npx tsx scripts/sync-basin-operators.ts
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment (.env.local is NOT auto-loaded — export them first).
 */

import { createClient } from "@supabase/supabase-js";
import { searchNewDrillPermits } from "../lib/trrc/permit-tracker/fetch-permits";
import { ALL_BASIN_COUNTIES, basinsForCounty } from "../lib/trrc/permit-tracker/county-groups";

const HISTORY_START = new Date("2015-01-01"); // modern unconventional era, both basins
const CHUNK_DAYS = 90; // stays under fetch-permits.ts's 92-day cap
const MAX_PAGES = 200; // 4,000-row ceiling per chunk — a real safety backstop, not a realistic cap
const DELAY_BETWEEN_REQUESTS_MS = 800; // pace requests against TRRC's public system
const MAX_RETRIES = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Aggregate {
  orgName: string;
  basins: Set<string>;
  permitCount: number;
  firstSeen: string | null; // YYYY-MM-DD
  lastSeen: string | null;
}

function toIsoDate(mmddyyyy: string | null): string | null {
  if (!mmddyyyy) return null;
  const m = mmddyyyy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function buildChunks(start: Date, end: Date): { since: Date; until: Date }[] {
  const chunks: { since: Date; until: Date }[] = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const until = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000, end.getTime()));
    chunks.push({ since: new Date(cursor), until });
    cursor = new Date(until.getTime() + 24 * 60 * 60 * 1000);
  }
  return chunks;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const now = new Date();
  const chunks = buildChunks(HISTORY_START, now);
  const totalRequests = ALL_BASIN_COUNTIES.length * chunks.length;

  console.log(`Crawling ${ALL_BASIN_COUNTIES.length} counties x ${chunks.length} ~${CHUNK_DAYS}-day windows since ${HISTORY_START.toISOString().slice(0, 10)} = ${totalRequests} requests.`);
  console.log(`At ~${DELAY_BETWEEN_REQUESTS_MS}ms/request this will take roughly ${Math.round((totalRequests * (DELAY_BETWEEN_REQUESTS_MS + 1800)) / 60000)} minutes.\n`);

  const aggregates = new Map<string, Aggregate>();
  let totalRowsSeen = 0;
  let requestsDone = 0;
  let failedRequests = 0;
  const truncatedChunks: string[] = [];

  for (const county of ALL_BASIN_COUNTIES) {
    let countyRows = 0;
    for (const chunk of chunks) {
      const label = `${county} ${chunk.since.toISOString().slice(0, 10)}→${chunk.until.toISOString().slice(0, 10)}`;
      let attempt = 0;
      let ok = false;
      while (attempt <= MAX_RETRIES && !ok) {
        try {
          const result = await searchNewDrillPermits({ counties: [county], since: chunk.since, until: chunk.until, maxPages: MAX_PAGES });
          totalRowsSeen += result.rows.length;
          countyRows += result.rows.length;
          if (result.truncated) truncatedChunks.push(label);

          for (const row of result.rows) {
            if (!row.operatorNumber || !row.operatorName) continue;
            const basins = basinsForCounty(row.county ?? county);
            if (basins.length === 0) continue;

            const existing = aggregates.get(row.operatorNumber);
            const isoDate = toIsoDate(row.applicationDate);
            if (existing) {
              basins.forEach((b) => existing.basins.add(b));
              existing.permitCount++;
              if (isoDate && (!existing.firstSeen || isoDate < existing.firstSeen)) existing.firstSeen = isoDate;
              if (isoDate && (!existing.lastSeen || isoDate > existing.lastSeen)) existing.lastSeen = isoDate;
            } else {
              aggregates.set(row.operatorNumber, {
                orgName: row.operatorName,
                basins: new Set(basins),
                permitCount: 1,
                firstSeen: isoDate,
                lastSeen: isoDate,
              });
            }
          }
          ok = true;
        } catch (err) {
          attempt++;
          if (attempt > MAX_RETRIES) {
            console.log(`  FAILED (${MAX_RETRIES + 1} attempts): ${label} — ${err instanceof Error ? err.message : err}`);
            failedRequests++;
          } else {
            await sleep(DELAY_BETWEEN_REQUESTS_MS * 2);
          }
        }
      }
      requestsDone++;
      if (requestsDone % 100 === 0) {
        console.log(`  [${requestsDone}/${totalRequests}] ${aggregates.size} distinct operators so far, ${totalRowsSeen} rows seen, ${failedRequests} failed requests...`);
      }
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }
    console.log(`${county}: ${countyRows} rows across full history.`);
  }

  console.log(`\nDone crawling. Aggregated ${aggregates.size} distinct operators from ${totalRowsSeen} total permit rows across ${requestsDone} requests (${failedRequests} failed).`);
  if (truncatedChunks.length > 0) {
    console.log(`WARNING: ${truncatedChunks.length} chunk(s) still hit the ${MAX_PAGES}-page cap — coverage may be incomplete for: ${truncatedChunks.slice(0, 10).join(", ")}${truncatedChunks.length > 10 ? "…" : ""}`);
  } else {
    console.log("No chunk hit the pagination cap — every window was fully captured.");
  }

  const upsertRows = Array.from(aggregates.entries()).map(([orgNumber, agg]) => ({
    org_number: orgNumber,
    org_name: agg.orgName,
    basins: Array.from(agg.basins),
    permit_count: agg.permitCount,
    first_seen: agg.firstSeen,
    last_seen: agg.lastSeen,
    synced_at: new Date().toISOString(),
  }));

  const batchSize = 500;
  for (let i = 0; i < upsertRows.length; i += batchSize) {
    const batch = upsertRows.slice(i, i + batchSize);
    const { error } = await supabase.from("basin_operators").upsert(batch, { onConflict: "org_number" });
    if (error) {
      console.error(`Upsert batch ${i}-${i + batch.length} failed:`, error.message);
    } else {
      console.log(`Upserted batch ${i}-${i + batch.length}.`);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
