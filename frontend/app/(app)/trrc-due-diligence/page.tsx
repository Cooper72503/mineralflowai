"use client";

/**
 * Due Diligence Engine — the one intake.
 *
 * Paste or upload 1–50 API numbers. Everything after that is automatic:
 * each API is normalized and resolved to its well and TRRC lease, wells are
 * grouped by lease (lease production counted once), lease records and the
 * county mineral roll give the owners of record, the worker researches the
 * courthouse chain of title, and the decision layer values the interest and
 * recommends an entry and exit. Every assumption starts from a stated source
 * and can be edited; the page recalculates immediately and "Generate
 * Decision Record" prints the same numbers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useApiFetch } from "@/lib/trrc/use-api-fetch";
import { COLORS } from "./colors";
import { EngineDecision, type EngineData } from "./EngineDecision";

const RUN_POLL_MS = 3000;
const REPORT_POLL_MS = 12000;
const TERMINAL = ["complete", "failed", "cancelled", "create_failed"];
const SESSION_KEY = "mineralflow-engine-submission";

interface Member { input: string; runId: string | null; status: string; progress: number; error: string | null }

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
  const [summary, setSummary] = useState<EngineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [recent, setRecent] = useState<{ id: string; status: string; createdAt: string; apiCount: number; firstInputs: string[] }[] | null>(null);

  const inputs = Array.from(new Set(rawText.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)));

  useEffect(() => {
    const url = new URL(window.location.href);
    setPackageId(url.searchParams.get("package"));
  }, []);

  // Earlier deals, so a finished one can be reopened (and shown if a source is down).
  useEffect(() => {
    if (packageId) return;
    apiFetch("/api/trrc/due-diligence/packages").then(r => r.json()).then(b => { if (b.ok) setRecent(b.data); }).catch(() => setRecent([]));
  }, [packageId, apiFetch]);

  const openDeal = (id: string) => {
    setPackageId(id); setMembers([]); setSummary(null); setStage(null); setError(null);
    const url = new URL(window.location.href); url.searchParams.set("package", id); window.history.replaceState(null, "", url);
  };

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
    let stopped = false, inFlight = false;
    const check = async () => {
      // Building the decision takes several seconds; never start a second one alongside it.
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await apiFetch(`/api/trrc/due-diligence/packages/${packageId}/report?format=engine`);
        const body = await res.json();
        if (stopped) return;
        if (res.status === 409) { setStage(body.error ?? "Researching courthouse records"); return; }
        if (!body.ok) throw Error(body.error ?? "The decision could not be built.");
        setSummary({ deal: body.deal, starting: body.starting }); setStage(null); setError(null);
      } catch (e) { if (!stopped) setError(e instanceof Error ? e.message : "The decision could not be built."); }
      finally { inFlight = false; }
    };
    setStage("Tracing ownership and valuing the leases");
    void check();
    const t = setInterval(check, REPORT_POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [packageId, retrievalDone, summary, apiFetch]);

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

        {!packageId && recent && recent.length > 0 && (
          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <div style={{ ...label, padding: "0.8rem 1rem 0.4rem" }}>Recent deals</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
              <tbody>{recent.map(d => (
                <tr key={d.id} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                  <td style={{ background: "transparent", borderBottom: "none", fontSize: "0.82rem", padding: "0.55rem 1rem", color: COLORS.textMuted, whiteSpace: "nowrap" }}>{new Date(d.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td style={{ background: "transparent", borderBottom: "none", fontSize: "0.82rem", padding: "0.55rem 1rem", color: COLORS.text, fontFamily: "ui-monospace, monospace" }}>{d.firstInputs.join(", ")}{d.apiCount > d.firstInputs.length ? ` + ${d.apiCount - d.firstInputs.length} more` : ""}</td>
                  <td style={{ background: "transparent", borderBottom: "none", fontSize: "0.82rem", padding: "0.55rem 1rem", color: d.status === "failed" ? COLORS.red : d.status === "evidence_ready" ? COLORS.green : COLORS.accent, whiteSpace: "nowrap" }}>{d.status === "evidence_ready" ? "Complete" : d.status === "failed" ? "Needs attention" : "In progress"}</td>
                  <td style={{ background: "transparent", borderBottom: "none", fontSize: "0.82rem", padding: "0.55rem 1rem", textAlign: "right" }}><button onClick={() => openDeal(d.id)} style={{ ...quiet, padding: "0.3rem 0.7rem", color: COLORS.accent }}>Open</button></td>
                </tr>))}</tbody>
            </table>
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

        {summary && <EngineDecision data={summary} fetcher={apiFetch} onError={setError} />}

        {packageId && (
          <>
            {members.length > 0 && !summary && (
              <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                  <tbody>{members.map((m, i) => (
                    <tr key={i} style={{ borderTop: i ? `1px solid ${COLORS.border}` : "none" }}>
                      <td style={{ background: "transparent", borderBottom: "none", fontSize: "0.82rem", padding: "0.55rem 1rem", color: COLORS.text, fontFamily: "ui-monospace, monospace" }}>{m.input}</td>
                      <td style={{ background: "transparent", borderBottom: "none", fontSize: "0.82rem", padding: "0.55rem 1rem", color: m.status === "complete" ? COLORS.green : ["failed", "cancelled", "create_failed"].includes(m.status) ? COLORS.red : COLORS.accent }}>
                        {m.status === "complete" ? "Records retrieved" : m.status === "create_failed" ? "Not started" : TERMINAL.includes(m.status) ? "Retrieval failed" : `Retrieving · ${m.progress}%`}
                        {m.error && <div style={{ color: COLORS.textFaint, fontSize: "0.72rem" }}>{m.error}</div>}
                      </td>
                      <td style={{ background: "transparent", borderBottom: "none", fontSize: "0.82rem", padding: "0.55rem 1rem", textAlign: "right" }}>
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
