/**
 * Demo acceptance test: checks one real package end to end against what is
 * stored and what the production report code produces from it.
 *
 *   npx tsx scripts/demo-acceptance.ts <packageId> <userId> [outDir] [lease=apis ...] [--regression]
 *
 * --regression accepts a lease that cannot be valued only when the report
 * states why (for example, no mineral roll imported for its county) and the
 * verdict is REVIEW; the demo package itself is always checked strictly.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (reads only).
 * Exit code 0 only when every check passes. Writes the acquisition report PDF
 * and a JSON of the deal to outDir. Nothing here changes the data.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadDeal } from "../lib/trrc/deal/build";
import { renderDealPdf } from "../lib/trrc/deal/pdf";

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
  check("intake", !!pkg && members.length > 0 && members.every(m => m.runId), `${members.length} members, all with runs: ${members.every(m => m.runId)}`);
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
    check("retrieval", missing.length === 0 || ambiguous, `${r.resolved_primary_api}: ${latest.size} sources, ${failed.length ? `failed: ${failed.join("; ")}` : "none failed"}${missing.length ? `; required not retrieved: ${missing.join(", ")}` : ""}`);
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
  const strip = (d: typeof deal) => JSON.stringify({ ...d, generatedAt: null, sources: d.sources.map(s => ({ ...s, retrievedAt: s.label === "Price deck" ? null : s.retrievedAt })) });
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
    const statedGap = regression && l.ownership.status !== "matched" && !!l.ownership.reason && l.valuation.status !== "valued" && l.decision.verdict === "REVIEW";
    check("ownership", statedGap || (l.ownership.status === "matched" && l.ownership.nameVerified && l.ownership.tracts.every(t => !t.irregular)), `${tag}: ${l.ownership.status}, ${l.ownership.owners.length} owners, ${l.ownership.tracts.length} tract(s), rejected ${l.ownership.rejectedTracts.length}${l.ownership.reason ? `, ${l.ownership.reason}` : ""}`);
    const v = l.valuation;
    const finite = v.status === "valued" && [v.royaltyUnitPv10, v.workingInterestPv10, v.totalsPv10].every(x => x && Object.values(x).every(Number.isFinite));
    check("economics", statedGap || (finite && v.owners.every(o => o.interestType === "unknown" || o.pv10 !== null)), `${tag}: ${v.status}${v.reason ? ` (${v.reason})` : ""}, base PV-10 all owners $${Math.round(v.totalsPv10?.base ?? 0).toLocaleString("en-US")}, life ${v.economicLimitMonths?.base ?? "-"} mo`);
    const offersOk = l.offers.status === "calculated" && l.offers.ranges.every(r => r.low <= r.high && r.high <= r.ceiling && r.low > 0);
    check("decision", !!l.decision.verdict && l.decision.reasons.length > 0 && (l.valuation.status !== "valued" || offersOk), `${tag}: ${l.decision.verdict} — ${l.decision.reasons[0]}`);
    check("title", l.title.status === "published" ? l.title.indexedInstruments > 0 : !!l.title.reason, `${tag}: ${l.title.status}${l.title.status === "published" ? `, ${l.title.indexedInstruments} recordings, ${l.title.readInstruments} read` : `, ${l.title.reason}`}`);
    const cited = [...l.sources.production, ...l.sources.wells, ...l.sources.roll, ...l.sources.title];
    check("citations", cited.length >= 3 && cited.every(id => deal.sources.some(s => s.id === id)) && (l.title.status !== "published" || l.sources.title.length > 0), `${tag}: cites [${cited.join(", ")}]`);
  }
  check("decision", !!deal.decision.verdict, `deal: ${deal.decision.verdict} — ${deal.decision.reasons.join(" ")}`);
  if (ambiguousApis.size) {
    const inputsFor = (api: string) => members.filter(m => m.input.replace(/\D/g, "").startsWith(api.replace(/\D/g, "").slice(0, 10)));
    const unlisted = [...ambiguousApis].filter(api => !inputsFor(api).every(m => deal.excluded.some(x => x.input === m.input && x.reason)));
    check("grouping", unlisted.length === 0, unlisted.length ? `ambiguous APIs not listed as excluded: ${unlisted.join(", ")}` : `${ambiguousApis.size} API(s) with ambiguous lease associations are excluded from valuation with a stated reason`);
  }

  // 9 Report
  const pdf = await renderDealPdf(deal);
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (b: Buffer, o?: Record<string, unknown>) => Promise<{ numpages: number; text: string }>;
  const pageText: string[] = [];
  const parsed = await pdfParse(pdf, { pagerender: async (page: { getTextContent: () => Promise<{ items: { str: string }[] }> }) => {
    const text = (await page.getTextContent()).items.map(i => i.str).join(" ");
    pageText.push(text);
    return text;
  } });
  // A page holding only the running header and footer is a layout defect.
  const bare = pageText.map((t, i) => [i + 1, t.replace(/MineralFlow AI — Acquisition Report|Package \S+ · \S+|CONFIDENTIAL — Public-record screening, not a title opinion, reserve report or appraisal|\d+ \/ \d+/g, "").trim().length] as const).filter(([, n]) => n < 40);
  check("report", bare.length === 0, bare.length ? `pages with no content: ${bare.map(([p]) => p).join(", ")}` : "no blank pages");
  const needed = ["1. DECISION", "2. LEASE AND WELLS", "3. PRODUCTION AND FORECAST", "4. OWNERSHIP", "5. CHAIN OF TITLE", "6. REGULATORY", "7. EVIDENCE", ...deal.leases.map(l => l.leaseName ?? l.leaseNumber)];
  const flat = (t: string) => t.replace(/\s+/g, "");
  const absent = needed.filter(s => !flat(parsed.text).includes(flat(s)));
  const junk = ["undefined", "NaN", "[object", "Infinity"].filter(s => parsed.text.includes(s));
  if (/[^.]\.\.(?!\.)/.test(parsed.text)) junk.push("double period");
  check("report", absent.length === 0, absent.length ? `missing: ${absent.join(", ")}` : `${parsed.numpages} pages, all seven sections and every lease present`);
  check("report", junk.length === 0, junk.length ? `found: ${junk.join(", ")}` : "no undefined/NaN/[object] text");
  return finish(outDir, { deal, pdf });
}

function finish(outDir: string, out: { deal: unknown; pdf: Buffer } | null) {
  mkdirSync(outDir, { recursive: true });
  if (out) {
    writeFileSync(path.join(outDir, "acquisition-report.pdf"), out.pdf);
    writeFileSync(path.join(outDir, "deal.json"), JSON.stringify(out.deal, null, 1));
  }
  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.stage.padEnd(12)} ${c.detail}`);
  console.log(`\n${failed.length ? "FAILED" : "PASSED"}: ${checks.length - failed.length} of ${checks.length} checks`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
