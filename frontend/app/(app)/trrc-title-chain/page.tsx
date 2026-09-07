"use client";

/**
 * Title Chain Research — API numbers -> wells -> candidate tracts ->
 * documents -> instruments -> ownership branches -> report.
 *
 * Static, dense, evidence-first. Every number and status on this page is
 * read from the persisted job bundle or the persisted analysis; nothing is
 * computed in the browser. The report's table and its JSON download are
 * the same object served by /report.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useApiFetch } from "@/lib/trrc/use-api-fetch";
import { COLORS as C } from "./colors";
import type { CandidateTract, JobWell, WellTractAssociation, InterestScope } from "@/lib/trrc/title/chain-types";
import type { TitleChainReport } from "@/lib/trrc/title/report";
import type { DocumentRow, ReviewItemRow, SearchLogRow, JobRow } from "@/lib/trrc/title/job-store";
import { formattedApi } from "@/lib/trrc/title/job-store";
import { Fraction } from "@/lib/trrc/title/fraction";

interface Bundle {
  job: JobRow;
  wells: JobWell[];
  tracts: CandidateTract[];
  associations: WellTractAssociation[];
  documents: DocumentRow[];
  reviewItems: ReviewItemRow[];
  searchLog: SearchLogRow[];
  latestAnalysis: { id: string; version: number; status: string; generatedAt: string; findingCount: number } | null;
}

const POLL_MS = 3000;
const ACTIVE = new Set(["pending", "resolving_wells", "searching_records", "ingesting", "analyzing"]);

const STATUS_LABEL: Record<string, string> = {
  pending: "Queued", resolving_wells: "Resolving wells", searching_records: "Searching county records", awaiting_tract_confirmation: "Confirm tract(s)",
  awaiting_documents: "Documents", ingesting: "Processing documents", analyzing: "Analyzing", complete: "Analysis complete", failed: "Failed", cancelled: "Cancelled",
};
const SEVERITY_COLOR: Record<string, string> = { critical: C.red, high: C.red, medium: C.yellow, low: C.accent, info: C.textMuted };
const STATUS_COLOR: Record<string, string> = {
  NO_SURFACE_DISCONTINUITIES_DETECTED: C.green, POTENTIAL_GAPS_DETECTED: C.yellow, POTENTIAL_CONFLICTS_DETECTED: C.red, INSUFFICIENT_DATA: C.textMuted,
};

const input: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.surfaceAlt, color: C.text, fontSize: 13, fontFamily: "inherit" };
const label: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: C.textMuted, marginBottom: 6 };
const th: React.CSSProperties = { textAlign: "left", padding: "7px 10px", color: C.textMuted, fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: `1px solid ${C.borderStrong}`, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "7px 10px", color: C.text, fontSize: 12.5, borderBottom: `1px solid ${C.border}`, verticalAlign: "top" };
const btn = (variant: "primary" | "ghost" | "danger" = "primary", disabled = false): React.CSSProperties => ({
  background: variant === "primary" ? C.accent : "transparent", color: variant === "primary" ? "#fff" : variant === "danger" ? C.red : C.text,
  border: variant === "primary" ? "none" : `1px solid ${variant === "danger" ? C.red : C.border}`, borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600,
  cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, fontFamily: "inherit",
});

function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: C.text, margin: 0 }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}
function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return <span style={{ display: "inline-block", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.05em", padding: "2px 7px", borderRadius: 4, background: `${color}22`, color, textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</span>;
}
function Muted({ children }: { children: React.ReactNode }) { return <span style={{ color: C.textMuted }}>{children}</span>; }
function shareText(s: { n: string; d: string } | null): string {
  if (!s) return "not quantified";
  const f = Fraction.fromJson(s);
  return f ? `${f.toString()} (${f.toDecimal(6)})` : "—";
}

function TitleChainPageInner() {
  const apiFetch = useApiFetch();
  const router = useRouter();
  const search = useSearchParams();
  const jobId = search.get("job");

  const [apiText, setApiText] = useState("");
  const [scope, setScope] = useState<InterestScope[]>(["minerals"]);
  const [startDate, setStartDate] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{ validCount: number; invalidCount: number; duplicateCount: number; inputs: Array<{ originalInput: string; ok: boolean; error: string | null; duplicateOf: string | null }> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [report, setReport] = useState<TitleChainReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manualLegal, setManualLegal] = useState("");
  const [manualCounty, setManualCounty] = useState("");
  const [manualWell, setManualWell] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteLabel, setPasteLabel] = useState("");
  const [uploadCategory, setUploadCategory] = useState("deed");
  const [uploadWell, setUploadWell] = useState("");
  const [tab, setTab] = useState<"summary" | "chronology" | "branches" | "findings" | "sources">("summary");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      const res = await apiFetch(`/api/trrc/title-chain/${jobId}`);
      const data = await res.json();
      if (!data.ok) { setError(data.error); return; }
      setBundle(data.data as Bundle);
      if (data.data.latestAnalysis && (!report || report.analysisId !== data.data.latestAnalysis.id)) {
        const r = await apiFetch(`/api/trrc/title-chain/${jobId}/report?format=view`);
        const rd = await r.json();
        if (rd.ok) setReport(rd.data as TitleChainReport);
      }
    } catch { setError("Lost connection while loading the job."); }
  }, [apiFetch, jobId, report]);

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jobId]);
  useEffect(() => {
    if (!bundle || !ACTIVE.has(bundle.job.status)) { if (pollRef.current) clearInterval(pollRef.current); return; }
    pollRef.current = setInterval(() => { void load(); }, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [bundle?.job.status, load, bundle]);

  async function createJob() {
    setCreating(true); setError(null); setCreateResult(null);
    try {
      const res = await apiFetch("/api/trrc/title-chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiNumbers: apiText, interestScope: scope, researchStartDate: startDate || null, asOfDate: asOfDate || null }) });
      const data = await res.json();
      if (!data.ok) { setError(data.error); return; }
      setCreateResult(data.data);
      router.push(`/trrc-title-chain?job=${data.data.jobId}`);
    } catch { setError("Lost connection while creating the job."); }
    finally { setCreating(false); }
  }

  async function post(path: string, body?: unknown, init?: RequestInit) {
    const res = await apiFetch(`/api/trrc/title-chain/${jobId}${path}`, { method: "POST", ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }), ...init });
    return res.json();
  }

  async function confirmTracts(confirm: string[], reject: string[]) {
    setBusy("tracts"); setError(null);
    const d = await post("/tracts", { confirm, reject });
    if (!d.ok) setError(d.error);
    await load(); setBusy(null);
  }
  async function addManualTract() {
    if (!manualLegal.trim()) return;
    setBusy("tracts"); setError(null);
    const d = await post("/tracts", { manual: { legalDescriptionText: manualLegal, county: manualCounty || undefined, wellId: manualWell || null } });
    if (!d.ok) setError(d.error); else { setManualLegal(""); }
    await load(); setBusy(null);
  }
  async function uploadFile(file: File) {
    setBusy("upload"); setError(null);
    const form = new FormData(); form.append("file", file); form.append("documentCategory", uploadCategory); if (uploadWell) form.append("wellId", uploadWell);
    const d = await post("/documents", form);
    if (!d.ok) setError(d.error);
    if (fileRef.current) fileRef.current.value = "";
    await load(); setBusy(null);
  }
  async function pasteDocument() {
    if (!pasteText.trim()) return;
    setBusy("upload"); setError(null);
    const d = await post("/documents", { pastedText: pasteText, label: pasteLabel || null, documentCategory: uploadCategory, wellId: uploadWell || null });
    if (!d.ok) setError(d.error); else { setPasteText(""); setPasteLabel(""); }
    await load(); setBusy(null);
  }
  async function processDocuments() {
    setBusy("ingest"); setError(null);
    try {
      for (let i = 0; i < 40; i++) {
        const d = await post("/ingest", { limit: 3 });
        if (!d.ok) { setError(d.error); break; }
        await load();
        if (d.data.remaining === 0) break;
      }
    } finally { setBusy(null); await load(); }
  }
  async function runAnalysis() {
    setBusy("analyze"); setError(null);
    const d = await post("/analyze");
    if (!d.ok) setError(d.error); else { setReport(d.data.report as TitleChainReport); setTab("summary"); }
    await load(); setBusy(null);
  }
  async function resolveReview(item: ReviewItemRow, action: "resolve" | "dismiss", resolution?: Record<string, unknown>) {
    setBusy(`review-${item.id}`); setError(null);
    const d = await post("/review", { itemId: item.id, action, resolution });
    if (!d.ok) setError(d.error);
    await load(); setBusy(null);
  }
  async function retry() { setBusy("retry"); const d = await post("/retry"); if (!d.ok) setError(d.error); await load(); setBusy(null); }
  async function cancel() { setBusy("cancel"); const d = await post("", { action: "cancel" }); if (!d.ok) setError(d.error); await load(); setBusy(null); }
  async function download(format: "json" | "txt") {
    const res = await apiFetch(`/api/trrc/title-chain/${jobId}/report?format=${format}`);
    if (!res.ok) { setError("Report download failed."); return; }
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `title-chain-${jobId?.slice(0, 8)}.${format}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  const openReview = bundle?.reviewItems.filter(r => r.status === "open") ?? [];
  const pendingDocs = bundle?.documents.filter(d => d.extraction_status === "pending").length ?? 0;
  const confirmedTracts = bundle?.tracts.filter(t => t.matchStatus === "confirmed") ?? [];
  const canAnalyze = !!bundle && !ACTIVE.has(bundle.job.status) && bundle.job.status !== "cancelled";
  const tractLabel = (id: string) => bundle?.tracts.find(t => t.id === id)?.tractLabel ?? id;
  const wellLabel = (id: string) => { const w = bundle?.wells.find(x => x.id === id); return w ? (formattedApi(w) ?? w.originalInput) : id; };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, padding: "1.75rem", fontFamily: "-apple-system, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: "0 0 4px 0" }}>Title Chain Research</h1>
            <p style={{ fontSize: 12.5, color: C.textMuted, margin: 0 }}>API number → well → candidate tract → documents → instruments → ownership by tract and interest. Texas.</p>
          </div>
          {jobId && <button style={btn("ghost")} onClick={() => { router.push("/trrc-title-chain"); setBundle(null); setReport(null); setCreateResult(null); }}>New job</button>}
        </div>

        {error && <div style={{ marginBottom: 12, background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, padding: "8px 12px", color: C.red, fontSize: 12.5 }}>{error}</div>}

        {!jobId && (
          <Card title="1. API numbers">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
              <div>
                <label style={label}>One or more API numbers (spaces, commas, or line breaks)</label>
                <textarea value={apiText} onChange={e => setApiText(e.target.value)} rows={8} placeholder={"42-329-42230\n42-165-02733-00-01\n4216510760"} style={{ ...input, fontFamily: "monospace", resize: "vertical" }} />
              </div>
              <div>
                <label style={label}>Interest scope</label>
                {(["surface", "minerals", "leasehold", "royalty"] as InterestScope[]).map(s => (
                  <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text, marginBottom: 6 }}>
                    <input type="checkbox" checked={scope.includes(s)} onChange={e => setScope(e.target.checked ? [...scope, s] : scope.filter(x => x !== s))} />
                    {s === "leasehold" ? "Leasehold / working interest" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </label>
                ))}
                <div style={{ marginTop: 10 }}><label style={label}>Research start date (optional)</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={input} /></div>
                <div style={{ marginTop: 10 }}><label style={label}>As-of date</label><input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} style={input} /></div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button style={btn("primary", creating || !apiText.trim() || scope.length === 0)} disabled={creating || !apiText.trim() || scope.length === 0} onClick={createJob}>{creating ? "Creating…" : "Resolve wells"}</button>
            </div>
          </Card>
        )}

        {createResult && (createResult.invalidCount > 0 || createResult.duplicateCount > 0) && (
          <Card title="Input results">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Input</th><th style={th}>Result</th></tr></thead>
              <tbody>{createResult.inputs.map((i, k) => <tr key={k}><td style={{ ...td, fontFamily: "monospace" }}>{i.originalInput}</td><td style={td}>{i.ok ? (i.duplicateOf ? <Muted>duplicate of {i.duplicateOf}</Muted> : <span style={{ color: C.green }}>accepted</span>) : <span style={{ color: C.red }}>{i.error}</span>}</td></tr>)}</tbody>
            </table>
          </Card>
        )}

        {jobId && bundle && (
          <>
            <Card title="Job" right={<div style={{ display: "flex", gap: 8 }}>
              {bundle.job.status === "failed" && <button style={btn("ghost", busy === "retry")} onClick={retry}>Retry retrieval</button>}
              {["pending", "resolving_wells", "searching_records"].includes(bundle.job.status) && <button style={btn("danger", busy === "cancel")} onClick={cancel}>Cancel</button>}
            </div>}>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 12.5, alignItems: "center" }}>
                <div><Muted>Status</Muted> <Pill color={bundle.job.status === "failed" ? C.red : bundle.job.status === "complete" ? C.green : ACTIVE.has(bundle.job.status) ? C.accent : C.yellow}>{STATUS_LABEL[bundle.job.status] ?? bundle.job.status}</Pill></div>
                <div><Muted>Stage</Muted> <span style={{ color: C.text }}>{bundle.job.stage_detail ?? "—"}</span></div>
                <div><Muted>Progress</Muted> <span style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{bundle.job.progress_percent}%</span></div>
                <div><Muted>Scope</Muted> <span style={{ color: C.text }}>{bundle.job.interest_scope.join(", ")}</span></div>
                <div><Muted>As of</Muted> <span style={{ color: C.text }}>{bundle.job.as_of_date ?? "—"}</span></div>
                {bundle.job.error_summary && <div style={{ color: C.red }}>{bundle.job.error_summary}</div>}
              </div>
              {bundle.job.limitations_json.length > 0 && (
                <ul style={{ margin: "10px 0 0 0", paddingLeft: 18, color: C.textMuted, fontSize: 12 }}>{bundle.job.limitations_json.map((l, i) => <li key={i}>{l}</li>)}</ul>
              )}
            </Card>

            <Card title="2. Wells">
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Input", "API", "Well", "Operator", "County", "Survey / abstract", "Resolution", "Sources"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>{bundle.wells.map(w => (
                    <tr key={w.id}>
                      <td style={{ ...td, fontFamily: "monospace" }}>{w.originalInput}</td>
                      <td style={{ ...td, fontFamily: "monospace" }}>{formattedApi(w) ?? "—"}</td>
                      <td style={td}>{w.wellName ?? "—"}{w.wellNumber ? ` #${w.wellNumber}` : ""}{w.leaseName && w.leaseName !== w.wellName ? <div><Muted>Lease {w.leaseName}</Muted></div> : null}</td>
                      <td style={td}>{w.operatorName ?? "—"}</td>
                      <td style={td}>{w.countyName ?? "—"}</td>
                      <td style={td}>{[w.surveyName, w.abstractNumber, w.blockNumber ? `Blk ${w.blockNumber}` : null, w.sectionName ? `Sec ${w.sectionName}` : null].filter(Boolean).join(", ") || "—"}</td>
                      <td style={td}><Pill color={w.resolutionStatus === "resolved" ? C.green : w.resolutionStatus === "unresolved" ? C.accent : C.red}>{w.resolutionStatus}</Pill>{(w.validationError || w.resolutionError) && <div style={{ color: C.textMuted, fontSize: 11.5, marginTop: 3 }}>{w.validationError ?? w.resolutionError}</div>}</td>
                      <td style={td}>{w.sourceUrls.length === 0 ? "—" : w.sourceUrls.map((s, i) => s.url ? <a key={i} href={s.url} target="_blank" rel="noreferrer" style={{ color: C.accent, marginRight: 6, fontSize: 11.5 }}>{s.source}</a> : <span key={i} style={{ marginRight: 6, fontSize: 11.5, color: C.textMuted }}>{s.source}</span>)}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            </Card>

            <Card title="3. Candidate tracts" right={<span style={{ fontSize: 12, color: C.textMuted }}>{confirmedTracts.length} confirmed · {bundle.tracts.filter(t => t.matchStatus === "proposed").length} proposed</span>}>
              {bundle.tracts.length === 0 && <p style={{ color: C.textMuted, fontSize: 12.5, margin: 0 }}>{ACTIVE.has(bundle.job.status) ? "Candidate tracts appear once well resolution finishes." : "No candidate tract could be derived from TRRC data. Enter the legal description below or add a deed/plat."}</p>}
              {bundle.tracts.map(t => {
                const assocs = bundle.associations.filter(a => a.canonicalTractId === t.id);
                return (
                  <div key={t.id} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", marginBottom: 8, background: t.matchStatus === "confirmed" ? C.greenDim : t.matchStatus === "rejected" ? C.redDim : C.surfaceAlt }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                      <div>
                        <div style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>{t.tractLabel} <Pill color={t.matchStatus === "confirmed" ? C.green : t.matchStatus === "rejected" ? C.red : C.yellow}>{t.matchStatus}</Pill></div>
                        <div style={{ color: C.textMuted, fontSize: 11.5, marginTop: 3 }}>{t.resolutionMethod.replace(/_/g, " ")} · confidence {t.confidence.toFixed(2)}{t.grossAcres ? ` · ${t.grossAcres} ac` : ""}</div>
                        {t.legalDescription && <div style={{ color: C.textMuted, fontSize: 11.5, marginTop: 3 }}>{t.legalDescription.slice(0, 220)}</div>}
                        {assocs.length > 0 && <div style={{ marginTop: 5, fontSize: 11.5 }}>{assocs.map(a => <span key={a.id} style={{ marginRight: 10, color: C.text }}>{wellLabel(a.wellId)} <Muted>{a.associationType.replace(/_/g, " ")} · {a.confidence.toFixed(2)} · {a.reviewStatus}</Muted></span>)}</div>}
                      </div>
                      {t.matchStatus === "proposed" && <div style={{ display: "flex", gap: 6 }}><button style={btn("primary", busy === "tracts")} onClick={() => confirmTracts([t.id], [])}>Confirm</button><button style={btn("ghost", busy === "tracts")} onClick={() => confirmTracts([], [t.id])}>Reject</button></div>}
                    </div>
                  </div>
                );
              })}
              <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10, display: "grid", gridTemplateColumns: "1fr 160px 200px auto", gap: 8, alignItems: "end" }}>
                <div><label style={label}>Add a legal description</label><input value={manualLegal} onChange={e => setManualLegal(e.target.value)} placeholder="e.g. 160 acres, N/2 of Section 12, Block 35, T-2-S, T&P RR Co. Survey, A-1234, Martin County, Texas" style={input} /></div>
                <div><label style={label}>County</label><input value={manualCounty} onChange={e => setManualCounty(e.target.value)} style={input} /></div>
                <div><label style={label}>Link to well</label><select value={manualWell} onChange={e => setManualWell(e.target.value)} style={input}><option value="">— none —</option>{bundle.wells.filter(w => w.api10).map(w => <option key={w.id} value={w.id}>{formattedApi(w)}</option>)}</select></div>
                <button style={btn("ghost", busy === "tracts" || !manualLegal.trim())} onClick={addManualTract}>Add</button>
              </div>
            </Card>

            <Card title="4. Documents" right={<button style={btn("primary", busy !== null || pendingDocs === 0 || ACTIVE.has(bundle.job.status))} disabled={busy !== null || pendingDocs === 0 || ACTIVE.has(bundle.job.status)} onClick={processDocuments}>{busy === "ingest" ? "Processing…" : `Process ${pendingDocs} document${pendingDocs === 1 ? "" : "s"}`}</button>}>
              <div style={{ overflowX: "auto", marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>{["Document", "Source", "Category", "Pages", "Text", "Extraction", "Retrieved"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {bundle.documents.length === 0 && <tr><td style={td} colSpan={7}><Muted>No documents yet. TRRC images arrive automatically when available; add county instruments below.</Muted></td></tr>}
                    {bundle.documents.map(d => (
                      <tr key={d.id}>
                        <td style={td}><a href={`#doc-${d.id}`} onClick={async e => { e.preventDefault(); const r = await apiFetch(`/api/trrc/title-chain/${jobId}/documents/${d.id}`); const j = await r.json(); if (j.ok && j.data.kind === "file") window.open(j.data.url, "_blank"); else if (j.ok) alert(j.data.text.slice(0, 4000)); }} style={{ color: C.accent }}>{d.file_name ?? d.id.slice(0, 8)}</a><div style={{ fontSize: 10.5, color: C.textFaint, fontFamily: "monospace" }}>{d.content_hash.slice(0, 16)}</div></td>
                        <td style={td}>{d.source.replace(/_/g, " ")}{d.source_url && <a href={d.source_url} target="_blank" rel="noreferrer" style={{ color: C.accent, marginLeft: 6, fontSize: 11 }}>link</a>}</td>
                        <td style={td}>{d.document_category.replace(/_/g, " ")}</td>
                        <td style={td}>{d.page_count ?? "—"}</td>
                        <td style={td}>{d.has_text_layer === null ? "—" : d.has_text_layer ? "text layer" : `OCR ${d.ocr_status}`}</td>
                        <td style={td}><Pill color={d.extraction_status === "done" ? C.green : d.extraction_status === "failed" ? C.red : C.accent}>{d.extraction_status}</Pill>{d.extraction_error && <div style={{ color: C.textMuted, fontSize: 11 }}>{d.extraction_error}</div>}</td>
                        <td style={td}>{d.retrieved_at.slice(0, 10)}</td>
                      </tr>))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <label style={label}>Upload instrument (PDF, image, or text)</label>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <select value={uploadCategory} onChange={e => setUploadCategory(e.target.value)} style={{ ...input, width: 170 }}>{["deed", "lease", "unit_agreement", "w1_application", "location_plat", "completion_report", "other"].map(c => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select>
                    <select value={uploadWell} onChange={e => setUploadWell(e.target.value)} style={{ ...input, width: 190 }}><option value="">well: any</option>{bundle.wells.filter(w => w.api10).map(w => <option key={w.id} value={w.id}>{formattedApi(w)}</option>)}</select>
                  </div>
                  <input ref={fileRef} type="file" accept="application/pdf,image/*,text/plain" disabled={busy !== null} onChange={e => { const f = e.target.files?.[0]; if (f) void uploadFile(f); }} style={{ color: C.textMuted, fontSize: 12 }} />
                </div>
                <div>
                  <label style={label}>Or paste record text</label>
                  <input value={pasteLabel} onChange={e => setPasteLabel(e.target.value)} placeholder="Label (e.g. Warranty Deed Vol 512 Pg 88)" style={{ ...input, marginBottom: 6 }} />
                  <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={4} placeholder="Paste the instrument text…" style={{ ...input, resize: "vertical" }} />
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}><button style={btn("ghost", busy !== null || !pasteText.trim())} disabled={busy !== null || !pasteText.trim()} onClick={pasteDocument}>Add pasted text</button></div>
                </div>
              </div>
            </Card>

            <Card title={`5. Review queue (${openReview.length} open)`}>
              {openReview.length === 0 && <p style={{ color: C.textMuted, fontSize: 12.5, margin: 0 }}>Nothing awaiting review.</p>}
              {openReview.map(item => (
                <div key={item.id} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "9px 12px", marginBottom: 6, background: C.surfaceAlt, display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 12.5, color: C.text }}><Pill color={C.purple}>{item.kind.replace(/_/g, " ")}</Pill> <span style={{ marginLeft: 6 }}>{item.title}</span></div>
                    {item.detail && <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 3 }}>{item.detail}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "flex-start" }}>
                    {item.kind === "identity_match" && <><button style={btn("primary", busy !== null)} onClick={() => resolveReview(item, "resolve", { sameParty: true })}>Same person</button><button style={btn("ghost", busy !== null)} onClick={() => resolveReview(item, "resolve", { sameParty: false })}>Different</button></>}
                    {item.kind === "tract_match" && typeof item.payload_json.canonicalTractId === "string" && <><button style={btn("primary", busy !== null)} onClick={() => resolveReview(item, "resolve", { confirmProposed: true })}>Confirm tract</button><button style={btn("ghost", busy !== null)} onClick={() => resolveReview(item, "resolve", { reject: true })}>Reject</button></>}
                    {item.kind === "tract_match" && typeof item.payload_json.canonicalTractId !== "string" && confirmedTracts.length > 0 && <select style={{ ...input, width: 220 }} defaultValue="" onChange={e => { if (e.target.value) void resolveReview(item, "resolve", { canonicalTractId: e.target.value }); }}><option value="">Link to tract…</option>{confirmedTracts.map(t => <option key={t.id} value={t.id}>{t.tractLabel}</option>)}</select>}
                    <button style={btn("ghost", busy !== null)} onClick={() => resolveReview(item, "dismiss")}>Dismiss</button>
                  </div>
                </div>
              ))}
            </Card>

            <Card title="6. Analysis" right={<div style={{ display: "flex", gap: 8 }}>
              {report && <><button style={btn("ghost")} onClick={() => download("json")}>Download JSON</button><button style={btn("ghost")} onClick={() => download("txt")}>Download table</button></>}
              <button style={btn("primary", !canAnalyze || busy !== null)} disabled={!canAnalyze || busy !== null} onClick={runAnalysis}>{busy === "analyze" ? "Analyzing…" : report ? "Re-run analysis" : "Run analysis"}</button>
            </div>}>
              {!report && <p style={{ color: C.textMuted, fontSize: 12.5, margin: 0 }}>Confirm at least one tract and process the documents, then run the analysis. Index-only county entries are shown but never interpreted.</p>}
              {report && (
                <>
                  <div style={{ display: "flex", gap: 6, marginBottom: 12, borderBottom: `1px solid ${C.border}` }}>
                    {(["summary", "chronology", "branches", "findings", "sources"] as const).map(t => <button key={t} onClick={() => setTab(t)} style={{ background: "transparent", border: "none", borderBottom: tab === t ? `2px solid ${C.accent}` : "2px solid transparent", color: tab === t ? C.text : C.textMuted, padding: "6px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", textTransform: "capitalize" }}>{t}{t === "findings" ? ` (${report.findings.length})` : ""}</button>)}
                  </div>

                  {tab === "summary" && (
                    <div style={{ fontSize: 12.5, color: C.text }}>
                      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                        <Pill color={STATUS_COLOR[report.executiveSummary.statusCode] ?? C.textMuted}>{report.executiveSummary.status}</Pill>
                        <Muted>analysis v{report.version} · {report.generatedAt.slice(0, 19).replace("T", " ")} · schema {report.schemaVersion}</Muted>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        <div>
                          <div style={label}>APIs</div><div style={{ fontFamily: "monospace" }}>{report.executiveSummary.apiNumbers.join(", ") || "—"}</div>
                          <div style={{ ...label, marginTop: 10 }}>Tracts (confirmed)</div><div>{report.executiveSummary.tracts.join("; ") || "none confirmed"}</div>
                          <div style={{ ...label, marginTop: 10 }}>Interest scope</div><div>{report.executiveSummary.interestScope.join(", ")}</div>
                          <div style={{ ...label, marginTop: 10 }}>Earliest evidenced holders</div>
                          {report.executiveSummary.earliestEvidencedHolders.length === 0 && <Muted>—</Muted>}
                          {report.executiveSummary.earliestEvidencedHolders.map((h, i) => <div key={i}><Muted>{h.branch}:</Muted> {h.holders.join(", ") || "—"}{h.date ? <Muted> ({h.date})</Muted> : null}</div>)}
                        </div>
                        <div>
                          <div style={label}>Apparent holders in reviewed records</div>
                          {report.executiveSummary.apparentCurrentHolders.length === 0 && <Muted>No branch could be built.</Muted>}
                          {report.executiveSummary.apparentCurrentHolders.map((b, i) => (
                            <div key={i} style={{ marginBottom: 8 }}>
                              <div style={{ color: C.textMuted, fontSize: 11.5 }}>{b.branch}</div>
                              {b.holders.length === 0 && <div><Muted>no holder evidenced</Muted></div>}
                              {b.holders.map((h, k) => <div key={k}>{h.names} — <span style={{ fontVariantNumeric: "tabular-nums" }}>{h.share}</span> <Pill color={h.status === "apparent" ? C.green : C.yellow}>{h.status}</Pill>{h.note && <div style={{ color: C.textFaint, fontSize: 11 }}>{h.note}</div>}</div>)}
                            </div>
                          ))}
                          <div style={{ ...label, marginTop: 10 }}>Coverage limitations</div>
                          {report.executiveSummary.coverageLimitations.length === 0 ? <Muted>none recorded</Muted> : <ul style={{ margin: 0, paddingLeft: 18, color: C.textMuted, fontSize: 12 }}>{report.executiveSummary.coverageLimitations.map((l, i) => <li key={i}>{l}</li>)}</ul>}
                        </div>
                      </div>
                      <div style={{ marginTop: 14, padding: "8px 10px", background: C.surfaceAlt, borderRadius: 6, color: C.textMuted, fontSize: 11.5 }}>
                        <div><b style={{ color: C.text }}>Status rule.</b> {report.executiveSummary.statusRule}</div>
                        <div style={{ marginTop: 6 }}>{report.statement}</div>
                      </div>
                    </div>
                  )}

                  {tab === "chronology" && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead><tr>{["Date (basis)", "Instrument", "Parties", "Recording", "Tract / interest", "Fraction", "Verified", "Notes"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                        <tbody>{report.chronology.length === 0 && <tr><td style={td} colSpan={8}><Muted>No instruments attached to a confirmed tract.</Muted></td></tr>}
                          {report.chronology.map(r => (
                            <tr key={r.rowId}>
                              <td style={{ ...td, whiteSpace: "nowrap" }}>{r.sortDate ?? "undated"} <Muted>({r.dateBasis})</Muted>{r.executionDate && r.dateBasis !== "execution" ? <div style={{ fontSize: 11, color: C.textFaint }}>exec {r.executionDate}</div> : null}{r.recordedDate && r.dateBasis !== "recorded" ? <div style={{ fontSize: 11, color: C.textFaint }}>rec {r.recordedDate}</div> : null}</td>
                              <td style={td}>{r.instrumentType.replace(/_/g, " ")}</td>
                              <td style={td}>{r.parties}</td>
                              <td style={td}>{r.recordingReference ?? "—"}</td>
                              <td style={td}>{r.tractLabel}<div><Muted>{r.interestType.replace(/_/g, " ")} · {r.effect.replace(/_/g, " ")}</Muted></div></td>
                              <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{r.fraction ?? "—"}</td>
                              <td style={td}>{r.contentVerified ? <Pill color={C.green}>reviewed</Pill> : <Pill color={C.yellow}>index only</Pill>}</td>
                              <td style={{ ...td, color: C.textMuted, fontSize: 11.5 }}>{r.notes}{r.citations.filter(c => c.page).slice(0, 2).map((c, i) => <div key={i} style={{ color: C.textFaint }}>p.{c.page}{c.label ? ` · ${c.label}` : ""}</div>)}</td>
                            </tr>))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {tab === "branches" && report.branches.map(b => (
                    <div key={b.branchId} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", marginBottom: 10 }}>
                      <div style={{ color: C.text, fontWeight: 600, fontSize: 13 }}>{b.tractLabel} — {b.interestType.replace(/_/g, " ")}</div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>Earliest evidenced holder(s): <span style={{ color: C.text }}>{b.earliestEvidencedHolders.map(p => p.displayName).join(", ") || "—"}</span>{b.earliestEvidencedDate ? ` (${b.earliestEvidencedDate})` : ""}</div>
                      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
                        <thead><tr>{["Date", "Effect", "From → To", "Stated", "Computed share", "Support"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                        <tbody>{b.events.map(e => (
                          <tr key={e.eventId}>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>{e.sortDate ?? "undated"} <Muted>({e.dateBasis})</Muted></td>
                            <td style={td}>{e.instrumentType.replace(/_/g, " ")}<div><Muted>{e.effect.replace(/_/g, " ")}</Muted></div></td>
                            <td style={td}>{e.from.map(p => p.displayName).join(", ") || "—"} → {e.to.map(p => p.displayName).join(", ") || "—"}</td>
                            <td style={td}>{e.fractionVerbatim ?? (e.statedFraction ? Fraction.fromJson(e.statedFraction)?.toString() : "—")}<div><Muted>{e.fractionBasis.replace(/_/g, " ")}</Muted></div></td>
                            <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{shareText(e.computedShare)}</td>
                            <td style={td}><Pill color={e.support === "supported" || e.support === "root" ? C.green : e.support === "not_evaluated" ? C.textMuted : e.support === "partial" ? C.yellow : C.red}>{e.support.replace(/_/g, " ")}</Pill>{e.notes.length > 0 && <div style={{ color: C.textFaint, fontSize: 11, marginTop: 3 }}>{e.notes.join("; ")}</div>}</td>
                          </tr>))}</tbody>
                      </table>
                      <div style={{ marginTop: 8, fontSize: 12 }}>
                        <div style={label}>Apparent holders</div>
                        {b.apparentHolders.length === 0 && <Muted>none evidenced</Muted>}
                        {b.apparentHolders.map(h => <div key={h.holdingId} style={{ color: C.text }}>{h.parties.map(p => p.displayName).join(" & ")} — <span style={{ fontVariantNumeric: "tabular-nums" }}>{shareText(h.share)}</span> <Pill color={h.status === "apparent" ? C.green : C.yellow}>{h.status.replace(/_/g, " ")}</Pill>{h.shareNote && <span style={{ color: C.textFaint }}> · {h.shareNote}</span>}</div>)}
                        {b.encumbrances.length > 0 && <><div style={{ ...label, marginTop: 8 }}>Encumbrances</div>{b.encumbrances.map(e => <div key={e.instrumentId} style={{ color: C.text }}>{e.instrumentType.replace(/_/g, " ")} {e.recordingReference ?? ""} <Pill color={e.releaseStatus === "release_located" ? C.green : C.yellow}>{e.releaseStatus.replace(/_/g, " ")}</Pill></div>)}</>}
                        {b.unresolvedAllocations.length > 0 && <><div style={{ ...label, marginTop: 8 }}>Unresolved allocations</div>{b.unresolvedAllocations.map((u, i) => <div key={i} style={{ color: C.textMuted }}>{u.description}</div>)}</>}
                      </div>
                    </div>
                  ))}
                  {tab === "branches" && report.branches.length === 0 && <Muted>No branch could be built — confirm a tract and process reviewed instruments.</Muted>}

                  {tab === "findings" && (
                    <div>
                      {report.findings.length === 0 && <Muted>No findings.</Muted>}
                      {report.findings.map(f => (
                        <div key={f.findingId} style={{ borderLeft: `3px solid ${SEVERITY_COLOR[f.severity]}`, background: C.surfaceAlt, borderRadius: 4, padding: "8px 12px", marginBottom: 6 }}>
                          <div style={{ fontSize: 12.5, color: C.text, fontWeight: 600 }}><Pill color={SEVERITY_COLOR[f.severity]}>{f.severity}</Pill> <span style={{ marginLeft: 6 }}>{f.title}</span> <Muted>· {f.type.replace(/_/g, " ").toLowerCase()}</Muted></div>
                          <div style={{ fontSize: 12, color: C.text, marginTop: 4 }}>{f.explanation}</div>
                          <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 4 }}>{f.affectedTractLabel ? `${f.affectedTractLabel}` : ""}{f.affectedInterestType ? ` · ${f.affectedInterestType.replace(/_/g, " ")}` : ""}{f.citations.length > 0 ? ` · cites ${f.citations.map(c => c.label ?? (c.page ? `p.${c.page}` : c.instrumentId?.slice(0, 8) ?? "document")).join(", ")}` : ""}</div>
                          <div style={{ fontSize: 11.5, color: C.accent, marginTop: 4 }}>Next: {f.nextAction}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {tab === "sources" && (
                    <div style={{ overflowX: "auto" }}>
                      <div style={label}>Source inventory</div>
                      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14 }}>
                        <thead><tr>{["Document", "Source", "Category", "Hash", "Retrieved", "Text", "Instruments"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                        <tbody>{report.sourceInventory.map(s => <tr key={s.documentId}><td style={td}>{s.fileName ?? s.documentId.slice(0, 8)}</td><td style={td}>{s.source.replace(/_/g, " ")}{s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noreferrer" style={{ color: C.accent, marginLeft: 6, fontSize: 11 }}>link</a>}</td><td style={td}>{s.documentCategory.replace(/_/g, " ")}</td><td style={{ ...td, fontFamily: "monospace", fontSize: 10.5 }}>{s.contentHash.slice(0, 16)}</td><td style={td}>{s.retrievedAt.slice(0, 10)}</td><td style={td}>{s.hasTextLayer === null ? "—" : s.hasTextLayer ? "text layer" : `OCR ${s.ocrStatus}`} · {s.extractionStatus}</td><td style={td}>{s.instrumentIds.length}</td></tr>)}</tbody>
                      </table>
                      <div style={label}>Search coverage</div>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead><tr>{["Provider", "County", "Query", "Value", "Status", "Results", "When"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                        <tbody>{report.searchCoverage.length === 0 && <tr><td style={td} colSpan={7}><Muted>No searches logged.</Muted></td></tr>}
                          {report.searchCoverage.map((s, i) => <tr key={i}><td style={td}>{s.provider}</td><td style={td}>{s.county ?? "—"}</td><td style={td}>{s.queryType.replace(/_/g, " ")}</td><td style={{ ...td, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{s.sourceUrl ? <a href={s.sourceUrl} target="_blank" rel="noreferrer" style={{ color: C.accent }}>{s.queryValue}</a> : s.queryValue}</td><td style={td}><Pill color={s.status === "success" ? C.green : s.status === "provider_unavailable" || s.status === "failed" ? C.red : C.textMuted}>{s.status.replace(/_/g, " ")}</Pill>{s.errorMessage && <div style={{ color: C.textFaint, fontSize: 11 }}>{s.errorMessage}</div>}</td><td style={td}>{s.resultCount}</td><td style={td}>{s.searchedAt.slice(0, 10)}</td></tr>)}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </Card>
          </>
        )}
        {jobId && !bundle && !error && <p style={{ color: C.textMuted, fontSize: 12.5 }}>Loading job…</p>}
      </div>
    </div>
  );
}

export default function TitleChainPage() {
  // useSearchParams requires a Suspense boundary for static prerendering in the App Router.
  return <Suspense fallback={null}><TitleChainPageInner /></Suspense>;
}
