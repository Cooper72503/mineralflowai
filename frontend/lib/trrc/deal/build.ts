/**
 * One deal from one package of APIs: group the wells by TRRC lease (each
 * lease's production counted once), then per lease the owners of record,
 * the chain of title, the value of every interest, offers and a verdict.
 * No user input is required; every assumption is MineralFlow's own, labeled,
 * and overridable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPortfolioInputs } from "../portfolio/load";
import { buildPortfolioRecord } from "../portfolio/record";
import { latestSourceAttempts, type LiteSourceAttempt } from "../coverage";
import { computeProductionAnalytics, extractIdentity, generateFlags, getAttempt, type WellIdentity } from "../report-builder";
import { currentProduction, reportedProductionSeries } from "../production-series";
import { fitArpsDeclineWindowed, type DeclineCurveFit } from "../decline-curve";
import { classifyBasin, loeMidpoint } from "../basin-benchmarks";
import { getPriceDeck, type PriceDeck } from "../eia-pricing";
import { loadLeaseOwnership, type LeaseOwnership } from "../ownership/mineral-roll";
import { valueLeaseInterests, producingWellCount, type InterestValuation, type ByScenario } from "../ownership/interest-value";
import { loadTitleForApi } from "../gold2/title-link";
import type { TitleChainAnalysis } from "../title/chain-types";
import type { TrrcDDProductionRow, TrrcDueDiligenceRun } from "../types";
import { decideDeal, decideLease, offersFor, type LeaseDecision, type Offers, type Verdict } from "./underwriting";

export interface Source { id: string; label: string; detail: string; retrievedAt: string | null; url: string | null }
export interface DealWell { api10: string; wellNo: string | null; status: string | null; formsLacking: boolean; inPackage: boolean; onProration: boolean }

export interface DealLease {
  key: string; district: string; leaseNumber: string; leaseType: string;
  leaseName: string | null; field: string | null; county: string | null; operator: string | null; operatorNo: string | null;
  apis: string[]; runIds: string[]; members: { runId: string; api: string | null; input: string }[]; wells: DealWell[];
  producingWells: number; producingWellsBasis: string;
  production: TrrcDDProductionRow[];
  lastReportedMonth: string | null; trailingUnreportedMonths: number;
  fit: DeclineCurveFit | null; fitPhase: "oil" | "gas" | null; fitWindowNote: string | null;
  basin: { name: string; loeRange: [number, number]; loeMidpoint: number } | null;
  ownership: LeaseOwnership; valuation: InterestValuation; offers: Offers;
  regulatory: { critical: string[]; important: string[] };
  title: { status: "published" | "in_progress" | "not_found" | "unavailable"; reason: string | null; analysis: TitleChainAnalysis | null; readInstruments: number; indexedInstruments: number };
  decision: LeaseDecision;
  sources: Record<"production" | "wells" | "roll" | "title", string[]>;
}

export interface Deal {
  packageId: string; generatedAt: string;
  submitted: number; distinctApis: number;
  excluded: { input: string; api: string | null; reason: string }[];
  deck: PriceDeck; deckLabel: string;
  overrides: { oilUsdBbl: number | null; gasUsdMcf: number | null; loeUsdPerBoe: number | null };
  leases: DealLease[];
  totals: { royaltyAndOverridePv10: ByScenario | null; workingInterestPv10: ByScenario | null };
  decision: { verdict: Verdict; reasons: string[] };
  sources: Source[];
}

export interface DealOverrides { oilUsdBbl?: number | null; gasUsdMcf?: number | null; loeUsdPerBoe?: number | null }

export type DealLoad = { ready: true; deal: Deal } | { ready: false; reason: string; progress: { complete: number; total: number } };

const TERMINAL = ["complete", "failed", "cancelled"];
const ACTIVE_TITLE = ["pending", "resolving_wells", "searching_records", "ingesting", "analyzing"];
const zeroes = (): ByScenario => ({ stress: 0, base: 0, upside: 0 });

function deckWithOverrides(live: PriceDeck, o: DealOverrides): PriceDeck {
  if (!o.oilUsdBbl && !o.gasUsdMcf) return live;
  const oil = o.oilUsdBbl ?? live.wtiSpotUsdBbl, gas = o.gasUsdMcf ?? live.henryHubUsdMcf;
  return { source: "user_input", asOf: `supplied ${new Date().toISOString().slice(0, 10)}`, wtiSpotUsdBbl: oil, henryHubUsdMcf: gas,
    scenarios: { stress: { oilUsdBbl: oil * 0.75, gasUsdMcf: gas * 0.75 }, base: { oilUsdBbl: oil, gasUsdMcf: gas }, strip: { oilUsdBbl: oil, gasUsdMcf: gas }, upside: { oilUsdBbl: oil * 1.25, gasUsdMcf: gas * 1.25 } } };
}

/**
 * A package shares one courthouse research scope across its leases, so each
 * lease's chain is cut to the confirmed tracts its own wells sit on and the
 * recordings on those tracts. A lease whose wells reach no confirmed tract
 * gets no chain, with the reason taken from that scope's county searches.
 */
export function scopeTitleToLease(analysis: TitleChainAnalysis, leaseApis: string[], wells: DealWell[]): { analysis: TitleChainAnalysis | null; reason: string } {
  const apis = new Set([...leaseApis, ...wells.map(w => w.api10)]);
  const leaseWells = analysis.wells.filter(w => w.api14 && apis.has(w.api14.slice(0, 10)));
  const confirmed = new Map(analysis.tracts.filter(t => t.matchStatus === "confirmed").map(t => [t.id, t]));
  const tractIds = new Set(leaseWells.flatMap(w => w.associations.map(a => a.tractId)).filter(id => confirmed.has(id)));
  const counties = [...new Set(leaseWells.map(w => (w.countyName ?? "").toUpperCase()).filter(Boolean))];
  // County clerk searches only; the TRRC lookups that resolved the wells also carry a county.
  const coverage = analysis.searchCoverage.filter(c => (c.provider.startsWith("county:") || c.provider === "none") && counties.includes((c.county ?? "").toUpperCase()));
  if (!tractIds.size) {
    const byCounty = counties.map(county => {
      const rows = coverage.filter(c => (c.county ?? "").toUpperCase() === county);
      const name = county.charAt(0) + county.slice(1).toLowerCase();
      if (rows.length && rows.every(r => r.status === "provider_unavailable")) {
        const captcha = rows.some(r => /CAPTCHA/i.test(r.errorMessage ?? ""));
        return captcha ? `${name} County's records site required a CAPTCHA, so it was not searched automatically` : `${name} County clerk records are not online for automated search`;
      }
      if (!rows.length) return `${name} County was not searched`;
      return `${name} County was searched (${rows.filter(r => r.status === "success").length} of ${rows.length} searches returned recordings), but none tied a recording to a surveyed tract under this lease's wells`;
    });
    return { analysis: null, reason: byCounty.length ? byCounty.join("; ") : "None of this lease's wells were resolved in the courthouse research scope" };
  }
  const labels = new Set([...tractIds].map(id => confirmed.get(id)!.tractLabel));
  return { reason: "", analysis: {
    ...analysis,
    tracts: analysis.tracts.filter(t => tractIds.has(t.id)),
    wells: leaseWells,
    chronology: analysis.chronology.filter(r => labels.has(r.tractLabel)),
    searchCoverage: coverage,
  } };
}

export async function loadDeal(db: SupabaseClient, userId: string, packageId: string, overrides: DealOverrides = {}): Promise<DealLoad> {
  const pkg = await db.from("trrc_packages").select("id, members_json").eq("id", packageId).eq("user_id", userId).maybeSingle();
  if (pkg.error) throw Error("Package lookup failed.");
  if (!pkg.data) throw Error("Package not found.");
  const members = (pkg.data.members_json as { input: string; runId: string | null }[]).map(m => ({ input: m.input, runId: m.runId }));
  const runIds = [...new Set(members.flatMap(m => m.runId ? [m.runId] : []))];

  const status = runIds.length ? await db.from("trrc_due_diligence_runs").select("id, status, title_research_job_id").eq("user_id", userId).in("id", runIds) : { data: [], error: null };
  if (status.error || (status.data ?? []).length !== runIds.length) throw Error("Package runs could not be loaded.");
  const done = (status.data ?? []).filter(r => TERMINAL.includes(String(r.status))).length;
  if (done < runIds.length) return { ready: false, reason: `Retrieving public records: ${done} of ${runIds.length} wells complete.`, progress: { complete: done, total: runIds.length } };
  const titleIds = [...new Set((status.data ?? []).flatMap(r => r.title_research_job_id ? [String(r.title_research_job_id)] : []))];
  if (titleIds.length) {
    const titles = await db.from("title_research_jobs").select("id, status, stage_detail").eq("user_id", userId).in("id", titleIds);
    if (titles.error) throw Error("Title research status could not be loaded.");
    const active = (titles.data ?? []).find(t => ACTIVE_TITLE.includes(String(t.status)));
    if (active) return { ready: false, reason: `Researching courthouse records: ${String(active.stage_detail ?? active.status)}.`, progress: { complete: done, total: runIds.length } };
  }

  const generatedAt = new Date().toISOString();
  const { input, runs } = await loadPortfolioInputs(db, userId, { members });
  const record = buildPortfolioRecord(input, runs, generatedAt);
  const live = await getPriceDeck(db);
  const deck = deckWithOverrides(live, overrides);
  const loeOverride = overrides.loeUsdPerBoe && overrides.loeUsdPerBoe > 0 ? overrides.loeUsdPerBoe : null;

  const fullRuns = runIds.length ? await db.from("trrc_due_diligence_runs").select("*").eq("user_id", userId).in("id", runIds) : { data: [], error: null };
  if (fullRuns.error) throw Error("Package runs could not be loaded.");
  type Run = TrrcDueDiligenceRun & { title_research_job_id: string | null };
  const runById = new Map((fullRuns.data ?? []).map(r => [String(r.id), r as unknown as Run]));
  const attemptsById = new Map(runs.map(r => [r.id, latestSourceAttempts(r.attempts).filter(a => a.source_name !== "submit_report")]));

  const sources: Source[] = [];
  const cite = (s: Omit<Source, "id">) => {
    const found = sources.find(x => x.label === s.label && x.detail === s.detail);
    if (found) return found.id;
    const id = String(sources.length + 1); sources.push({ id, ...s }); return id;
  };
  const deckLabel = deck.source === "eia_live" ? `EIA spot prices, ${deck.asOf}: WTI Cushing $${deck.wtiSpotUsdBbl.toFixed(2)}/bbl, Henry Hub $${deck.henryHubUsdMcf.toFixed(2)}/MMBtu${deck.fromSnapshot ? ` (live EIA unavailable at report time; EIA values as retrieved ${String(deck.retrievedAt).slice(0, 16).replace("T", " ")} UTC)` : ""}`
    : deck.source === "user_input" ? `Supplied prices: oil $${deck.wtiSpotUsdBbl.toFixed(2)}/bbl, gas $${deck.henryHubUsdMcf.toFixed(2)}/mcf` : `Placeholder prices as of ${deck.asOf} (live EIA prices unavailable)`;
  cite({ label: "Price deck", detail: deckLabel, retrievedAt: deck.retrievedAt ?? generatedAt, url: deck.source === "eia_live" ? "https://www.eia.gov/opendata/" : null });
  cite({ label: "MineralFlow standard assumptions", detail: "Texas severance tax rates per Tex. Tax Code §202.052 (oil, 4.6%) and §201.052 (gas, 7.5%); ad valorem, operating cost, workover reserve, economic limit, discounting, offer policy and decision rules as stated in Section 1", retrievedAt: null, url: "https://statutes.capitol.texas.gov/Docs/TX/htm/TX.202.htm" });

  const leases: DealLease[] = [];
  for (const stream of record.production.leaseStreams) {
    const lm = record.inventory.members.filter(m => m.productionGroup === stream.key && m.runId);
    const memberRuns = lm.map(m => runById.get(m.runId!)!).filter(Boolean);
    const first = memberRuns[0];
    const attempts = attemptsById.get(first.id) ?? [];
    const identity: WellIdentity = extractIdentity(attempts, first);
    const attemptOf = (name: string) => memberRuns.map(r => (attemptsById.get(r.id) ?? []).find(a => a.source_name === name && a.status === "success")).find(Boolean) ?? null;

    // Wells: TRRC's proration schedule for the lease, plus every package API.
    const prorationAttempt = attemptOf("fetch_oil_proration");
    const proration = memberRuns.map(r => getAttempt(attemptsById.get(r.id) ?? [], "fetch_oil_proration")).find(p => Array.isArray(p?.["wells"])) ?? null;
    const prorationWells = (Array.isArray(proration?.["wells"]) ? proration!["wells"] : []) as Record<string, unknown>[];
    const pkgApis = new Set(stream.apis);
    const wells: DealWell[] = prorationWells.map(w => {
      const tail = String(w["api_no"] ?? "").replace(/\D/g, "");
      const api10 = tail.length === 8 ? `42${tail}` : tail;
      return { api10, wellNo: (w["well_no"] as string) ?? null, status: (w["status"] as string) ?? null, formsLacking: w["forms_lacking"] === true, inPackage: pkgApis.has(api10), onProration: true };
    });
    for (const api of stream.apis) if (!wells.some(w => w.api10 === api)) {
      const wb = getAttempt(attemptsById.get(memberRuns.find(r => r.resolved_primary_api?.replace(/\D/g, "").slice(0, 10) === api)?.id ?? first.id) ?? [], "search_by_api");
      const row = (Array.isArray(wb?.["wells"]) ? (wb!["wells"] as Record<string, unknown>[]) : []).find(w => `42${String(w["api_no"] ?? "").replace(/\D/g, "")}` === api);
      wells.push({ api10: api, wellNo: (row?.["well_no"] as string) ?? null, status: null, formsLacking: false, inPackage: true, onProration: false });
    }
    wells.sort((a, b) => Number(b.inPackage) - Number(a.inPackage) || a.api10.localeCompare(b.api10));
    const producing = producingWellCount(prorationWells);

    // Lease production, each month once, from the reconciled lease stream.
    const production: TrrcDDProductionRow[] = stream.months.map(m => ({
      entity_type: "lease", api_number: null, district: stream.district, lease_number: stream.leaseNumber, gas_id: null, operator_number: null,
      production_month: m.month, oil_bbl: m.volumes.oil_bbl.value, casinghead_gas_mcf: m.volumes.casinghead_gas_mcf.value, gas_mcf: m.volumes.gas_mcf.value,
      condensate_bbl: m.volumes.condensate_bbl.value, water_bbl: m.volumes.water_bbl.value,
    }));
    const reported = reportedProductionSeries(production);
    const fitPhase = reported.oil.length >= 6 ? "oil" : reported.gas.length >= 6 ? "gas" : null;
    const window = fitPhase ? fitArpsDeclineWindowed(fitPhase === "oil" ? reported.oil : reported.gas) : null;
    const basin = classifyBasin(identity.field || null, identity.county || null);

    const ownership = await loadLeaseOwnership(db, { leaseNumber: stream.leaseNumber, leaseName: identity.wellName || null });
    const valuation = valueLeaseInterests(ownership, { monthlyOilBbl: reported.oil, monthlyGasMcf: reported.gas, fieldName: identity.field || null, county: identity.county || null }, deck, producing.count, loeOverride);

    // Regulatory flags across every well on the lease, each stated once.
    const critical = new Map<string, number>(), important = new Map<string, number>();
    for (const run of memberRuns) {
      const a = attemptsById.get(run.id) ?? [];
      const { data: rows, error: prodError } = await db.from("trrc_production_monthly").select("*").eq("run_id", run.id).order("production_month", { ascending: false }).limit(120);
      // A failed read must not silently drop a well's regulatory flags.
      if (prodError) throw Error(`Production for run ${run.id.slice(0, 8)} could not be read; report withheld.`);
      const flags = generateFlags(a, computeProductionAnalytics(currentProduction((rows ?? []) as unknown as TrrcDDProductionRow[], a)), run);
      for (const f of flags.critical) critical.set(f, (critical.get(f) ?? 0) + 1);
      for (const f of flags.important) important.set(f, (important.get(f) ?? 0) + 1);
    }
    // A flag raised on every well is a lease-level fact; one raised on some wells says how many.
    const fold = (m: Map<string, number>) => [...m].map(([f, n]) => n < memberRuns.length && memberRuns.length > 1 ? `${f} (${n} of ${memberRuns.length} submitted wells)` : f);

    // Chain of title: the lease's courthouse research scope.
    const titleIds = [...new Set(memberRuns.flatMap(r => r.title_research_job_id ? [r.title_research_job_id] : []))];
    let title: DealLease["title"] = { status: "not_found", reason: "No courthouse title research is linked to these wells.", analysis: null, readInstruments: 0, indexedInstruments: 0 };
    if (titleIds.length > 1) title = { ...title, status: "unavailable", reason: "The wells on this lease are linked to more than one title research scope." };
    else if (titleIds.length === 1) {
      const api = memberRuns.find(r => r.title_research_job_id === titleIds[0])!.resolved_primary_api ?? stream.apis[0];
      const t = await loadTitleForApi(db, api, userId, titleIds[0]);
      if (t.title) {
        const scoped = scopeTitleToLease(t.title, stream.apis, wells);
        title = scoped.analysis
          ? { status: "published", reason: null, analysis: scoped.analysis, readInstruments: scoped.analysis.chronology.filter(r => r.contentVerified).length, indexedInstruments: scoped.analysis.chronology.length }
          : { status: "not_found", reason: scoped.reason, analysis: null, readInstruments: 0, indexedInstruments: 0 };
      } else title = { status: t.status === "in_progress" ? "in_progress" : t.status === "not_found" ? "not_found" : "unavailable", reason: t.reason, analysis: null, readInstruments: 0, indexedInstruments: 0 };
    }

    const retrieved = (a: LiteSourceAttempt | null) => a?.attempted_at ?? null;
    const leaseLabel = `${identity.wellName ?? "Lease"} (RRC ${stream.district}-${stream.leaseNumber})`;
    const prodAttempt = attemptOf("fetch_production");
    const leaseSources = {
      production: [cite({ label: "TRRC Production Data Query", detail: `${leaseLabel}, ${stream.leaseType === "O" ? "oil" : "gas"} lease, monthly lease production`, retrievedAt: retrieved(prodAttempt), url: "https://webapps.rrc.texas.gov/PDQ/" })],
      wells: [
        cite({ label: "TRRC wellbore query", detail: `${stream.apis.length} submitted API(s) resolved to ${leaseLabel}`, retrievedAt: retrieved(attemptOf("search_by_api")), url: "https://webapps2.rrc.texas.gov/EWA/wellboreQueryAction.do" }),
        ...(prorationAttempt ? [cite({ label: "TRRC oil proration schedule", detail: `${prorationWells.length} well(s) on ${leaseLabel}`, retrievedAt: retrieved(prorationAttempt), url: "https://webapps2.rrc.texas.gov/EWA/oilProQueryAction.do" })] : []),
      ],
      roll: ownership.sources.map(s => cite({ label: `${s.county} County appraisal district mineral roll`, detail: `Tax year ${s.taxYear}; file ${s.fileName}; SHA-256 ${s.sha256.slice(0, 16)}`, retrievedAt: null, url: null })),
      title: title.analysis ? [cite({ label: "County clerk records (courthouse)", detail: `Title analysis v${title.analysis.version} of research scope ${title.analysis.jobId.slice(0, 8)}; ${title.analysis.searchCoverage.filter(c => c.provider.startsWith("county:")).length} clerk searches`, retrievedAt: title.analysis.generatedAt, url: null })] : [],
    };

    const excludedMembers = record.inventory.members.filter(m => m.api && stream.apis.includes(m.api) && m.status !== "reconciled").length;
    const decision = decideLease({
      valuation, ownership, fitRSquared: window?.fit?.rSquared ?? null, monthsOfHistory: (fitPhase === "oil" ? reported.oil : reported.gas).length,
      trailingUnreportedMonths: fitPhase === "gas" ? reported.trailingUnreportedGasMonths : reported.trailingUnreportedOilMonths,
      currentAnnualDeclinePct: window?.fit?.currentAnnualDeclinePct ?? null, producingWells: producing.count, prorationWells: prorationWells.length,
      shutInWells: prorationWells.filter(w => /SHUT/i.test(String(w["status"] ?? ""))).length, formsLackingWells: prorationWells.filter(w => w["forms_lacking"] === true).length,
      regulatoryCritical: fold(critical), regulatoryImportant: fold(important),
      title: { status: title.status, readInstruments: title.readInstruments, indexedInstruments: title.indexedInstruments, reason: title.reason }, excludedMembers,
    });

    leases.push({
      key: stream.key, district: stream.district, leaseNumber: stream.leaseNumber, leaseType: stream.leaseType,
      leaseName: identity.wellName || null, field: identity.field || null, county: identity.county || null, operator: identity.operator || null, operatorNo: identity.operatorNo || null,
      apis: stream.apis, runIds: memberRuns.map(r => r.id), members: lm.map(m => ({ runId: m.runId!, api: m.api, input: m.input })), wells, producingWells: producing.count, producingWellsBasis: producing.basis,
      production, lastReportedMonth: fitPhase === "gas" ? reported.gasLastReportedMonth : reported.oilLastReportedMonth,
      trailingUnreportedMonths: fitPhase === "gas" ? reported.trailingUnreportedGasMonths : reported.trailingUnreportedOilMonths,
      fit: window?.fit ?? null, fitPhase, fitWindowNote: window?.reason ?? null,
      basin: basin ? { name: basin.name, loeRange: basin.loeUsdPerBoeRange, loeMidpoint: loeMidpoint(basin) } : null,
      ownership, valuation, offers: offersFor(valuation), regulatory: { critical: fold(critical), important: fold(important) }, title, decision, sources: leaseSources,
    });
  }
  leases.sort((a, b) => (b.valuation.totalsPv10?.base ?? 0) - (a.valuation.totalsPv10?.base ?? 0));

  const sum = (pick: (l: DealLease) => ByScenario | null) => {
    const valued = leases.map(pick).filter((x): x is ByScenario => !!x);
    return valued.length ? valued.reduce((t, x) => ({ stress: t.stress + x.stress, base: t.base + x.base, upside: t.upside + x.upside }), zeroes()) : null;
  };
  const royaltyPool = (l: DealLease): ByScenario | null => l.valuation.status !== "valued" ? null
    : l.valuation.owners.filter(o => o.interestType === "royalty" || o.interestType === "overriding_royalty").reduce((t, o) => ({ stress: t.stress + (o.pv10?.stress ?? 0), base: t.base + (o.pv10?.base ?? 0), upside: t.upside + (o.pv10?.upside ?? 0) }), zeroes());

  const grouped = new Set(leases.flatMap(l => l.apis));
  const excluded = record.inventory.members.filter(m => !m.api || !grouped.has(m.api) || m.status !== "reconciled")
    .map(m => ({ input: m.input, api: m.api, reason: m.reason ?? "Not reconciled to a lease production stream." }));

  return { ready: true, deal: {
    packageId, generatedAt, submitted: record.inventory.submittedEntries, distinctApis: record.inventory.distinctValidApis, excluded, deck, deckLabel,
    overrides: { oilUsdBbl: overrides.oilUsdBbl ?? null, gasUsdMcf: overrides.gasUsdMcf ?? null, loeUsdPerBoe: loeOverride },
    leases, totals: { royaltyAndOverridePv10: sum(royaltyPool), workingInterestPv10: sum(l => l.valuation.workingInterestPv10) },
    decision: decideDeal(leases.map(l => ({ name: l.leaseName ?? `RRC ${l.district}-${l.leaseNumber}`, decision: l.decision }))), sources,
  } };
}

/** What the engine page shows: the decision, offers and risks, without owner or monthly detail. */
export function summarizeDeal(d: Deal) {
  return {
    packageId: d.packageId, generatedAt: d.generatedAt, verdict: d.decision.verdict, reasons: d.decision.reasons, deckLabel: d.deckLabel,
    submitted: d.submitted, excluded: d.excluded, totals: d.totals,
    leases: d.leases.map(l => ({
      name: l.leaseName, district: l.district, leaseNumber: l.leaseNumber, county: l.county, operator: l.operator,
      apis: l.apis.length, prorationWells: l.wells.filter(w => w.onProration).length, producingWells: l.producingWells,
      owners: l.ownership.owners.length, ownershipStatus: l.ownership.status, ownershipReason: l.ownership.reason,
      titleStatus: l.title.status, titleReason: l.title.reason, readInstruments: l.title.readInstruments, indexedInstruments: l.title.indexedInstruments,
      valuationStatus: l.valuation.status, valuationReason: l.valuation.reason, economicLimitMonths: l.valuation.economicLimitMonths?.base ?? null,
      offers: l.offers, verdict: l.decision.verdict, reasons: l.decision.reasons, risks: l.decision.risks, conditions: l.decision.conditions,
      members: l.members,
    })),
  };
}
export type DealSummary = ReturnType<typeof summarizeDeal>;
