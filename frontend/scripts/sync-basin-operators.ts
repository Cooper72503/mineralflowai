/**
 * One-off / periodic backfill for `basin_operators` — crawls TRRC's public
 * W-1 New Drill search across every Permian Basin + Eagle Ford county over
 * a trailing window, in ~90-day chunks (fetch-permits.ts caps a single
 * search's date range at 92 days), and aggregates every distinct operator
 * seen into the basin_operators table.
 *
 * Not real-time — this is a periodically-refreshed roster (see the
 * synced_at column) for populating the Permit Tracker's operator-exclude
 * filter, not a live query. Re-run this occasionally to pick up new
 * operators; it's additive (upsert), so re-running is always safe.
 *
 * Run with: npx tsx scripts/sync-basin-operators.ts
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment (.env.local is NOT auto-loaded — export them first).
 */

import { createClient } from "@supabase/supabase-js";
import { searchNewDrillPermits } from "../lib/trrc/permit-tracker/fetch-permits";
import { ALL_BASIN_COUNTIES, basinsForCounty } from "../lib/trrc/permit-tracker/county-groups";

const TRAILING_MONTHS = 18;
// fetch-permits.ts allows up to 92 days per search, but empirically, a
// combined 55-county query wider than ~60-90 days silently returns ZERO
// rows instead of erroring or truncating — confirmed by re-running the
// identical failing window in isolation and by bisecting: 45 and 60 days
// both returned a full (capped) page, 91 days returned nothing, twice.
// This looks like a server-side timeout/limit on TRRC's ~20-year-old
// Struts app that fails silently rather than a real "no permits" result.
// 30 days stays with a healthy margin under that boundary.
const CHUNK_DAYS = 30;
const DELAY_BETWEEN_CHUNKS_MS = 1500; // pace requests against TRRC's public system

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

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setMonth(windowStart.getMonth() - TRAILING_MONTHS);

  const chunks: { since: Date; until: Date }[] = [];
  let cursor = new Date(windowStart);
  while (cursor < now) {
    const until = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000, now.getTime()));
    chunks.push({ since: new Date(cursor), until });
    cursor = new Date(until.getTime() + 24 * 60 * 60 * 1000);
  }

  console.log(`Crawling ${ALL_BASIN_COUNTIES.length} basin counties across ${chunks.length} ~${CHUNK_DAYS}-day windows (trailing ${TRAILING_MONTHS} months)...`);

  const aggregates = new Map<string, Aggregate>();
  let totalRowsSeen = 0;
  let anyTruncated = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    process.stdout.write(`  [${i + 1}/${chunks.length}] ${chunk.since.toISOString().slice(0, 10)} → ${chunk.until.toISOString().slice(0, 10)} ... `);
    try {
      const result = await searchNewDrillPermits({ counties: ALL_BASIN_COUNTIES, since: chunk.since, until: chunk.until });
      totalRowsSeen += result.rows.length;
      if (result.truncated) anyTruncated = true;
      console.log(`${result.rows.length} permits${result.truncated ? " (truncated — hit the 300-row cap)" : ""}${result.rows.length === 0 ? " — SUSPECT: 0 rows on a wide multi-county query is more likely a silent TRRC failure than a true zero, verify manually if this recurs" : ""}`);

      for (const row of result.rows) {
        if (!row.operatorNumber || !row.operatorName) continue;
        const basins = basinsForCounty(row.county ?? "");
        if (basins.length === 0) continue; // shouldn't happen given the query scope, but don't guess

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
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(DELAY_BETWEEN_CHUNKS_MS);
  }

  console.log(`\nAggregated ${aggregates.size} distinct operators from ${totalRowsSeen} total permit rows.`);
  if (anyTruncated) {
    console.log("Note: at least one window hit the 300-row cap — coverage is a strong sample, not exhaustive.");
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
