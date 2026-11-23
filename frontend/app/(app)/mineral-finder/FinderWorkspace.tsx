"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useApiFetch } from "@/lib/trrc/use-api-fetch";
import { parseFinderRequest } from "@/lib/mineral-finder/criteria";
import type { Criteria, FinderResult, Prospect } from "@/lib/mineral-finder/types";
import { rozOf } from "@/lib/mineral-finder/roz";
import { describeRoz, rozCitation, type RozContext } from "@/lib/geology/san-andres-roz";
import styles from "./finder.module.css";

const Map = dynamic(() => import("./FinderMap"), { ssr: false, loading: () => <p>Loading well map…</p> });
const DEFAULT = "Find plugged and inactive oil wells in Gaines County drilled before 1995, within 3 miles of producing offsets.";
type Run = { id: string; status: string; stage: string; request_json: { query: string; criteria: Criteria }; result_json?: FinderResult | null; error_summary?: string | null; created_at: string };
const usd = (v: number | null) => v === null ? "Quote required" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
const apiLabel = (a: string) => `42-${a.slice(2, 5)}-${a.slice(5)}`;
/** Status wording and colour as the Due Diligence Engine shows a deal's state. */
const STATUS: Record<string, [string, string]> = {
  queued: ["Queued", "var(--accent)"], running: ["In progress", "var(--accent)"],
  complete: ["Complete", "var(--green)"], failed: ["Needs attention", "var(--red)"],
};
const statusOf = (s: string) => STATUS[s] ?? [s, "var(--muted)"];
const county = (c: string) => c.charAt(0) + c.slice(1).toLowerCase();
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function FinderWorkspace({ runId, api }: { runId?: string; api?: string }) {
  const apiFetch = useApiFetch();
  const [query, setQuery] = useState(DEFAULT); const [criteria, setCriteria] = useState<Criteria>(() => parseFinderRequest(DEFAULT));
  const [run, setRun] = useState<Run | null>(null); const [history, setHistory] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    let gone = false, done = false, seq = 0, inFlightSince = 0, lastOk = Date.now();
    const load = async () => {
      const mine = ++seq; inFlightSince = Date.now();
      try {
        // Timestamped so no cache between this tab and the server can answer with an earlier state.
        const r = await apiFetch(runId ? `/api/mineral-finder/${runId}?t=${Date.now()}` : "/api/mineral-finder"); const b = await r.json();
        if (gone || mine !== seq) return; // a newer check superseded this one
        if (!r.ok) throw Error(b.error ?? "Could not load Mineral Finder");
        if (runId) { setRun(b.data); done = b.data?.status === "complete" || b.data?.status === "failed"; } else setHistory(b.data);
        lastOk = Date.now(); setCheckedAt(lastOk); setStalled(false); setError(null);
      } catch (e) { if (!gone && mine === seq) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (mine === seq) inFlightSince = 0; }
    };
    // A finished run is loaded once. While a run is active, check every 5 s; a check
    // that has not answered in 20 s is abandoned and retried, and after 30 s without
    // an answer the page says so instead of showing a stale stage as if it were live.
    const tick = () => {
      if (gone || done || !runId) return;
      if (Date.now() - lastOk > 30_000) setStalled(true);
      if (inFlightSince && Date.now() - inFlightSince < 20_000) return;
      void load();
    };
    // Returning to the tab checks at once; a browser may have paused the timer while it was hidden.
    const onVisible = () => { if (document.visibilityState === "visible" && !done && !gone) { lastOk = Date.now(); inFlightSince = 0; void load(); } };
    void load();
    const timer = runId ? setInterval(tick, 5000) : null;
    document.addEventListener("visibilitychange", onVisible); window.addEventListener("focus", onVisible);
    return () => { gone = true; if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [apiFetch, runId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const requestKey = key ?? crypto.randomUUID(); setKey(requestKey);
    try {
      const r = await apiFetch("/api/mineral-finder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey, query, criteria }) });
      const b = await r.json(); if (!r.ok) throw Error(b.error ?? "Research could not be queued");
      window.location.assign(`/mineral-finder/${b.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  const result = run?.result_json; const chosen = result?.prospects.find(p => p.api === api);
  const shown = chosen ? [chosen] : result?.prospects ?? [];
  const [statusLabel, statusColor] = statusOf(run?.status ?? "");
  return <div className={styles.page}><div className={styles.root}>
    <div className={styles.heading}><div><h1>Mineral Finder</h1><p>Find historical wells worth investigating, with the public evidence behind each one. Texas pilot.</p></div>{runId && <Link href="/mineral-finder" className={styles.button}>New research</Link>}</div>
    {error && <div role="alert" className={styles.error}>{error}</div>}
    {!runId && <>
      <form onSubmit={submit} className={styles.card}>
        <label htmlFor="finder-query">What would you like to investigate?</label>
        <textarea id="finder-query" value={query} maxLength={2000} onChange={e => { setQuery(e.target.value); setKey(null); try { setCriteria(parseFinderRequest(e.target.value)); } catch { /* Submit validates unsupported requests. */ } }} />
        <div className={styles.filters}>
          <label>County<select value={criteria.county} onChange={e => { setCriteria({ ...criteria, county: e.target.value as Criteria["county"] }); setKey(null); }}><option value="GAINES">Gaines, Texas</option><option value="FISHER">Fisher, Texas</option></select></label>
          <label>Evidence before year<input type="number" min="1850" max={new Date().getFullYear() + 1} value={criteria.beforeYear} onChange={e => { setCriteria({ ...criteria, beforeYear: +e.target.value }); setKey(null); }} /></label>
          <label>Offset radius (mi)<input type="number" min="0.25" max="10" step="0.25" value={criteria.radiusMiles} onChange={e => { setCriteria({ ...criteria, radiusMiles: +e.target.value }); setKey(null); }} /></label>
          <label>Maximum leads<input type="number" min="1" max="25" value={criteria.limit} onChange={e => { setCriteria({ ...criteria, limit: +e.target.value }); setKey(null); }} /></label>
        </div>
        <div className={styles.filters}>{(["plugged", "shut_in", "dry"] as const).map(status => <label key={status}><input type="checkbox" checked={criteria.statuses.includes(status)} onChange={e => { setCriteria({ ...criteria, statuses: e.target.checked ? [...criteria.statuses, status] : criteria.statuses.filter(s => s !== status) }); setKey(null); }} /> {status.replace("_", " ")}</label>)}</div>
        <div className={styles.submitRow}>
          <p className={styles.note}>The filters above are the executable request. This pilot searches historical well evidence; it does not establish reserves, rights availability or profitable redevelopment. First county ingestion can take several minutes; you can close this page after submission.</p>
          <button className={styles.primary} disabled={busy}>{busy ? "Starting…" : "Find research leads"}</button>
        </div>
      </form>
      {history.length > 0 && <div className={`${styles.card} ${styles.flush}`}><h2>Recent research</h2>{history.map(h => { const [label, color] = statusOf(h.status); return <Link className={styles.history} href={`/mineral-finder/${h.id}`} key={h.id}><span>{when(h.created_at)}</span><strong>{county(h.request_json.criteria.county)}</strong><span style={{ color }}>{label}</span><span>{h.stage}</span></Link>; })}</div>}
    </>}
    {run && <div className={styles.card}>
      <div className={styles.label} style={{ color: statusColor }}>{statusLabel}</div>
      <div className={styles.stage}>{run.stage}</div>
      <p>{run.request_json.query}</p>
      <small>{county(run.request_json.criteria.county)} County · before {run.request_json.criteria.beforeYear} · {run.request_json.criteria.radiusMiles} mile radius · up to {run.request_json.criteria.limit} leads</small>
      {run.error_summary && <p className={styles.error}>{run.error_summary}</p>}
      {!result && <p className={styles.note} style={{ margin: "0.8rem 0 0" }}>{run.status === "failed" ? "No completed result was published. Start a new run after resolving the recorded failure." : `The work continues on the server if this page is closed. This page refreshes automatically${checkedAt ? `; last checked ${new Date(checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : ""}.`}</p>}
      {!result && stalled && run.status !== "failed" && <p className={styles.error}>This page has lost contact with the server, so the stage above may be out of date. Reload the page to see the current state; the research continues on the server.</p>}
    </div>}
    {result && <>
      <div className={styles.stats}><div><strong>{result.wells.toLocaleString()}</strong>county wells indexed</div><div><strong>{result.eligible.toLocaleString()}</strong>historical leads meeting filters</div><div><strong>{result.prospects.length}</strong>ranked for follow-up</div><div><strong>Review required</strong>geology, title and economics</div></div>
      <div className={styles.actions}><a className={styles.primary} href={`/api/mineral-finder/${runId}/report${chosen ? `?api=${chosen.api}` : ""}`}>Download prospect PDF</a><a className={styles.button} href={`/api/mineral-finder/${runId}`}>Source JSON</a><Link href={`/mineral-finder/${runId}`} className={styles.button}>All prospects</Link></div>
      <Map prospects={shown} selected={api ?? null} radius={result.criteria.radiusMiles} />
      {!chosen && <div className={styles.card}><h2>Research priorities</h2><p>Scores measure evidence for further research. They are not investment returns or discovery probabilities.</p><div className={styles.table}><table><thead><tr><th>Rank</th><th>API / field</th><th>Status</th><th>Score / 90</th><th>Proxy offsets</th><th>Logs</th><th>ROZ partition</th><th>Economics</th></tr></thead><tbody>{result.prospects.map(p => { const roz = rozOf(p); return <tr key={p.api}><td>{p.rank}</td><td><Link href={`/mineral-finder/${runId}/${p.api}`}>{apiLabel(p.api)}</Link><small>{p.well.association?.fieldName ?? "Field unavailable"}</small></td><td>{p.well.status}</td><td>{p.score}</td><td>{p.offsets.length}</td><td>{p.catalog.length}</td><td>{!roz ? "—" : roz.partition ? `#${roz.partition.id}` : <span style={{ color: "var(--faint)" }}>Not established</span>}</td><td>Insufficient data</td></tr>; })}</tbody></table></div>{!result.prospects.length && <p>No defensible leads meet this request with the available evidence. Review exclusions and source coverage below.</p>}</div>}
      {chosen && <ProspectDetail p={chosen} />}
      {api && !chosen && <div className={styles.error}>This API is not in this run&apos;s ranked shortlist.</div>}
      <div className={styles.card}><h2>Recommended record acquisitions</h2><p>One preliminary useful log per subject. Prices are published scan estimates, not confirmed quotes. No purchases occur in Mineral Finder.</p>{(chosen?.purchases ?? result.purchases).map(p => <div className={styles.purchase} key={p.itemId}><strong>BEG item {p.itemId} · {usd(p.estimatedUsd)}</strong><p>{p.purpose}</p><small>{p.scope} {p.pricingCheckedAt && `Pricing checked ${p.pricingCheckedAt.slice(0, 10)}.`} Human approval required.</small><p><a href={p.pricingUrl} target="_blank" rel="noreferrer">Verify pricing and request from BEG ↗</a></p></div>)}{!(chosen?.purchases ?? result.purchases).length && <p>No sufficiently identified useful log selected. Request a catalog/coverage review before purchasing.</p>}</div>
      <div className={styles.card}><h2>Source coverage and limitations</h2><p>Generated {new Date(result.generatedAt).toLocaleString()}. Countywide geological and commercial coverage is incomplete.</p>{result.sources.map(s => <div className={styles.source} key={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.provider}</a><span className={styles.badge}>{s.status} · {s.count} records</span><small>{s.retrievedAt} · {s.complete ? "Query snapshot complete" : "Limited coverage"}</small>{s.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>)}<h3>Exclusions</h3>{Object.entries(result.excluded).map(([k, v]) => <p key={k}>{k.replaceAll("_", " ")}: {v.toLocaleString()}</p>)}{result.warnings.map((w, i) => <p className={styles.note} key={i}>{w}</p>)}</div>
    </>}
  </div></div>;
}

/** Published San Andres ROZ context for the lead's field; never part of the score. */
function RozCard({ ctx }: { ctx: RozContext | null }) {
  if (!ctx) return null;
  const d = describeRoz(ctx, "well");
  return <div className={styles.card}>
    <h2>San Andres residual oil zone · published context</h2>
    <p>{d.summary}</p>
    {d.figures.length > 0 && <div className={styles.table}><table><tbody>{d.figures.map(f => <tr key={f.label}><td style={{ color: "var(--muted)", width: "34%" }}>{f.label}</td><td>{f.value}</td></tr>)}</tbody></table></div>}
    <p style={{ marginTop: "0.8rem" }}>{d.reservoirNote}</p>
    <p className={styles.note}>{d.caveat}</p>
    <small>{rozCitation(ctx)}</small>
  </div>;
}

function ProspectDetail({ p }: { p: Prospect }) {
  return <>
    <div className={styles.card}><div className={styles.label}>Research lead · professional review required</div><div className={styles.title}>{apiLabel(p.api)} · {p.well.association?.fieldName ?? "Field unavailable"}</div><p>{p.geologicalAssessment}</p><div className={styles.filters}><span>County: {p.well.county}</span><span>Operator of record: {p.well.association?.operator ?? "Unavailable"}</span><span>Lease: {p.well.association?.district ?? "Unavailable"} / {p.well.association?.lease ?? "Unavailable"}</span></div><p>Age evidence: {p.ageEvidence.date}, {p.ageEvidence.basis.replaceAll("_", " ")} [{p.ageEvidence.sourceId}]. Formation: {p.formation ?? "Unavailable"}. {p.formationBasis}</p><p>Position: {p.well.lat}, {p.well.lng}. {p.well.locationDescription}</p><h3>Score explanation</h3>{p.scoreExplanation.map(e => <p key={e.criterion}><strong>+{e.points}</strong> {e.criterion} {e.evidence.length > 0 && `[${e.evidence.join(", ")}]`}</p>)}</div>
    <div className={styles.card}><h2>Historical production</h2><p>Lease-level evidence; volumes must not be assigned to this well. {p.production?.reason}</p>{p.production?.rows.length ? <><p>{p.production.rows.length} returned monthly slots, {p.production.rows[0].month}–{p.production.rows.at(-1)?.month}; {p.production.rows.filter(r => r.oil !== null || r.gas !== null || r.water !== null).length} contain reported volumes. Unreported months remain unavailable.</p><p>Reported lease oil in returned period: {p.production.rows.some(r => r.oil === null) ? "Incomplete volume history" : p.production.rows.reduce((s, r) => s + r.oil!, 0).toLocaleString()} bbl.</p><p>{p.decline ? `Existing Arps screening fit: current annual decline ${p.decline.annualPct.toFixed(1)}%, R² ${p.decline.rSquared.toFixed(2)}. This is a lease decline, not a redevelopment forecast.` : "Decline fit unavailable or inappropriate for this reported series; no restart rate inferred."}</p></> : <p>Historical production insufficiently established in this pass.</p>}<h3>Geological confidence: {p.geologicalConfidence}</h3><p>Catalog and field evidence have not established reservoir continuity or remaining hydrocarbons.</p><h3>Preliminary economics</h3><p>{p.economics.reason}</p></div>
    <RozCard ctx={rozOf(p)} />
    <div className={styles.card}><h2>Compatible offset leads</h2><p>Same RRC field and named formation within the requested radius. These are reservoir proxies; completion intervals and continuity still need verification.</p>{p.offsets.map(o => <p key={o.api}><strong>{apiLabel(o.api)}</strong> · {o.distanceMiles} mi · {o.formation} · positive reported lease volumes: {o.historicallyProductive === null ? "unverified" : o.historicallyProductive ? "yes" : "not in returned period"}</p>)}{!p.offsets.length && <p>No compatible offset established.</p>}</div>
    <div className={styles.card}><h2>Available geological catalog records</h2>{p.catalog.map(c => <div className={styles.source} key={c.id}><a href={c.url} target="_blank" rel="noreferrer">BEG {c.id} · {c.collection} · {c.logTypes ?? c.material ?? "Type unavailable"}</a><p>Accession {c.accession ?? "unavailable"}; depth {c.topFt ?? "unavailable"}–{c.bottomFt ?? "unavailable"} ft. Catalog formation: {c.formation ?? "unavailable"}.</p><small>Catalog only; no log interpretation. {c.coordinatesUncertain && "Catalog coordinates approximate."}</small></div>)}{!p.catalog.length && <p>No exact API catalog match in the loaded evidence.</p>}</div>
    <div className={styles.card}><h2>Required diligence</h2>{[...p.gaps, ...p.risks].map((g, i) => <p key={i}>• {g}</p>)}<div className={styles.actions}><Link className={styles.button} href={`/trrc-due-diligence?apis=${encodeURIComponent(p.api)}`}>Investigate in existing diligence engine</Link></div><p className={styles.note}>The existing package intake links title, ownership and economic workflows. This handoff does not certify ownership or approve a redevelopment scenario.</p></div>
  </>;
}
