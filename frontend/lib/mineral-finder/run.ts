import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ingestBeg,
  ingestGis,
  ingestWellbore,
  mergeWells,
  BEG_PRICES,
} from "./ingestion";
import { request } from "./http";
import { screen, leaseKey } from "./screen";
import { CriteriaSchema } from "./criteria";
import type {
  Criteria,
  FinderResult,
  FinderSnapshot,
  Production,
  Source,
} from "./types";

export interface Adapters {
  production?: (
    lease: string,
    district: string,
    leaseType: string,
  ) => Promise<{
    found: boolean;
    error?: string;
    message?: string;
    retrievedAt?: string;
    rows: {
      production_month: string;
      oil_bbl: number | null;
      gas_mcf: number | null;
      water_bbl: number | null;
      casinghead_gas_mcf?: number | null;
      condensate_bbl?: number | null;
    }[];
  }>;
  /** Must be deliberately enabled after review of metadata access/reuse rights. */
  begMetadataEnabled?: boolean;
  progress?: (stage: string) => Promise<void>;
  signal?: AbortSignal;
}

async function checked<T extends { error: unknown }>(
  p: PromiseLike<T>,
  label: string,
): Promise<T> {
  const r = await p;
  if (r.error) throw Error(`${label}: ${JSON.stringify(r.error)}`);
  return r;
}

/** Cache is shared public-source data, writable/readable only by the service worker. */
export async function cached<T>(
  db: SupabaseClient | null,
  key: string,
  hours: number,
  load: () => Promise<T>,
): Promise<T> {
  if (db) {
    const r = await checked(
      db
        .from("mineral_finder_snapshots")
        .select("payload,expires_at")
        .eq("cache_key", key)
        .maybeSingle(),
      "Finder cache read",
    );
    if (r.data && new Date(r.data.expires_at).getTime() > Date.now())
      return r.data.payload as T;
  }
  const value = await load();
  if (db)
    await checked(
      db
        .from("mineral_finder_snapshots")
        .upsert(
          {
            cache_key: key,
            payload: value,
            fetched_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + hours * 3600_000).toISOString(),
          },
          { onConflict: "cache_key" },
        ),
      "Finder cache write",
    );
  return value;
}

export async function runFinder(
  db: SupabaseClient | null,
  criteriaInput: Criteria,
  query: string,
  adapters: Adapters = {},
  supplied?: FinderSnapshot,
): Promise<FinderResult> {
  const criteria = CriteriaSchema.parse(criteriaInput);
  const progress = adapters.progress ?? (async () => {});
  let snapshot: FinderSnapshot;
  if (supplied) snapshot = supplied;
  else {
    await progress(
      "Downloading official monthly wellbore data; retaining county rows",
    );
    const bulk = await cached(
      db,
      `wellbore-v1:${criteria.county}`,
      7 * 24,
      () => ingestWellbore(criteria.county, adapters.signal),
    );
    await progress("Loading county well locations");
    const gis = await cached(db, `gis-v1:${criteria.county}`, 24, () =>
      ingestGis(criteria.county, adapters.signal),
    );
    const sources: Source[] = [bulk.source, gis.source];
    let catalog: FinderSnapshot["catalog"] = [];
    if (adapters.begMetadataEnabled) {
      try {
        await progress(
          "Querying geological catalog metadata; no scanned logs downloaded",
        );
        const beg = await cached(db, `beg-v1:${criteria.county}`, 7 * 24, () =>
          ingestBeg(criteria.county, adapters.signal),
        );
        sources.push(beg.source);
        catalog = beg.records;
      } catch (e) {
        sources.push({
          id: "beg-catalog",
          provider: "UT BEG CONTINUUM",
          url: "https://coastal.beg.utexas.edu/continuum/",
          retrievedAt: new Date().toISOString(),
          count: 0,
          complete: false,
          status: "failed",
          warnings: [e instanceof Error ? e.message : String(e)],
        });
      }
    } else
      sources.push({
        id: "beg-catalog",
        provider: "UT BEG CONTINUUM",
        url: "https://coastal.beg.utexas.edu/continuum/",
        retrievedAt: new Date().toISOString(),
        count: 0,
        complete: false,
        status: "not_enabled",
        warnings: [
          "Metadata connector disabled pending commercial access/retention review. Set MINERAL_FINDER_BEG_METADATA_ACCESS=approved after confirmation. Scans require separate permission and human purchase approval.",
        ],
      });
    snapshot = {
      wells: mergeWells(criteria.county, bulk.records, gis.rows),
      catalog,
      sources,
    };
    if (db) {
      // Geographic btree indexes support county/bounding-box filtering without changing existing PostGIS setup.
      for (let i = 0; i < snapshot.wells.length; i += 250)
        await checked(
          db.from("mineral_finder_wells").upsert(
            snapshot.wells.slice(i, i + 250).map((w) => ({
              api10: w.api,
              county: w.county,
              latitude: w.lat,
              longitude: w.lng,
              status: w.status,
              well_json: w,
              snapshot_at: bulk.source.retrievedAt,
            })),
            { onConflict: "api10" },
          ),
          "Finder normalized well persistence",
        );
    }
  }
  const production = new Map<string, Production>();
  // Preselect with free evidence. Production then enriches this disclosed shortlist,
  // not every county well; no claim of economically exhaustive county screening.
  const preliminary = screen(snapshot, criteria, query);
  const targets = new Map<
    string,
    NonNullable<(typeof snapshot.wells)[0]["association"]>
  >();
  for (const p of preliminary.prospects) {
    for (const api of [p.api, ...p.offsets.slice(0, 2).map((o) => o.api)]) {
      const w = snapshot.wells.find((w) => w.api === api);
      const key = w ? leaseKey(w) : null;
      if (key && w?.association) targets.set(key, w.association);
    }
  }
  let fetched = 0;
  for (const [key, a] of targets) {
    if (fetched >= 30) break;
    await progress(
      `Reading lease production ${++fetched}/${Math.min(30, targets.size)} (shared leases counted once)`,
    );
    const sourceId = `production:${key}`;
    let p: Production;
    if (!adapters.production)
      p = {
        key,
        sourceId,
        retrievedAt: new Date().toISOString(),
        status: "not_requested",
        rows: [],
        reason: "Production adapter not available in this execution.",
      };
    else {
      try {
        p = await cached(db, `production-v1:${key}`, 24, async () => {
          const r = await adapters.production!(
            a.lease!,
            a.district!,
            a.leaseType!,
          );
          if (r.error) throw Error(r.error);
          const rows = r.rows
            .map((r) => ({
              month: r.production_month,
              oil: r.oil_bbl ?? r.condensate_bbl ?? null,
              gas: r.gas_mcf ?? r.casinghead_gas_mcf ?? null,
              water: r.water_bbl,
            }))
            .sort((a, b) => a.month.localeCompare(b.month));
          if (
            rows.some(
              (r) =>
                !/^\d{4}-\d{2}$/.test(r.month) ||
                +r.month.slice(5) < 1 ||
                +r.month.slice(5) > 12 ||
                [r.oil, r.gas, r.water].some(
                  (v) => v !== null && (!Number.isFinite(v) || v < 0),
                ),
            )
          )
            throw Error("Production contains invalid dates or volumes.");
          if (new Set(rows.map((r) => r.month)).size !== rows.length)
            throw Error(
              "Duplicate/conflicting production months; reconciliation required.",
            );
          return {
            key,
            sourceId,
            retrievedAt: r.retrievedAt ?? new Date().toISOString(),
            status: rows.length ? "success" : "empty",
            rows,
            reason: rows.length
              ? null
              : (r.message ?? "No reported production returned."),
          } as Production;
        });
      } catch (e) {
        p = {
          key,
          sourceId,
          retrievedAt: new Date().toISOString(),
          status: "failed",
          rows: [],
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    }
    production.set(key, p);
    snapshot.sources.push({
      id: sourceId,
      provider: `RRC reported production ${key}`,
      url: "https://webapps2.rrc.texas.gov/EWA/specificLeaseQueryAction.do",
      retrievedAt: p.retrievedAt,
      status:
        p.status === "failed"
          ? "failed"
          : p.status === "not_requested"
            ? "not_enabled"
            : "success",
      count: p.rows.length,
      complete: false,
      warnings: [
        p.reason ??
          "Reported lease volumes; existing connector history window is not the full pre-1993 well history.",
        "Lease association in a monthly snapshot does not establish historical production allocation to a plugged well.",
      ],
    });
  }
  let pricing = {
    usd: null as number | null,
    checkedAt: null as string | null,
  };
  let priceError: string | null = null;
  try {
    pricing = await cached(db, "beg-pricing-v1", 24, async () => {
      const text = await (
        await request(BEG_PRICES, { signal: adapters.signal })
      ).text();
      const match = text
        .replace(/<[^>]+>/g, " ")
        .match(/\$([\d,]+(?:\.\d{2})?)\s+per\s+log/i);
      return {
        usd: match ? Number(match[1].replace(/,/g, "")) : null,
        checkedAt: new Date().toISOString(),
      };
    });
  } catch (e) {
    priceError = e instanceof Error ? e.message : String(e);
  }
  snapshot.sources.push({
    id: "beg-pricing",
    provider: "BEG published log scan pricing",
    url: BEG_PRICES,
    retrievedAt: pricing.checkedAt ?? new Date().toISOString(),
    status: pricing.usd === null ? "failed" : "success",
    count: pricing.usd === null ? 0 : 1,
    complete: false,
    warnings: [
      priceError ??
        (pricing.usd === null
          ? "A current per-log price could not be verified; quote required."
          : "Published per-log scan estimate, not a confirmed order quote. Core services, licensing and delivery terms require confirmation."),
    ],
  });
  await progress("Ranking research leads and recording limitations");
  const result = screen(snapshot, criteria, query, production, pricing);
  result.warnings.push(
    `Production enrichment is limited to the initial ${criteria.limit} research leads and up to 30 unique leases, not all eligible county wells. ${targets.size > 30 ? targets.size - 30 : 0} planned leases outside the retrieval budget.`,
  );
  if (criteria.marginalBopd !== null)
    result.warnings.push(
      "Countywide marginal discovery is not implemented: this pass cannot establish missing per-well production allocations.",
    );
  if (/underperform|marginal|bypassed|redevelop|abandon/i.test(query))
    result.warnings.push(
      "Requested opportunity interpretation is limited to the displayed status, age and field/formation proxy filters. Underperformance, bypassed pay, legal abandonment and redevelopment feasibility are not established by those filters.",
    );
  return result;
}
