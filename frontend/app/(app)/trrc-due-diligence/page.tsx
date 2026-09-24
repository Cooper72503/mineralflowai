"use client";

/**
 * Due Diligence Engine — the one intake.
 *
 * Paste or upload 1–50 API numbers. Everything after that is automatic:
 * each API is normalized and resolved to its well and TRRC lease, wells are
 * grouped by lease (lease production counted once), lease records and the
 * county mineral roll give the owners of record, the worker researches the
 * courthouse chain of title, and the deal engine values every interest and
 * recommends an offer. Nothing is asked of the user: prices, costs and
 * decision rules are MineralFlow standard assumptions stated in the report.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useApiFetch } from "@/lib/trrc/use-api-fetch";
import type { DealSummary } from "@/lib/trrc/deal/build";
import { COLORS } from "./colors";

const RUN_POLL_MS = 3000;
const REPORT_POLL_MS = 12000;
const TERMINAL = ["complete", "failed", "cancelled", "create_failed"];
const SESSION_KEY = "mineralflow-engine-submission";

interface Member { input: string; runId: string | null; status: string; progress: number; error: string | null }

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const verdictColor = (v: string) => v === "BUY" ? COLORS.green : v === "PASS" ? COLORS.red : COLORS.yellow;
const verdictBg = (v: string) => v === "BUY" ? COLORS.greenDim : v === "PASS" ? COLORS.redDim : COLORS.yellowDim;
const label: React.CSSProperties = { fontSize: "0.68rem", color: COLORS.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" };
const card: React.CSSProperties = { background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.1rem 1.25rem", marginBottom: "1rem" };
const button = (enabled: boolean): React.CSSProperties => ({ background: COLORS.accent, color: "#fff", border: "none", borderRadius: 7, padding: "0.6rem 1.3rem", fontSize: "0.85rem", fontWeight: 600, cursor: enabled ? "pointer" : "default", opacity: enabled ? 1 : 0.5 });
const quiet: React.CSSProperties = { background: "transparent", border: `1px solid ${COLORS.border}`, borderRadius: 7, color: COLORS.textMuted, fontSize: "0.8rem", padding: "0.5rem 0.9rem", cursor: "pointer" };

export default function DueDiligenceEnginePage() {
  const apiFetch = useApiFetch();
  const [rawText, setRawText] = useState("");
  const [packageId, setPackageId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [stage, setStage] = useState<string | null>(null);
  const [summary, setSummary] = useState<DealSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const inputs = Array.from(new Set(rawText.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)));

  useEffect(() => {
    const url = new URL(window.location.href);
    setPackageId(url.searchParams.get("package"));
  }, []);

  const upload = useCallback(async (file: File) => {
    setExtracting(true); setError(null);
    try {
      const form = new FormData(); form.append("file", file);
      const data = await apiFetch("/api/trrc/due-diligence/extract-apis", { method: "POST", body: form }).then(r => r.json());
      if (!data.ok) throw Error(data.error ?? "No API numbers could be read from that PDF.");
      const found: string[] = data.data.apiNumbersFound;
      if (!found.length) throw Error(`No API numbers were found in "${file.name}". Paste them below instead.`);
      setRawText(prev => Array.from(new Set([...prev.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean), ...found])).join("\n"));
    } catch (e) { setError(e instanceof Error ? e.message : "The PDF could not be read."); }
    finally { setExtracting(false); if (fileRef.current) fileRef.current.value = ""; }
  }, [apiFetch]);

  const submit = useCallback(async () => {
    if (!inputs.length || inputs.length > 50) return;
    setSubmitting(true); setError(null);
    try {
      // One request key per exact input list, so a retry recovers the same deal instead of starting another.
      const signature = inputs.join("\n");
      let key: string;
      try {
        const prior = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
        key = prior?.signature === signature ? prior.key : crypto.randomUUID();
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ signature, key }));
      } catch { key = crypto.randomUUID(); }
      const result = await apiFetch("/api/trrc/due-diligence/packages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestKey: key, inputs, options: {} }) }).then(r => r.json());
      if (!result.ok) throw Error(result.error ?? "The deal could not be started.");
      setPackageId(result.data.id); setSummary(null); setStage("Retrieving public records");
      const url = new URL(window.location.href); url.searchParams.set("package", result.data.id); window.history.replaceState(null, "", url);
    } catch (e) { setError(e instanceof Error ? e.message : "Connection lost. Submit again to recover the same deal."); }
    finally { setSubmitting(false); }
  }, [inputs, apiFetch]);

  // Well retrieval progress.
  useEffect(() => {
    if (!packageId) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const r = await apiFetch(`/api/trrc/due-diligence/packages/${packageId}`).then(x => x.json());
        if (stopped) return;
        if (!r.ok) throw Error(r.error ?? "The deal could not be loaded.");
        setMembers(r.data.members_json.map((m: { input: string; runId: string | null; error: string | null }) => {
          const run = r.data.runs.find((x: { id: string }) => x.id === m.runId);
          return { input: m.input, runId: m.runId, status: run?.status ?? "create_failed", progress: run?.progress_percent ?? 0, error: run?.error_summary ?? m.error };
        }));
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : "Refresh failed; the deal continues on the server."); }
    };
    void refresh();
    const t = setInterval(refresh, RUN_POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [packageId, apiFetch]);

  const retrievalDone = members.length > 0 && members.every(m => TERMINAL.includes(m.status));

  // The decision, once retrieval and courthouse research are done.
  useEffect(() => {
    if (!packageId || !retrievalDone || summary) return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await apiFetch(`/api/trrc/due-diligence/packages/${packageId}/report?format=summary`);
        const body = await res.json();
        if (stopped) return;
        if (res.status === 409) { setStage(body.error ?? "Researching courthouse records"); return; }
        if (!body.ok) throw Error(body.error ?? "The decision could not be built.");
        setSummary(body.summary); setStage(null); setError(null);
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : "The decision could not be built."); }
    };
    setStage("Tracing ownership and valuing the leases");
    void check();
    const t = setInterval(check, REPORT_POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [packageId, retrievalDone, summary, apiFetch]);

  const download = async () => {
    if (!packageId) return;
    setDownloading(true); setError(null);
    try {
      const res = await apiFetch(`/api/trrc/due-diligence/packages/${packageId}/report`);
      if (!res.ok) { const b = await res.json().catch(() => null); throw Error(b?.error ?? "The report could not be built."); }
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "MineralFlow-Acquisition-Report.pdf";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "Download failed."); }
    finally { setDownloading(false); }
  };

  const reset = () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
    setPackageId(null); setMembers([]); setSummary(null); setStage(null); setError(null); setRawText("");
    const url = new URL(window.location.href); url.searchParams.delete("package"); window.history.replaceState(null, "", url);
  };

  const complete = members.filter(m => m.status === "complete").length;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, padding: "2rem", fontFamily: "-apple-system, sans-serif" }}>
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <h1 style={{ fontSize: "1.6rem", fontWeight: 700, color: COLORS.text, margin: "0 0 0.35rem 0", letterSpacing: "-0.02em" }}>Due Diligence Engine</h1>
          <p style={{ fontSize: "0.88rem", color: COLORS.textMuted, margin: 0, maxWidth: 720 }}>
            Enter the API numbers in a deal. The engine connects each well to its lease, traces ownership through the county mineral roll and the courthouse record, values every interest and recommends an offer.
          </p>
        </div>

        {!packageId && (
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.8rem" }}>
              <input ref={fileRef} id="engine-pdf" type="file" accept="application/pdf,.pdf" style={{ display: "none" }} disabled={extracting}
                onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
              <label htmlFor="engine-pdf" style={{ ...quiet, color: COLORS.text, fontWeight: 600 }}>{extracting ? "Reading PDF…" : "Upload a PDF of API numbers"}</label>
              <span style={{ fontSize: "0.75rem", color: COLORS.textFaint }}>or paste them below, one per line</span>
            </div>
            <textarea value={rawText} onChange={e => setRawText(e.target.value)} rows={10} placeholder={"42-329-46216\n42-329-46217\n42-329-46218"}
              style={{ width: "100%", background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 7, color: COLORS.text, fontSize: "0.85rem", padding: "0.75rem", fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "0.75rem" }}>
              <span style={{ fontSize: "0.78rem", color: inputs.length > 50 ? COLORS.red : COLORS.textFaint }}>
                {inputs.length} API{inputs.length === 1 ? "" : "s"}{inputs.length > 50 ? " — 50 is the maximum per deal" : ""}
              </span>
              <button onClick={submit} disabled={submitting || !inputs.length || inputs.length > 50} style={button(!submitting && inputs.length > 0 && inputs.length <= 50)}>
                {submitting ? "Starting…" : "Run due diligence"}
              </button>
            </div>
          </div>
        )}

        {error && <div style={{ ...card, background: COLORS.redDim, borderColor: COLORS.red, color: COLORS.red, fontSize: "0.82rem", padding: "0.7rem 1rem" }}>{error}</div>}

        {packageId && !summary && (
          <div style={card}>
            <div style={label}>In progress</div>
            <div style={{ fontSize: "1rem", color: COLORS.text, fontWeight: 600, margin: "0.35rem 0 0.6rem" }}>
              {retrievalDone ? stage ?? "Tracing ownership and valuing the leases" : `Retrieving public records — ${complete} of ${members.length || "…"} wells complete`}
            </div>
            <div style={{ height: 6, background: COLORS.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${members.length ? Math.round((members.reduce((a, m) => a + (TERMINAL.includes(m.status) ? 100 : m.progress), 0) / members.length) * (retrievalDone ? 1 : 0.8)) : 5}%`, background: COLORS.accent, transition: "width 0.4s" }} />
            </div>
            <p style={{ fontSize: "0.75rem", color: COLORS.textFaint, margin: "0.6rem 0 0" }}>The work continues on the server if this page is closed. Reopen this address to return to the deal.</p>
          </div>
        )}

        {summary && (
          <>
            <div style={{ ...card, display: "flex", alignItems: "flex-start", gap: "1rem" }}>
              <span style={{ background: verdictBg(summary.verdict), color: verdictColor(summary.verdict), fontWeight: 700, fontSize: "1rem", borderRadius: 6, padding: "0.35rem 0.8rem", letterSpacing: "0.04em" }}>{summary.verdict}</span>
              <div style={{ flex: 1 }}>
                {summary.reasons.map((r, i) => <div key={i} style={{ color: i === 0 ? COLORS.text : COLORS.textMuted, fontSize: i === 0 ? "0.95rem" : "0.82rem", fontWeight: i === 0 ? 600 : 400, marginBottom: 4 }}>{r}</div>)}
                <div style={{ fontSize: "0.75rem", color: COLORS.textFaint, marginTop: 6 }}>{summary.submitted} APIs · {summary.leases.length} lease{summary.leases.length === 1 ? "" : "s"} · {summary.deckLabel}</div>
              </div>
              <button onClick={download} disabled={downloading} style={button(!downloading)}>{downloading ? "Building report…" : "Download acquisition report"}</button>
            </div>

            {summary.leases.map((l, i) => (
              <div key={i} style={card}>
                <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", marginBottom: "0.7rem" }}>
                  <span style={{ color: verdictColor(l.verdict), fontWeight: 700, fontSize: "0.8rem" }}>{l.verdict}</span>
                  <span style={{ color: COLORS.text, fontWeight: 600 }}>{l.name ?? "Lease"}</span>
                  <span style={{ color: COLORS.textFaint, fontSize: "0.8rem" }}>RRC {l.district}-{l.leaseNumber} · {l.county} County · {l.operator}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.75rem", marginBottom: "0.8rem" }}>
                  <Stat k="Wells" v={`${l.apis} submitted · ${l.producingWells} producing`} />
                  <Stat k="Owners of record" v={l.ownershipStatus === "matched" ? String(l.owners) : "Not established"} />
                  <Stat k="Chain of title" v={l.titleStatus === "published" ? `${l.indexedInstruments} recordings · ${l.readInstruments} read` : "Not published"} />
                  <Stat k="Economic life" v={l.economicLimitMonths !== null ? `${l.economicLimitMonths} months` : "—"} />
                </div>
                {l.offers.status === "calculated" ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", marginBottom: "0.7rem" }}>
                    <thead><tr>{["Offer", "Range", "Ceiling"].map(h => <th key={h} style={{ ...label, textAlign: h === "Offer" ? "left" : "right", padding: "0.35rem 0" }}>{h}</th>)}</tr></thead>
                    <tbody>{l.offers.ranges.map((r, j) => (
                      <tr key={j} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                        <td style={{ color: COLORS.text, padding: "0.45rem 0" }}>{r.interest === "royalty" ? "Royalty, per 0.01 decimal" : "Working interest, per 1%"}</td>
                        <td style={{ color: COLORS.text, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(r.low)} – {usd(r.high)}</td>
                        <td style={{ color: COLORS.textMuted, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(r.ceiling)}</td>
                      </tr>))}</tbody>
                  </table>
                ) : <div style={{ fontSize: "0.82rem", color: COLORS.yellow, marginBottom: "0.7rem" }}>No offer: {l.offers.reason}</div>}
                {l.verdict !== "BUY" && l.reasons.map((r, j) => <div key={`r${j}`} style={{ fontSize: "0.8rem", color: COLORS.textMuted, marginBottom: 3 }}>• {r}</div>)}
                {l.risks.length > 0 && <div style={{ ...label, margin: "0.6rem 0 0.3rem" }}>Top risks</div>}
                {l.risks.slice(0, 4).map((r, j) => <div key={`k${j}`} style={{ fontSize: "0.8rem", color: r.severity === 3 ? COLORS.red : r.severity === 2 ? COLORS.yellow : COLORS.textMuted, marginBottom: 3 }}>• {r.text}</div>)}
                <details style={{ marginTop: "0.6rem" }}>
                  <summary style={{ fontSize: "0.78rem", color: COLORS.accent, cursor: "pointer" }}>Well records ({l.members.length})</summary>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem", marginTop: "0.5rem" }}>
                    {l.members.map(m => <Link key={m.runId} href={`/trrc-due-diligence/well?run=${m.runId}`} style={{ fontSize: "0.78rem", color: COLORS.accent, fontFamily: "ui-monospace, monospace", textDecoration: "none" }}>{m.input}</Link>)}
                  </div>
                </details>
              </div>
            ))}

            {summary.excluded.length > 0 && (
              <div style={card}>
                <div style={label}>Not in the valuation</div>
                {summary.excluded.map((x, i) => <div key={i} style={{ fontSize: "0.8rem", color: COLORS.textMuted, marginTop: 4 }}><span style={{ fontFamily: "ui-monospace, monospace", color: COLORS.text }}>{x.input}</span> — {x.reason}</div>)}
              </div>
            )}
          </>
        )}

        {packageId && (
          <>
            {members.length > 0 && !summary && (
              <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                  <tbody>{members.map((m, i) => (
                    <tr key={i} style={{ borderTop: i ? `1px solid ${COLORS.border}` : "none" }}>
                      <td style={{ padding: "0.55rem 1rem", color: COLORS.text, fontFamily: "ui-monospace, monospace" }}>{m.input}</td>
                      <td style={{ padding: "0.55rem 1rem", color: m.status === "complete" ? COLORS.green : ["failed", "cancelled", "create_failed"].includes(m.status) ? COLORS.red : COLORS.accent }}>
                        {m.status === "complete" ? "Records retrieved" : m.status === "create_failed" ? "Not started" : TERMINAL.includes(m.status) ? "Retrieval failed" : `Retrieving · ${m.progress}%`}
                        {m.error && <div style={{ color: COLORS.textFaint, fontSize: "0.72rem" }}>{m.error}</div>}
                      </td>
                      <td style={{ padding: "0.55rem 1rem", textAlign: "right" }}>
                        {m.status === "complete" && m.runId && <Link href={`/trrc-due-diligence/well?run=${m.runId}`} style={{ color: COLORS.accent, fontSize: "0.78rem", textDecoration: "none" }}>Well records →</Link>}
                      </td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
            <button onClick={reset} style={quiet}>Start a new deal</button>
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ background: COLORS.surfaceAlt, borderRadius: 7, padding: "0.55rem 0.75rem" }}>
      <div style={{ ...label, fontSize: "0.62rem" }}>{k}</div>
      <div style={{ color: COLORS.text, fontSize: "0.85rem", marginTop: 3 }}>{v}</div>
    </div>
  );
}
