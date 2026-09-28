/**
 * Demo acceptance test: checks one real package end to end against what is
 * stored and what the production report code produces from it.
 *
 *   npx tsx scripts/demo-acceptance.ts <packageId> <userId> [outDir] [lease=apis ...] [--regression]
 *
 * --regression accepts wells TRRC carries on several leases (none current)
 * when the package excludes them with a stated reason.
 *
 * Owners of record may be unestablished (no appraisal roll for the county)
 * only when the Decision Record says so; the interest is then the user's.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (reads only).
 * Exit code 0 only when every check passes. Writes the Decision Record PDF
 * and a JSON of the deal to outDir. Nothing here changes the data.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadDeal } from "../lib/trrc/deal/build";
import { applyAssumptionEdits, assembleDecision } from "../lib/trrc/deal/decision-layer";
import { renderDecisionRecordPdf } from "../lib/trrc/deal/decision-record-pdf";

const REQUIRED_SOURCES = ["search_by_api", "fetch_production", "fetch_oil_proration", "fetch_gis_plat", "fetch_plugging_records", "fetch_compliance_violations"];

type Check = { stage: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (stage: string, ok: boolean, detail: string) => { checks.push({ stage, ok, detail }); };

async function main() {
  const args = process.argv.slice(2);
  const regression = args.includes("--regression");
  const [packageId, userId, outDir = ".", ...expected] = args.filter(a => a !== "--regression");
  if (!packageId || !userId) throw Error("usage: demo-acceptance.ts <packageId> <userId> [outDir] [lease=count ...]");
  const expectedLeases = new Map(expected.map(e => { const [l, n] = e.split("="); return [l, Number(n)] as const; }));
  const db = createClient(process.env["NEXT_PUBLIC_SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!);

  // 1 Intake
  const { data: pkg } = await db.from("trrc_packages").select("id,status,members_json,created_at,updated_at").eq("id", packageId).eq("user_id", userId).single();
  const members = (pkg?.members_json ?? []) as { input: string; runId: string | null; error: string | null }[];
  check("intake", !!pkg && members.length > 0 && members.length <= 50 && members.every(m => m.runId), `${members.length} members, all with runs: ${members.every(m => m.runId)}`);
  check("intake", members.every(m => !m.error), members.filter(m => m.error).map(m => `${m.input}: ${m.error}`).join("; ") || "no member warnings");

  // 2 Retrieval
  const ids = members.flatMap(m => m.runId ? [m.runId] : []);
  const ambiguousApis = new Set<string>();
  const { data: runs } = await db.from("trrc_due_diligence_runs").select("id,status,resolved_primary_api,title_research_job_id,result_summary").in("id", ids);
  check("retrieval", (runs ?? []).length === ids.length && (runs ?? []).every(r => r.status === "complete"), `${(runs ?? []).filter(r => r.status === "complete").length} of ${ids.length} runs complete`);
  for (const r of runs ?? []) {
    const { data: att } = await db.from("trrc_source_attempts").select("source_name,status,attempted_at,error_message,result_data_json").eq("run_id", r.id).order("attempted_at");
    const latest = new Map<string, { status: string; error_message: string | null; result_data_json?: Record<string, unknown> | null }>();
    for (const a of att ?? []) latest.set(a.source_name, a);
    const failed = [...latest].filter(([, a]) => a.status !== "success" && a.status !== "not_applicable").map(([n, a]) => `${n} (${(a.error_message ?? a.status).slice(0, 80)})`);
    const missing = REQUIRED_SOURCES.filter(n => latest.get(n)?.status !== "success");
    // TRRC carries some wellbores on several leases, none current; the run
    // then withholds lease-level queries rather than pick one. In a
    // regression run that is the expected, stated outcome.
    const ambiguous = regression && /Multiple lease\/district associations/i.test(String(latest.get("search_by_api")?.result_data_json?.["message"] ?? ""));
    if (ambiguous) ambiguousApis.add(String(r.resolved_primary_api ?? ""));
    check("retrieval", missing.length === 0 || (ambiguous && missing.every(n => ["fetch_production", "fetch_oil_proration"].includes(n))), `${r.resolved_primary_api}: ${latest.size} sources, ${failed.length ? `failed: ${failed.join("; ")}` : "none failed"}${missing.length ? `; required not retrieved: ${missing.join(", ")}` : ""}`);
  }

  // 3 Title research
  const titleIds = [...new Set((runs ?? []).flatMap(r => r.title_research_job_id ? [r.title_research_job_id] : []))];
  const { data: jobs } = titleIds.length ? await db.from("title_research_jobs").select("id,status,latest_analysis_id,stage_detail").in("id", titleIds) : { data: [] };
  check("title", titleIds.length === 1, `${titleIds.length} title scope(s) for the package`);
  for (const j of jobs ?? []) check("title", j.status === "complete" && !!j.latest_analysis_id, `scope ${String(j.id).slice(0, 8)}: ${j.status}, ${j.stage_detail ?? ""}`);

  // 4-8 Deal: grouping, ownership, forecast, economics, decision
  const t0 = Date.now();
  const load = await loadDeal(db, userId, packageId);
  check("deal", load.ready, load.ready ? `built in ${Date.now() - t0} ms` : load.reason);
  if (!load.ready) return finish(outDir, null);
  const deal = load.deal;
  const again = await loadDeal(db, userId, packageId);
  const strip = (d: typeof deal) => JSON.stringify({ ...d, generatedAt: null, deck: { ...d.deck, retrievedAt: null }, sources: d.sources.map(s => ({ ...s, retrievedAt: s.label === "Price deck" ? null : s.retrievedAt })) });
  const firstDiff = (a: unknown, b: unknown, path = ""): string | null => {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === "object" && typeof b === "object") {
      for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) { const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); if (d) return d; }
    }
    return `${path}: ${JSON.stringify(a)?.slice(0, 100)} vs ${JSON.stringify(b)?.slice(0, 100)}`;
  };
  const same = again.ready && strip(again.deal) === strip(deal);
  check("determinism", same, same ? "two builds from the same evidence are identical (apart from build time)" : `builds differ at ${again.ready ? firstDiff(JSON.parse(strip(deal)), JSON.parse(strip(again.deal))) : "second build not ready"}`);
  check("prices", deal.deck.source === "eia_live", `${deal.deckLabel}`);

  for (const [lease, n] of expectedLeases) {
    const l = deal.leases.find(x => x.leaseNumber === lease);
    check("grouping", !!l && l.apis.length === n, `lease ${lease}: ${l ? l.apis.length : 0} of ${n} APIs grouped`);
  }
  for (const l of deal.leases) {
    const tag = `${l.leaseName} ${l.district}-${l.leaseNumber}`;
    check("production", l.production.length >= 12 && !!l.fit, `${tag}: ${l.production.length} months through ${l.lastReportedMonth}, fit R² ${l.fit?.rSquared.toFixed(2) ?? "none"}`);
    const ownershipStated = l.ownership.status !== "matched" && !!l.ownership.reason;
    check("ownership", ownershipStated || (l.ownership.status === "matched" && l.ownership.nameVerified && l.ownership.tracts.every(t => !t.irregular)), `${tag}: ${l.ownership.status}, ${l.ownership.owners.length} owners, ${l.ownership.tracts.length} tract(s), rejected ${l.ownership.rejectedTracts.length}${l.ownership.reason ? `, ${l.ownership.reason}` : ""}`);
    check("title", l.title.status === "published" ? l.title.indexedInstruments > 0 : !!l.title.reason, `${tag}: ${l.title.status}${l.title.status === "published" ? `, ${l.title.indexedInstruments} recordings, ${l.title.readInstruments} read` : `, ${l.title.reason}`}`);
    const cited = [...l.sources.production, ...l.sources.wells, ...l.sources.roll, ...l.sources.title];
    check("citations", cited.length >= 3 && cited.every(id => deal.sources.some(s => s.id === id)) && (l.title.status !== "published" || l.sources.title.length > 0), `${tag}: cites [${cited.join(", ")}]`);
  }

  // 8 Decision layer under the starting assumptions, and recalculation
  const start = applyAssumptionEdits(deal, {});
  check("assumptions", start.errors.length === 0, start.errors.join(" ") || "every lease's starting assumptions are valid and sourced");
  const unsourced = Object.values(start.byLease).flatMap(v => Object.entries(v.basis).filter(([, b]) => !b).map(([k]) => k));
  check("assumptions", unsourced.length === 0, unsourced.length ? `no basis for: ${unsourced.join(", ")}` : "every assumption states its basis");
  const byLease = (edits: Record<string, Record<string, unknown>>) => Object.fromEntries(Object.entries(applyAssumptionEdits(deal, edits).byLease).map(([k, v]) => [k, v.assumptions]));
  const record = assembleDecision(deal, byLease({}));
  check("decision safety", !deal.excluded.length || record.verdict !== "BUY", `${deal.excluded.length} excluded submissions; whole-package verdict ${record.verdict}`);
  for (const r of record.leases) {
    check("decision safety", r.verdict !== "BUY" || ![...r.missing, ...r.contradictions].some(f => f.severity >= 2), `${r.leaseKey}: ${r.verdict}; material evidence gaps cannot be sealed as BUY`);
    const s = r.economics.scenarios, e = r.entry, x = r.exit;
    const ordered = !!s && s.downside.presentValue <= s.base.presentValue && s.base.presentValue <= s.upside.presentValue && [s.downside, s.base, s.upside].every(c => Number.isFinite(c.presentValue) && c.presentValue > 0);
    check("economics", ordered, s ? `${r.leaseName}: PV ${[s.downside, s.base, s.upside].map(c => `$${Math.round(c.presentValue).toLocaleString("en-US")}`).join(" / ")}, life ${s.base.lifeMonths} mo (${r.economics.provider.name})` : `${r.leaseName}: ${r.economics.reason}`);
    check("entry", !!e && e.rangeLow > 0 && e.rangeLow <= e.rangeHigh && e.rangeHigh <= e.ceiling, e ? `${r.leaseName}: range $${Math.round(e.rangeLow).toLocaleString("en-US")}–$${Math.round(e.rangeHigh).toLocaleString("en-US")}, ceiling $${Math.round(e.ceiling).toLocaleString("en-US")}` : `${r.leaseName}: no entry analysis`);
    check("exit", !!x && Object.values(x.byScenario).every(v => Number.isFinite(v.total) && v.multiple !== null && v.irrPct !== null), x ? `${r.leaseName}: ${x.holdYears}-yr hold, base ${x.byScenario.base.multiple?.toFixed(2)}x, IRR ${x.byScenario.base.irrPct?.toFixed(1)}%` : `${r.leaseName}: no exit analysis`);
    check("decision", !!r.verdict && r.reasons.length > 0, `${r.leaseName}: ${r.verdict} — ${r.reasons[0]}`);
    const l = deal.leases.find(z => z.key === r.leaseKey)!;
    if (l.ownership.status !== "matched") check("ownership", r.missing.some(m => m.text.startsWith("Owners of record not established")), `${r.leaseName}: the record states owners of record are not established and the interest is the user's`);
    // Recalculate: doubling the decimal doubles the value; an asking price above the ceiling is a PASS.
    const nri = start.byLease[r.leaseKey].assumptions.netRevenueInterest;
    const doubled = assembleDecision(deal, byLease({ [r.leaseKey]: { netRevenueInterest: nri * 2 } })).leases.find(z => z.leaseKey === r.leaseKey)!;
    const ratio = s && doubled.economics.scenarios ? doubled.economics.scenarios.base.presentValue / s.base.presentValue : NaN;
    check("recalculate", Math.abs(ratio - 2) < 1e-9, `${r.leaseName}: doubling the decimal scales value ${ratio.toFixed(6)}x`);
    if (e) {
      const dear = assembleDecision(deal, byLease({ [r.leaseKey]: { askingPriceUsd: Math.round(e.ceiling * 1.2) } })).leases.find(z => z.leaseKey === r.leaseKey)!;
      check("recalculate", dear.verdict === "PASS", `${r.leaseName}: asking 20% over the ceiling gives ${dear.verdict}`);
    }
  }
  check("decision", !!record.verdict, `deal: ${record.verdict} — ${record.reasons.join(" ")}`);
  if (ambiguousApis.size) {
    const inputsFor = (api: string) => members.filter(m => m.input.replace(/\D/g, "").startsWith(api.replace(/\D/g, "").slice(0, 10)));
    const unlisted = [...ambiguousApis].filter(api => !inputsFor(api).every(m => deal.excluded.some(x => x.input === m.input && x.reason)));
    check("grouping", unlisted.length === 0, unlisted.length ? `ambiguous APIs not listed as excluded: ${unlisted.join(", ")}` : `${ambiguousApis.size} API(s) with ambiguous lease associations are excluded from valuation with a stated reason`);
  }

  // 9 Decision Record
  const pdf = await renderDecisionRecordPdf({ deal, record, basisByLease: Object.fromEntries(Object.entries(start.byLease).map(([k, v]) => [k, v.basis])), editedByLease: {} });
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer, o?: Record<string, unknown>) => Promise<{ numpages: number; text: string }>;
  const pageText: string[] = [];
  const parsed = await pdfParse(pdf, { pagerender: async (page: { getTextContent: () => Promise<{ items: { str: string }[] }> }) => {
    const text = (await page.getTextContent()).items.map(i => i.str).join(" ");
    pageText.push(text);
    return text;
  } });
  // A page holding only the running header and footer is a layout defect.
  const bare = pageText.map((t, i) => [i + 1, t.replace(/MineralFlow AI — Decision Record|Package \S+ · \S+|CONFIDENTIAL — Public-record screening, not a title opinion, reserve report or appraisal|\d+ \/ \d+/g, "").trim().length] as const).filter(([, n]) => n < 40);
  check("report", bare.length === 0, bare.length ? `pages with no content: ${bare.map(([p]) => p).join(", ")}` : "no blank pages");
  const needed = ["1. EXECUTIVE DECISION SUMMARY", "2. ASSET AND API OVERVIEW", "3. WELL AND LEASE IDENTITY", "4. PRODUCTION", "5. RRC AND REGULATORY DILIGENCE", "6. TITLE AND OWNERSHIP", "7. FORECAST", "8. SCENARIO ASSUMPTIONS", "9. ECONOMICS", "10. MINERALFLOW ENTRY ANALYSIS", "11. MINERALFLOW EXIT ANALYSIS", "12. RISKS, CONTRADICTIONS AND MISSING DILIGENCE", "13. SOURCE AND EVIDENCE APPENDIX", ...deal.leases.map(l => l.leaseName ?? l.leaseNumber)];
  const flat = (t: string) => t.replace(/\s+/g, "");
  const absent = needed.filter(s => !flat(parsed.text).includes(flat(s)));
  const junk = ["undefined", "NaN", "[object", "Infinity"].filter(s => parsed.text.includes(s));
  if (/[^.]\.\.(?!\.)/.test(parsed.text)) junk.push("double period");
  check("report", absent.length === 0, absent.length ? `missing: ${absent.join(", ")}` : `${parsed.numpages} pages, all thirteen sections and every lease present`);
  check("report", junk.length === 0, junk.length ? `found: ${junk.join(", ")}` : "no undefined/NaN/[object] text");
  return finish(outDir, { deal, pdf });
}

function finish(outDir: string, out: { deal: unknown; pdf: Buffer } | null) {
  mkdirSync(outDir, { recursive: true });
  if (out) {
    writeFileSync(path.join(outDir, "decision-record.pdf"), out.pdf);
    writeFileSync(path.join(outDir, "deal.json"), JSON.stringify(out.deal, null, 1));
  }
  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.stage.padEnd(12)} ${c.detail}`);
  console.log(`\n${failed.length ? "FAILED" : "PASSED"}: ${checks.length - failed.length} of ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
