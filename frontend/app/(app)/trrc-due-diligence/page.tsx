"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  TrrcDueDiligenceRun,
  TrrcIdentifierType,
  ResolvedEntity,
  AcquisitionScorecard,
  ScoreDimension,
  TrrcDDProductionRow,
  SourceCoverageStatus,
  TrrcGeologyDashboardSummary,
} from "../../../lib/trrc/types";
import { buildEvidenceIndex } from "@/lib/trrc/evidence-index";
import { useApiFetch } from "@/lib/trrc/use-api-fetch";
import { COLORS } from "./colors";
// detectInputType unused — each field has an explicit type now

// ─── District options ──────────────────────────────────────────────────────────

const DISTRICTS = ["01","02","03","04","05","06","07B","07C","08","09","10","C1","C2","C3"];

const TYPE_LABEL: Record<TrrcIdentifierType, string> = {
  api_number:        "API Number",
  rrc_lease_number:  "Lease Number",
  gas_well_id:       "Gas Well ID",
  operator_name:     "Operator Name",
  p5_number:         "P-5 Number",
  legal_description: "Legal Description",
  lease_name:        "Lease Name",
  unknown:           "Unknown",
};

// ─── Small helpers ─────────────────────────────────────────────────────────────

function Pill({ children, bg, color }: { children: React.ReactNode; bg: string; color: string }) {
  return (
    <span style={{
      display: "inline-block",
      fontSize: "0.65rem",
      fontWeight: 700,
      letterSpacing: "0.06em",
      padding: "0.15rem 0.5rem",
      borderRadius: 4,
      background: bg,
      color,
      textTransform: "uppercase" as const,
      whiteSpace: "nowrap" as const,
    }}>
      {children}
    </span>
  );
}

function SectionCard({ title, children, icon }: { title: string; children: React.ReactNode; icon?: string }) {
  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      padding: "1.25rem 1.5rem",
      marginBottom: "1rem",
    }}>
      <h3 style={{
        margin: "0 0 1rem 0",
        fontSize: "0.8rem",
        fontWeight: 700,
        color: COLORS.textMuted,
        textTransform: "uppercase" as const,
        letterSpacing: "0.1em",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        {icon && <span>{icon}</span>}
        {title}
      </h3>
      {children}
    </div>
  );
}

function DdTable({ headers, rows }: { headers: string[]; rows: (React.ReactNode | string | null)[][] }) {
  if (rows.length === 0) {
    return <p style={{ color: COLORS.textFaint, fontSize: "0.8rem", margin: "0.5rem 0" }}>No data available.</p>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={{
                textAlign: "left",
                padding: "0.4rem 0.75rem",
                color: COLORS.textMuted,
                fontWeight: 600,
                fontSize: "0.72rem",
                letterSpacing: "0.05em",
                borderBottom: `1px solid ${COLORS.border}`,
                whiteSpace: "nowrap" as const,
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ padding: "0.5rem 0.75rem", color: COLORS.text, verticalAlign: "top" }}>
                  {cell ?? <span style={{ color: COLORS.textFaint }}>—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Form state type ───────────────────────────────────────────────────────────

type FormState = {
  apiNumber: string;
  leaseNumber: string;
  operatorName: string;
  // Alternate primary search modes — the backend (entity-resolver.ts) has
  // always been able to resolve both, but neither had an input surface
  // until now. Both route through the existing needs_user_selection ->
  // "selecting" phase (same UI already used for ambiguous API/operator
  // matches) since neither can pinpoint a single well with high
  // confidence on its own — that's correct behavior, not a gap.
  legalDescription: string;
  leaseName: string;
  county: string;
  district: string;
  searchHistorical: boolean;
  includeOffsetWells: boolean;
  productionMonths: number;
  // Optional proposed deal price, as typed text (kept as a string so the
  // field can be empty — Number("") is 0, which would silently become a
  // fake $0 purchase price rather than "not provided"). Parsed and
  // validated on submit.
  purchasePrice: string;
};

type Phase = "form" | "running" | "selecting" | "complete" | "error";
type TabKey = "summary" | "scorecard" | "production" | "economics" | "findings" | "coverage" | "missing" | "geology";

const DOWNLOAD_PATHS = {
  report:              (id: string) => `/api/trrc/due-diligence/${id}/report`,
  archive:             (id: string) => `/api/trrc/due-diligence/${id}/archive`,
  manifest:            (id: string) => `/api/trrc/due-diligence/${id}/manifest`,
  "export-production": (id: string) => `/api/trrc/due-diligence/${id}/export?type=production`,
  "export-coverage":   (id: string) => `/api/trrc/due-diligence/${id}/export?type=coverage`,
  "export-evidence":   (id: string) => `/api/trrc/due-diligence/${id}/export?type=evidence`,
  "export-timeline":   (id: string) => `/api/trrc/due-diligence/${id}/export?type=timeline`,
  "export-offset":     (id: string) => `/api/trrc/due-diligence/${id}/export?type=offset`,
  "export-lateral":    (id: string) => `/api/trrc/due-diligence/${id}/export?type=lateral`,
  "export-county":     (id: string) => `/api/trrc/due-diligence/${id}/export?type=county`,
  "export-xlsx":       (id: string) => `/api/trrc/due-diligence/${id}/export?type=xlsx`,
} as const;

// ─── Main page component ───────────────────────────────────────────────────────

export default function TrrcDueDiligencePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [phase, setPhase]           = useState<Phase>("form");
  const [runId, setRunId]           = useState<string | null>(null);
  const [run, setRun]               = useState<TrrcDueDiligenceRun | null>(null);
  const [activeTab, setActiveTab]   = useState<TabKey>("summary");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  // Separate from `error` (the fatal run-failure banner, which only shows
  // in phase "error" and offers "Start Over"). A failed download while
  // viewing a perfectly good completed report — e.g. no county records for
  // this well's county — must not look like the whole run failed, and must
  // not offer to discard the results. Confirmed live: before this, every
  // failed download (any export type, on any run) set `error` with nothing
  // rendering it, so the download button just silently did nothing.
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Shared with the portfolio/bulk page — see use-api-fetch.ts for what
  // each piece of this fixes and why (ByteString cookie errors, stale
  // cached GETs, 401-expiry mid-session, etc.). Extracted so the two pages
  // can't drift out of sync on any of those fixes.
  const apiFetch = useApiFetch();

  // Resume a run from the URL on load — confirmed live: with runId only
  // ever held in React state, ANY reload (a stale/backgrounded tab that
  // needed a refresh, exiting Safari Reader View, a closed and reopened
  // tab, a shared link) dropped the user straight back to the blank form
  // with no path back to a run that had already completed successfully
  // server-side. The report was never lost — the browser just had no
  // address for it. `run=<id>` in the URL is that address; a reload
  // re-fetches the real current state instead of assuming "form".
  const resumeRun = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/trrc/due-diligence/${id}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        // Run doesn't exist or isn't this user's — drop the stale
        // reference rather than getting stuck retrying it forever.
        router.replace("/trrc-due-diligence");
        return;
      }
      setRunId(id);
      setRun(data.data);
      if (data.data.status === "complete") {
        setPhase("complete");
      } else if (data.data.status === "awaiting_selection") {
        setPhase("selecting");
      } else if (data.data.status === "failed" || data.data.status === "cancelled") {
        setError(data.data.error_summary ?? "The run failed or was cancelled.");
        setPhase("error");
      } else {
        // pending/running/resolving/retrieving/analyzing/generating — the
        // existing poll effect (keyed on runId + phase==="running") takes
        // over from here and keeps refreshing until a terminal state.
        setPhase("running");
      }
    } catch {
      router.replace("/trrc-due-diligence");
    }
  }, [apiFetch, router]);

  useEffect(() => {
    const runParam = searchParams.get("run");
    if (runParam) resumeRun(runParam);
    // Mount-only: resuming is a one-time reconciliation against whatever
    // the URL says right now, not something that should re-fire on every
    // searchParams identity change (e.g. the replace() calls below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [form, setForm] = useState<FormState>({
    apiNumber: "",
    leaseNumber: "",
    operatorName: "",
    legalDescription: "",
    leaseName: "",
    county: "",
    district: "",
    searchHistorical: true,
    includeOffsetWells: false,
    productionMonths: 36,
    purchasePrice: "",
  });

  // Polling
  const terminalReachedRef = useRef(false);
  // A poll that returns HTTP-ok-but-{ok:false} (401 from an expired/invalid
  // token that apiFetch's own refresh-and-retry couldn't recover, a 404 from
  // a race with the run being deleted, etc.) previously did NOTHING — no
  // error, no retry escalation, no state change. The interval kept firing
  // forever, every 3s, silently no-op'ing, while the run kept progressing
  // server-side — exactly what "frozen at 2%, no error, nothing in the
  // console" looks like from the user's side. Track consecutive failures and
  // surface a real error after a few in a row, instead of polling into the
  // void forever.
  const consecutiveFailuresRef = useRef(0);
  const MAX_CONSECUTIVE_POLL_FAILURES = 4; // ~12s at the 3s interval
  useEffect(() => {
    if (!runId || phase !== "running") return;
    terminalReachedRef.current = false;
    consecutiveFailuresRef.current = 0;

    const doPoll = async () => {
      try {
        const res = await apiFetch(`/api/trrc/due-diligence/${runId}`);
        const data = await res.json();
        // clearInterval() only stops FUTURE ticks — it doesn't cancel a fetch
        // that's already in flight. With a 3s interval, two polls can be
        // outstanding at once, and a slower "still running" response can
        // resolve AFTER a faster "complete" response, silently reverting the
        // UI back to a stale in-progress state right after it finished. Once
        // any poll has reached a terminal state, ignore every later response.
        if (terminalReachedRef.current) return;
        if (data.ok) {
          consecutiveFailuresRef.current = 0;
          if (data.data.status === "complete") {
            terminalReachedRef.current = true;
            setRun({ ...data.data, progress_percent: 100 });
            setPhase("complete");
            clearInterval(interval);
          } else if (data.data.status === "awaiting_selection") {
            terminalReachedRef.current = true;
            setRun(data.data);
            setPhase("selecting");
            clearInterval(interval);
          } else if (data.data.status === "failed" || data.data.status === "cancelled") {
            terminalReachedRef.current = true;
            setError(data.data.error_summary ?? "The run failed or was cancelled.");
            setPhase("error");
            clearInterval(interval);
          } else {
            // Non-terminal status (pending/running/resolving/etc.) — the worker
            // updates progress_percent continuously; without this branch `run`
            // stayed frozen at its initial 0%/pending value for the entire
            // duration of a run, making a working run look permanently stuck.
            setRun(data.data);
          }
        } else {
          consecutiveFailuresRef.current += 1;
          if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
            terminalReachedRef.current = true;
            setError(
              `Lost contact with the server while checking progress (${res.status}: ${data.error ?? "unknown error"}). ` +
              `The run itself may still be in progress — reload the page to check its current status.`,
            );
            setPhase("error");
            clearInterval(interval);
          }
        }
      } catch {
        // Network-level failure (fetch threw) — same escalation as an
        // {ok:false} response, so a total connectivity loss doesn't spin
        // forever either.
        if (terminalReachedRef.current) return;
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          terminalReachedRef.current = true;
          setError("Lost network connection while checking progress. The run itself may still be in progress — reload the page to check its current status.");
          setPhase("error");
          clearInterval(interval);
        }
      }
    };

    const interval = setInterval(doPoll, 3000);

    // Real, live-observed incident (2026-08-18): a run completed server-side
    // in under 3 minutes, but a tab left backgrounded (switched away, e.g.
    // to pull up the deck or take a call — exactly what happens in a live
    // meeting) never displayed it, showing 2% until manually refreshed. The
    // interval above is unaffected server-side, but browsers throttle or
    // fully suspend setInterval in a hidden/inactive tab, so its next tick
    // can be delayed indefinitely rather than merely late. Firing an
    // immediate poll the moment the tab becomes visible or regains focus —
    // on top of, not instead of, the interval — means switching back to
    // this tab mid-demo re-syncs instantly instead of waiting on a timer
    // the browser itself may not be honoring.
    const onWake = () => { if (document.visibilityState === "visible") void doPoll(); };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [runId, phase, apiFetch]);

  const handleSubmit = useCallback(async () => {
    setError(null);
    try {
      const api = form.apiNumber.trim();
      const lease = form.leaseNumber.trim();
      const operator = form.operatorName.trim();
      const legalDescription = form.legalDescription.trim();
      const leaseName = form.leaseName.trim();

      let primaryInput: string;
      let inputTypeOverride: TrrcIdentifierType | undefined;

      // Most-specific-wins, same principle as before — a real API number or
      // lease/gas-well ID beats a legal description (which the backend
      // itself only resolves to a text-match candidate, always requiring
      // user confirmation), which in turn beats a bare lease name (weaker
      // still — see entity-resolver.ts's resolveLeaseName confidence
      // scale), which beats an operator name (broadest, matches many wells).
      if (api) {
        primaryInput = api;
        inputTypeOverride = "api_number";
      } else if (lease) {
        primaryInput = lease;
        inputTypeOverride = "rrc_lease_number";
      } else if (legalDescription) {
        primaryInput = legalDescription;
        inputTypeOverride = "legal_description";
      } else if (leaseName) {
        primaryInput = leaseName;
        inputTypeOverride = "lease_name";
      } else {
        primaryInput = operator;
        inputTypeOverride = "operator_name";
      }

      const trimmedPrice = form.purchasePrice.trim();
      const purchasePrice = trimmedPrice ? Number(trimmedPrice) : undefined;
      if (purchasePrice !== undefined && (!Number.isFinite(purchasePrice) || purchasePrice <= 0)) {
        throw new Error("Purchase price must be a positive number.");
      }

      const payload = {
        input: primaryInput,
        input_type_override: inputTypeOverride,
        // lease_number intentionally stays keyed off the numeric Lease/Gas
        // Well ID field only — this is stored as resolved_lease_number and
        // used downstream by the worker as a literal TRRC lease number for
        // lease-keyed queries (severance, oil proration, production, W-2).
        // A lease NAME must never land here; it has its own field below.
        lease_number: lease || undefined,
        lease_name: leaseName || undefined,
        operator_name: operator || undefined,
        county: form.county.trim() || undefined,
        district: form.district || undefined,
        search_historical: form.searchHistorical,
        include_offset_wells: form.includeOffsetWells,
        production_months: form.productionMonths,
        purchase_price: purchasePrice,
      };

      const res = await apiFetch("/api/trrc/due-diligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Failed to start run");
      const id: string = data.data.id;
      setRunId(id);
      setRun(data.data);
      router.replace(`/trrc-due-diligence?run=${id}`, { scroll: false });
      if (data.data.needs_user_selection) {
        setPhase("selecting");
      } else {
        setPhase("running");
        const execRes = await apiFetch(`/api/trrc/due-diligence/${id}/execute`, { method: "POST" });
        // /execute is just a "start now instead of waiting for the next poll
        // cycle" nudge — the DigitalOcean worker's own background poller
        // claims any pending run within 5s regardless of whether this call
        // ever succeeds. A 409 here means the worker already claimed the
        // row before this request landed (confirmed live: real timing race
        // between this call and the worker's poll loop against the same
        // run), not that anything failed — the run is already proceeding.
        // Only a genuine error (network failure, 401/404/500) should abort
        // into the error screen.
        if (execRes.status !== 409) {
          const execData = await execRes.json();
          if (!execRes.ok || !execData.ok) {
            throw new Error(execData.error ?? "Failed to start execution");
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("error");
    }
  }, [form, apiFetch, router]);

  const handleCancel = useCallback(async () => {
    if (runId) {
      await apiFetch(`/api/trrc/due-diligence/${runId}/cancel`, { method: "POST" }).catch(() => {});
    }
    setRunId(null);
    setRun(null);
    setPhase("form");
    setError(null);
    router.replace("/trrc-due-diligence", { scroll: false });
  }, [runId, apiFetch, router]);

  const handleResolve = useCallback(async (entityId: string) => {
    if (!runId) return;
    try {
      const resolveRes = await apiFetch(`/api/trrc/due-diligence/${runId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId }),
      });
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok || !resolveData.ok) {
        throw new Error(resolveData.error ?? "Failed to resolve entity selection");
      }
      setPhase("running");
      const execRes = await apiFetch(`/api/trrc/due-diligence/${runId}/execute`, { method: "POST" });
      // See handleSubmit — a 409 here just means the worker's own poller
      // already claimed the run, which is not a failure.
      if (execRes.status !== 409) {
        const execData = await execRes.json();
        if (!execRes.ok || !execData.ok) {
          throw new Error(execData.error ?? "Failed to start execution after resolve");
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to resolve entity selection.");
      setPhase("error");
    }
  }, [runId, apiFetch]);

  const handleReset = useCallback(() => {
    setPhase("form");
    setRunId(null);
    setRun(null);
    setError(null);
    setDownloadError(null);
    setActiveTab("summary");
    router.replace("/trrc-due-diligence", { scroll: false });
  }, [router]);

  const handleDownload = useCallback(async (type: keyof typeof DOWNLOAD_PATHS) => {
    if (!runId) return;
    setDownloadError(null);
    const res = await apiFetch(DOWNLOAD_PATHS[type](runId));
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Download failed" }));
      setDownloadError((err as { error?: string }).error ?? "Download failed");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    a.download = match?.[1] ?? `trrc-${type}-${runId}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [runId, apiFetch]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      minHeight: "100vh",
      background: COLORS.bg,
      color: COLORS.text,
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "2rem 1.5rem" }}>

        {/* Header */}
        <div style={{ marginBottom: "2rem" }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: "0.35rem",
          }}>
            <span style={{
              fontSize: "0.68rem",
              fontWeight: 700,
              letterSpacing: "0.12em",
              color: COLORS.accent,
              textTransform: "uppercase" as const,
              background: COLORS.accentDim,
              padding: "0.2rem 0.6rem",
              borderRadius: 4,
            }}>
              TRRC PUBLIC RECORDS
            </span>
          </div>
          <h1 style={{
            margin: "0 0 0.5rem 0",
            fontSize: "1.75rem",
            fontWeight: 700,
            color: COLORS.text,
            letterSpacing: "-0.02em",
          }}>
            Due Diligence
          </h1>
          <p style={{ margin: 0, fontSize: "0.9rem", color: COLORS.textMuted }}>
            Query every available Texas Railroad Commission public record for any well, lease, or operator.
          </p>
          {phase === "form" && (
            <Link href="/trrc-due-diligence/portfolio" style={{ fontSize: "0.8rem", color: COLORS.accent, textDecoration: "none", display: "inline-block", marginTop: "0.5rem" }}>
              Have a list of wells? Run them as a portfolio →
            </Link>
          )}
        </div>

        {/* Start Over — always visible when not on form */}
        {phase !== "form" && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
            <button onClick={handleCancel} style={{
              background: "transparent",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              color: COLORS.textMuted,
              fontSize: "0.78rem",
              padding: "0.35rem 0.85rem",
              cursor: "pointer",
            }}>
              ← Start Over
            </button>
          </div>
        )}

        {/* Error banner */}
        {phase === "error" && error && (
          <div style={{
            background: COLORS.redDim,
            border: `1px solid ${COLORS.red}40`,
            borderRadius: 8,
            padding: "0.85rem 1.1rem",
            marginBottom: "1.25rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}>
            <span style={{ fontSize: "0.85rem", color: COLORS.red }}>⚠ {error}</span>
            <button onClick={handleReset} style={{
              background: "transparent",
              border: `1px solid ${COLORS.red}60`,
              borderRadius: 5,
              color: COLORS.red,
              fontSize: "0.75rem",
              padding: "0.3rem 0.75rem",
              cursor: "pointer",
            }}>
              Start Over
            </button>
          </div>
        )}

        {/* ── FORM PHASE ──────────────────────────────────────────────────── */}
        {(phase === "form" || phase === "error") && (
          <SearchForm
            form={form}
            setForm={setForm}
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            onSubmit={handleSubmit}
          />
        )}

        {/* ── RUNNING PHASE ───────────────────────────────────────────────── */}
        {phase === "running" && run && (
          <ProgressUI run={run} onCancel={handleCancel} />
        )}

        {/* ── SELECTING PHASE ─────────────────────────────────────────────── */}
        {phase === "selecting" && run && (
          <EntitySelectionUI run={run} onSelect={handleResolve} />
        )}

        {/* ── COMPLETE PHASE ──────────────────────────────────────────────── */}
        {phase === "complete" && run && (
          <ResultsDashboard
            run={run}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onReset={handleReset}
            onDownload={handleDownload}
            downloadError={downloadError}
            onDismissDownloadError={() => setDownloadError(null)}
            apiFetch={apiFetch}
          />
        )}
        {/* unused tab state kept to avoid breaking form-phase logic */}
      </div>
    </div>
  );
}

// ─── Search Form ───────────────────────────────────────────────────────────────

function SearchForm({
  form, setForm, showAdvanced, setShowAdvanced, onSubmit,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  showAdvanced: boolean;
  setShowAdvanced: React.Dispatch<React.SetStateAction<boolean>>;
  onSubmit: () => void;
}) {
  const canSubmit = !!(form.apiNumber.trim() || form.leaseNumber.trim() || form.operatorName.trim() || form.legalDescription.trim() || form.leaseName.trim());
  const [loading, setLoading] = useState(false);

  const handleRun = async () => {
    setLoading(true);
    await onSubmit();
    setLoading(false);
  };

  const inp = (overrides: React.CSSProperties = {}): React.CSSProperties => ({
    background: COLORS.surfaceAlt,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 7,
    color: COLORS.text,
    fontSize: "0.9rem",
    padding: "0.6rem 0.9rem",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
    fontFamily: "inherit",
    ...overrides,
  });

  const fieldLabel = (text: string, hint?: string) => (
    <div style={{ marginBottom: "0.45rem" }}>
      <span style={{
        fontSize: "0.72rem",
        fontWeight: 600,
        color: COLORS.textMuted,
        letterSpacing: "0.06em",
        textTransform: "uppercase" as const,
      }}>{text}</span>
      {hint && <span style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginLeft: 6 }}>{hint}</span>}
    </div>
  );

  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 12,
      padding: "1.75rem",
    }}>

      {/* Three search fields */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", marginBottom: "1.25rem" }}>

        {/* API Number */}
        <div>
          {fieldLabel("API Number", "e.g. 42-151-01734")}
          <input
            type="text"
            value={form.apiNumber}
            onChange={e => setForm(f => ({ ...f, apiNumber: e.target.value }))}
            placeholder="42-XXX-XXXXX"
            style={inp()}
            onKeyDown={e => { if (e.key === "Enter" && canSubmit) handleRun(); }}
          />
        </div>

        {/* Lease Number */}
        <div>
          {fieldLabel("Lease / Gas Well ID", "e.g. 12345")}
          <input
            type="text"
            value={form.leaseNumber}
            onChange={e => setForm(f => ({ ...f, leaseNumber: e.target.value }))}
            placeholder="Lease # or Gas Well ID"
            style={inp()}
            onKeyDown={e => { if (e.key === "Enter" && canSubmit) handleRun(); }}
          />
        </div>

        {/* Operator Name */}
        <div>
          {fieldLabel("Operator Name", "e.g. Pioneer Natural")}
          <input
            type="text"
            value={form.operatorName}
            onChange={e => setForm(f => ({ ...f, operatorName: e.target.value }))}
            placeholder="Operator or P-5 name"
            style={inp()}
            onKeyDown={e => { if (e.key === "Enter" && canSubmit) handleRun(); }}
          />
        </div>
      </div>

      {/* Legal description — an alternate primary search mode, used only
          when none of the three fields above are filled in. Full width and
          a textarea since these run longer than a single line ("John Smith
          Survey, Abstract 693, McLennan County, Texas"). */}
      <div style={{ marginBottom: "1.25rem" }}>
        {fieldLabel("Legal Description", "no API, lease, or operator? search by survey/abstract/county instead")}
        <textarea
          value={form.legalDescription}
          onChange={e => setForm(f => ({ ...f, legalDescription: e.target.value }))}
          placeholder="e.g. John Smith Survey, Abstract 693, McLennan County, Texas"
          rows={2}
          style={inp({ resize: "vertical", fontFamily: "inherit" })}
        />
        <p style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginTop: "0.35rem" }}>
          A legal description alone can't pinpoint one exact well — you'll be asked to confirm the right match before the search runs.
        </p>
      </div>

      {/* Advanced options toggle */}
      <button
        onClick={() => setShowAdvanced(s => !s)}
        style={{
          background: "transparent",
          border: "none",
          color: COLORS.textMuted,
          fontSize: "0.78rem",
          cursor: "pointer",
          padding: 0,
          display: "flex",
          alignItems: "center",
          gap: 5,
          marginBottom: showAdvanced ? "1rem" : "1.25rem",
        }}
      >
        <span style={{
          display: "inline-block",
          transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 0.15s",
          fontSize: "0.65rem",
        }}>▶</span>
        Advanced Options
      </button>

      {/* Advanced options panel */}
      {showAdvanced && (
        <div style={{
          background: COLORS.surfaceAlt,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          padding: "1.1rem 1.25rem",
          marginBottom: "1.25rem",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "0.9rem",
          }}>
            {/* Lease name — a weaker fallback search mode (used only when
                API, lease number, legal description, AND operator are all
                empty), so it lives here rather than in the primary row.
                Deliberately separate from "Lease / Gas Well ID" above:
                that field's value is stored as the literal TRRC lease
                number used by downstream lease-keyed queries, and a free-
                text name must never land there. */}
            <div>
              <label style={{ display: "block", fontSize: "0.72rem", fontWeight: 600, color: COLORS.textMuted, marginBottom: "0.35rem", letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                Lease Name
              </label>
              <input
                type="text"
                value={form.leaseName}
                onChange={e => setForm(f => ({ ...f, leaseName: e.target.value }))}
                placeholder="e.g. Smith Unit 3"
                style={inp()}
              />
              <p style={{ fontSize: "0.7rem", color: COLORS.textMuted, marginTop: "0.3rem" }}>
                Fallback search if you don't know the lease number. Ignored if any field above is filled.
              </p>
            </div>

            {/* County */}
            <div>
              <label style={{ display: "block", fontSize: "0.72rem", fontWeight: 600, color: COLORS.textMuted, marginBottom: "0.35rem", letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                County
              </label>
              <input
                type="text"
                value={form.county}
                onChange={e => setForm(f => ({ ...f, county: e.target.value }))}
                placeholder="e.g. Midland"
                style={inp()}
              />
            </div>

            {/* TRRC District */}
            <div>
              <label style={{ display: "block", fontSize: "0.72rem", fontWeight: 600, color: COLORS.textMuted, marginBottom: "0.35rem", letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                TRRC District
              </label>
              <select
                value={form.district}
                onChange={e => setForm(f => ({ ...f, district: e.target.value }))}
                style={inp({ appearance: "none" } as React.CSSProperties)}
              >
                <option value="">Any</option>
                {DISTRICTS.map(d => <option key={d} value={d}>District {d}</option>)}
              </select>
            </div>

            {/* Production months */}
            <div>
              <label style={{ display: "block", fontSize: "0.72rem", fontWeight: 600, color: COLORS.textMuted, marginBottom: "0.35rem", letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                Production Months
              </label>
              <input
                type="number"
                min={6}
                max={120}
                value={form.productionMonths}
                onChange={e => setForm(f => ({ ...f, productionMonths: Number(e.target.value) }))}
                style={inp()}
              />
            </div>

            {/* Purchase price — optional, only used to compute IRR and payout months */}
            <div>
              <label style={{ display: "block", fontSize: "0.72rem", fontWeight: 600, color: COLORS.textMuted, marginBottom: "0.35rem", letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                Proposed Purchase Price
              </label>
              <input
                type="number"
                min={0}
                step="any"
                value={form.purchasePrice}
                onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                placeholder="Optional — e.g. 250000"
                style={inp()}
              />
              <p style={{ fontSize: "0.7rem", color: COLORS.textMuted, marginTop: "0.3rem" }}>
                Enables IRR and payout months in the report. Leave blank to skip.
              </p>
            </div>
          </div>

          {/* Checkboxes */}
          <div style={{ display: "flex", gap: "1.5rem", marginTop: "0.9rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: "0.82rem", color: COLORS.textMuted }}>
              <input
                type="checkbox"
                checked={form.searchHistorical}
                onChange={e => setForm(f => ({ ...f, searchHistorical: e.target.checked }))}
                style={{ accentColor: COLORS.accent }}
              />
              Search historical records
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", fontSize: "0.82rem", color: COLORS.textMuted }}>
              <input
                type="checkbox"
                checked={form.includeOffsetWells}
                onChange={e => setForm(f => ({ ...f, includeOffsetWells: e.target.checked }))}
                style={{ accentColor: COLORS.accent }}
              />
              Include offset wells
            </label>
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <p style={{
        fontSize: "0.72rem",
        color: COLORS.textFaint,
        margin: "0 0 1.1rem 0",
        lineHeight: 1.6,
      }}>
        Fill in any identifier you have — API number, lease number, and/or operator name. The most specific identifier drives the search; any additional fields provide supplemental context to the agent.
      </p>

      {/* Submit button */}
      <button
        onClick={handleRun}
        disabled={!canSubmit || loading}
        style={{
          width: "100%",
          background: canSubmit && !loading ? COLORS.accent : COLORS.surfaceAlt,
          border: "none",
          borderRadius: 8,
          color: canSubmit && !loading ? "#fff" : COLORS.textFaint,
          fontSize: "0.9rem",
          fontWeight: 600,
          padding: "0.75rem 1.5rem",
          cursor: canSubmit && !loading ? "pointer" : "not-allowed",
          transition: "opacity 0.15s",
        }}
      >
        {loading ? "Starting…" : "Search TRRC Public Records"}
      </button>
    </div>
  );
}

// ─── Progress UI ───────────────────────────────────────────────────────────────

function ProgressUI({ run, onCancel }: { run: TrrcDueDiligenceRun; onCancel: () => void }) {
  const rawAttempts = run.source_attempts ?? [];
  // Same dedup as ResultsDashboard — the agent can retry a tool call while
  // reasoning, which would otherwise double-count these live progress tiles.
  const seenSources = new Set<string>();
  const attempts = rawAttempts.filter(a => {
    if (a.source_name === "submit_report") return false;
    if (seenSources.has(a.source_name)) return false;
    seenSources.add(a.source_name);
    return true;
  });
  const manualCount  = attempts.filter(a => a.status === "manual_required").length;
  const successCount = attempts.filter(a => a.status === "success").length;
  const recordCount  = attempts.reduce((s, a) => s + a.result_count, 0);
  const findingCount = (run.findings ?? []).length;

  const stageLabel: Record<string, string> = {
    pending:            "Initializing",
    running:            "Running",
    resolving:          "Resolving Identifiers",
    awaiting_selection: "Awaiting Selection",
    retrieving:         "Retrieving Records",
    analyzing:          "Analyzing Records",
    generating:         "Generating Report",
    complete:           "Complete",
    failed:             "Failed",
    cancelled:          "Cancelled",
  };

  return (
    <div>
      {/* Stage + progress */}
      <div style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: "1.5rem",
        marginBottom: "1rem",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 600, color: COLORS.text, marginBottom: 3 }}>
              {stageLabel[run.status] ?? run.status}
            </div>
            <div style={{ fontSize: "0.78rem", color: COLORS.textMuted }}>
              {run.result_summary
                ?? (run.status === "pending"
                  // Genuinely distinct from "running" — the worker hasn't
                  // claimed this run yet (it processes a limited number
                  // concurrently), so nothing is happening on it yet. Left
                  // as the generic "Processing…" message, a queued run was
                  // indistinguishable from a stuck one.
                  ? "Queued — waiting for the next available processing slot…"
                  : "Processing your request…")}
            </div>
          </div>
          <button onClick={onCancel} style={{
            background: "transparent",
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            color: COLORS.textMuted,
            fontSize: "0.75rem",
            padding: "0.4rem 0.9rem",
            cursor: "pointer",
          }}>
            Cancel
          </button>
        </div>

        {/* Progress bar */}
        <div style={{
          height: 6,
          background: COLORS.surfaceAlt,
          borderRadius: 99,
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            width: `${run.progress_percent ?? 0}%`,
            background: COLORS.accent,
            borderRadius: 99,
            transition: "width 0.5s ease",
          }} />
        </div>
        <div style={{ fontSize: "0.7rem", color: COLORS.textFaint, marginTop: "0.35rem", textAlign: "right" as const }}>
          {run.progress_percent ?? 0}%
        </div>
      </div>

      {/* Stats row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "0.75rem",
        marginBottom: "1rem",
      }}>
        {[
          { label: "Documents Found", value: recordCount },
          { label: "Sources Success", value: successCount },
          { label: "Findings", value: findingCount },
          { label: "Manual Required", value: manualCount },
        ].map(({ label, value }) => (
          <div key={label} style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            padding: "0.85rem 1rem",
            textAlign: "center" as const,
          }}>
            <div style={{ fontSize: "1.4rem", fontWeight: 700, color: COLORS.text }}>{value}</div>
            <div style={{ fontSize: "0.68rem", color: COLORS.textMuted, marginTop: 2, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Source cards */}
      {attempts.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "0.6rem",
        }}>
          {attempts.map(a => {
            const sColor = a.status === "success" ? COLORS.green
              : a.status === "manual_required" ? COLORS.yellow
              : a.status === "failed_transient" || a.status === "failed_permanent" ? COLORS.red
              : COLORS.textFaint;
            const sIcon = a.status === "success" ? "✅"
              : a.status === "manual_required" ? "📋"
              : a.status === "failed_transient" || a.status === "failed_permanent" ? "❌"
              : "⏳";
            return (
              <div key={a.source_id} style={{
                background: COLORS.surface, border: `1px solid ${COLORS.border}`,
                borderRadius: 8, padding: "0.7rem 0.9rem", display: "flex", alignItems: "flex-start", gap: 8,
              }}>
                <span style={{ fontSize: "1rem", lineHeight: 1 }}>{sIcon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, color: COLORS.text, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {SOURCE_LABELS[a.source_name] ?? a.source_name}
                  </div>
                  <div style={{ fontSize: "0.68rem", color: sColor, marginTop: 2 }}>
                    {a.status.replace(/_/g, " ")}
                    {a.result_count > 0 && ` · ${a.result_count} records`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Entity selection UI ───────────────────────────────────────────────────────

function EntitySelectionUI({ run, onSelect }: { run: TrrcDueDiligenceRun; onSelect: (id: string) => void }) {
  const entities = run.entities ?? [];
  return (
    <div>
      <div style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: "1.5rem",
        marginBottom: "1rem",
      }}>
        <h2 style={{ margin: "0 0 0.4rem 0", fontSize: "1rem", fontWeight: 600, color: COLORS.text }}>
          Multiple matches found
        </h2>
        <p style={{ margin: "0 0 1.25rem 0", fontSize: "0.82rem", color: COLORS.textMuted }}>
          Select the correct entity to continue the due diligence run.
        </p>

        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.75rem" }}>
          {entities.map(e => (
            <EntityCard key={e.id} entity={e} onSelect={onSelect} />
          ))}
        </div>

        {entities.length === 0 && (
          <p style={{ color: COLORS.textFaint, fontSize: "0.82rem" }}>No candidate entities returned.</p>
        )}
      </div>
    </div>
  );
}

function EntityCard({ entity, onSelect }: { entity: ResolvedEntity; onSelect: (id: string) => void }) {
  const attrs = entity.attributes as Record<string, string | undefined>;
  return (
    <div style={{
      background: COLORS.surfaceAlt,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 8,
      padding: "1rem 1.1rem",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    }}>
      <div>
        <div style={{ fontSize: "0.88rem", fontWeight: 600, color: COLORS.text, marginBottom: 5 }}>
          {entity.display_name}
        </div>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" as const }}>
          {[
            attrs.api_number && `API: ${attrs.api_number}`,
            attrs.lease_number && `Lease: ${attrs.lease_number}`,
            attrs.operator_name && `Operator: ${attrs.operator_name}`,
            attrs.district && `District: ${attrs.district}`,
          ].filter(Boolean).map((kv, i) => (
            <span key={i} style={{ fontSize: "0.72rem", color: COLORS.textMuted }}>{kv}</span>
          ))}
        </div>
        <div style={{ marginTop: 5 }}>
          <Pill bg={COLORS.accentDim} color={COLORS.accent}>
            {Math.round(entity.confidence * 100)}% confidence
          </Pill>
        </div>
      </div>
      <button
        onClick={() => onSelect(entity.id)}
        style={{
          background: COLORS.accent,
          border: "none",
          borderRadius: 7,
          color: "#fff",
          fontSize: "0.8rem",
          fontWeight: 600,
          padding: "0.5rem 1.1rem",
          cursor: "pointer",
          whiteSpace: "nowrap" as const,
          flexShrink: 0,
        }}
      >
        Select
      </button>
    </div>
  );
}

// ─── Results Dashboard ─────────────────────────────────────────────────────────

// Human-readable labels for each TRRC source
const SOURCE_LABELS: Record<string, string> = {
  search_by_api:              "Wellbore Identity (API Lookup)",
  search_by_lease:            "Lease Inventory",
  search_by_operator:         "Operator / P5 Organization",
  search_by_legal_description:"Legal Description (GIS)",
  fetch_production:           "Production History",
  fetch_completion_records:   "Completion Records (W-2)",
  fetch_well_status:          "Well Status",
  fetch_inactive_well_status: "Inactive Well Aging (IWAR)",
  fetch_orphan_well:          "Orphan Well Check",
  fetch_plugging_records:     "Plugging Records (W-3C)",
  fetch_compliance_violations:"Compliance Violations",
  fetch_p4_records:           "P-4 Gatherer / Purchaser",
  fetch_proration:            "Proration / Daily Allowable",
  fetch_injection_records:    "UIC / Injection Well Records",
  fetch_severance_records:    "Severance & Seal Orders",
  fetch_coda_records:         "Imaged Document Packets",
  fetch_drilling_permits:     "Drilling Permit Records (W-1)",
  fetch_county_records:       "County Real Property Records",
  fetch_gis_plat:             "RRC GIS / Plat Map",
};

function ResultsDashboard({
  run, activeTab, setActiveTab, onReset, onDownload, downloadError, onDismissDownloadError, apiFetch,
}: {
  run: TrrcDueDiligenceRun;
  activeTab: TabKey;
  setActiveTab: (t: TabKey) => void;
  onReset: () => void;
  onDownload: (type: keyof typeof DOWNLOAD_PATHS) => void;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  downloadError: string | null;
  onDismissDownloadError: () => void;
}) {
  const rawAttempts = run.source_attempts ?? [];
  // The agent can call the same tool more than once while reasoning (e.g.
  // retrying search_by_operator) — without this, a single source shows up
  // as multiple duplicate cards below. Keep the first attempt per source,
  // same convention used by the PDF/Evidence Index (report-builder.ts).
  const seenSources = new Set<string>();
  const attempts = rawAttempts.filter(a => {
    if (a.source_name === "submit_report") return false;
    if (seenSources.has(a.source_name)) return false;
    seenSources.add(a.source_name);
    return true;
  });
  const found = attempts.filter(a => a.status === "success" && a.result_count > 0);
  const manual = attempts.filter(a => a.status === "manual_required");
  // "no_results" is a legitimate confirmed absence (query succeeded, nothing there) —
  // group it with "Not Found", not "Failed", same as success+result_count===0.
  const notFound = attempts.filter(a =>
    (a.status === "success" && a.result_count === 0) || a.status === "no_results",
  );
  const failed = attempts.filter(a =>
    a.status !== "success" && a.status !== "manual_required" && a.status !== "no_results",
  );

  return (
    <div>
      {/* Well identity panel */}
      <div style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: "1.25rem 1.5rem",
        marginBottom: "1rem",
      }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.85rem" }}>
          Well Identity
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "0.6rem" }}>
          {[
            { label: "API Number", value: run.resolved_primary_api },
            { label: "Lease",      value: run.resolved_lease_number },
            { label: "District",   value: run.resolved_district },
            { label: "Operator #", value: run.resolved_operator_number },
            { label: "Input",      value: run.original_input },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "0.5rem 0.75rem" }}>
              <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" as const, marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: "0.85rem", color: value ? COLORS.text : COLORS.textFaint, fontWeight: value ? 500 : 400 }}>{value ?? "—"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem", borderBottom: `1px solid ${COLORS.border}`, paddingBottom: "0.6rem" }}>
        {([
          { key: "summary" as const,    label: "Summary" },
          { key: "scorecard" as const,  label: "Scorecard" },
          { key: "production" as const, label: "Production" },
          { key: "economics" as const,  label: "Economics" },
          { key: "findings" as const,   label: "Findings" },
          { key: "coverage" as const,   label: "Coverage" },
          { key: "geology" as const,    label: "Geology" },
        ]).map(({ key, label }) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{
            background: activeTab === key ? COLORS.accentDim : "transparent",
            border: `1px solid ${activeTab === key ? COLORS.accent : "transparent"}`,
            borderRadius: 7, color: activeTab === key ? COLORS.accent : COLORS.textMuted,
            fontSize: "0.8rem", fontWeight: 600, padding: "0.45rem 0.9rem", cursor: "pointer",
          }}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === "summary" && (
        <>
          {/* Summary stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.6rem", marginBottom: "1rem" }}>
            {[
              { label: "Sources Found", value: found.length, color: COLORS.green },
              { label: "Manual Required", value: manual.length, color: COLORS.yellow },
              { label: "Not Found", value: notFound.length, color: COLORS.textMuted },
              { label: "Failed", value: failed.length, color: failed.length > 0 ? COLORS.red : COLORS.textMuted },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem", textAlign: "center" as const }}>
                <div style={{ fontSize: "1.5rem", fontWeight: 700, color }}>{value}</div>
                <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, marginTop: 2, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Retrieved records */}
          {found.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.green, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.6rem" }}>
                Records Retrieved ({found.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
                {found.map(a => <SourceCard key={a.source_id} attempt={a} />)}
              </div>
            </div>
          )}

          {/* Manual required */}
          {manual.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.yellow, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.6rem" }}>
                Manual Retrieval Required ({manual.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
                {manual.map(a => <SourceCard key={a.source_id} attempt={a} />)}
              </div>
            </div>
          )}

          {/* Not found / No records */}
          {notFound.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.6rem" }}>
                No Records ({notFound.length})
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "0.4rem" }}>
                {notFound.map(a => (
                  <div key={a.source_id} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "0.6rem 0.85rem", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: "0.7rem", color: COLORS.textFaint }}>○</span>
                    <span style={{ fontSize: "0.78rem", color: COLORS.textMuted }}>{SOURCE_LABELS[a.source_name] ?? a.source_name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Failed */}
          {failed.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.red, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.6rem" }}>
                Failed ({failed.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.4rem" }}>
                {failed.map(a => (
                  <div key={a.source_id} style={{ background: COLORS.surface, border: `1px solid ${COLORS.red}30`, borderRadius: 7, padding: "0.6rem 0.85rem" }}>
                    <span style={{ fontSize: "0.78rem", color: COLORS.red }}>{SOURCE_LABELS[a.source_name] ?? a.source_name}</span>
                    {a.error_message && <span style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginLeft: 8 }}>— {a.error_message.slice(0, 100)}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === "scorecard" && <ScorecardTab scorecard={run.scorecard ?? null} />}
      {activeTab === "production" && <ProductionTab production={run.production ?? []} />}
      {activeTab === "economics" && <EconomicsTab runId={run.id} defaultPurchasePrice={run.purchase_price ?? null} apiFetch={apiFetch} />}
      {activeTab === "findings" && <FindingsTab flags={run.flags ?? { critical: [], important: [] }} />}
      {activeTab === "coverage" && <CoverageTab coverage={run.coverage ?? []} run={run} />}
      {activeTab === "geology" && <GeologyTab geology={run.geology ?? null} />}

      {/* Downloads */}
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.25rem 1.5rem", marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.85rem" }}>
          Downloads
        </div>
        {downloadError && (
          <div style={{
            background: COLORS.redDim, border: `1px solid ${COLORS.red}40`, borderRadius: 7,
            padding: "0.6rem 0.85rem", marginBottom: "0.85rem",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          }}>
            <span style={{ fontSize: "0.8rem", color: COLORS.red }}>⚠ {downloadError}</span>
            <button onClick={onDismissDownloadError} style={{
              background: "transparent", border: "none", color: COLORS.red,
              fontSize: "0.8rem", cursor: "pointer", padding: "0 0.25rem",
            }}>
              ✕
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap" as const }}>
          {([
            { type: "report" as const,             label: "PDF Report" },
            { type: "archive" as const,             label: "ZIP Archive" },
            { type: "manifest" as const,            label: "JSON Manifest" },
            { type: "export-xlsx" as const,         label: "Excel Workbook" },
            { type: "export-production" as const,   label: "Production CSV" },
            { type: "export-coverage" as const,     label: "Coverage CSV" },
            { type: "export-evidence" as const,     label: "Evidence Index CSV" },
            { type: "export-timeline" as const,     label: "Timeline CSV" },
            { type: "export-offset" as const,       label: "Offset Wells CSV" },
            { type: "export-lateral" as const,      label: "Lateral Path CSV" },
            { type: "export-county" as const,       label: "County Records CSV" },
          ]).map(({ type, label }) => (
            <button key={type} onClick={() => onDownload(type)} style={{
              background: COLORS.surfaceAlt, border: `1px solid ${COLORS.borderStrong}`,
              borderRadius: 7, color: COLORS.text, fontSize: "0.8rem", fontWeight: 500,
              padding: "0.5rem 1rem", cursor: "pointer",
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ textAlign: "center" as const }}>
        <button onClick={onReset} style={{ background: "transparent", border: `1px solid ${COLORS.border}`, borderRadius: 7, color: COLORS.textMuted, fontSize: "0.8rem", padding: "0.5rem 1.25rem", cursor: "pointer" }}>
          New Search
        </button>
      </div>
    </div>
  );
}

// ─── Scorecard tab ──────────────────────────────────────────────────────────────

const RECOMMENDATION_COLOR: Record<string, string> = {
  PURSUE: COLORS.green, REVIEW: COLORS.yellow, PASS: COLORS.textMuted, BLOCKED: COLORS.red,
};

function scoreColor(score: number): string {
  if (score >= 70) return COLORS.green;
  if (score >= 40) return COLORS.yellow;
  return COLORS.red;
}

function ScorecardTab({ scorecard }: { scorecard: AcquisitionScorecard | null }) {
  if (!scorecard) {
    return <div style={{ color: COLORS.textMuted, fontSize: "0.85rem", padding: "1rem 0" }}>Scorecard not available for this run.</div>;
  }
  const recColor = RECOMMENDATION_COLOR[scorecard.recommendation] ?? COLORS.textMuted;

  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", gap: "0.6rem", marginBottom: "1rem" }}>
        <div style={{ background: `${recColor}18`, border: `1px solid ${recColor}`, borderRadius: 8, padding: "0.75rem 1.25rem", display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: "1.1rem", fontWeight: 800, color: recColor, letterSpacing: "0.05em" }}>{scorecard.recommendation}</span>
        </div>
        {[
          { label: "Opportunity Score", value: scorecard.opportunity_score },
          { label: "Risk Score", value: scorecard.risk_score },
          { label: "Overall Confidence", value: scorecard.overall_confidence },
        ].map(({ label, value }) => (
          <div key={label} style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem", textAlign: "center" as const }}>
            <div style={{ fontSize: "1.4rem", fontWeight: 700, color: scoreColor(value) }}>{value}</div>
            <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, marginTop: 2, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{label}</div>
          </div>
        ))}
      </div>

      {scorecard.gating_conditions.length > 0 && (
        <div style={{ marginBottom: "1rem", background: COLORS.redDim, border: `1px solid ${COLORS.red}`, borderRadius: 8, padding: "0.85rem 1rem" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.red, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.5rem" }}>
            Gating Conditions
          </div>
          {scorecard.gating_conditions.map((g, i) => (
            <div key={i} style={{ fontSize: "0.82rem", color: COLORS.text, marginBottom: 4 }}>• {g}</div>
          ))}
        </div>
      )}

      <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.6rem" }}>
        Scoring Dimensions
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.6rem", marginBottom: "1rem" }}>
        {Object.entries(scorecard.dimensions).map(([key, d]: [string, ScoreDimension]) => (
          <div key={key} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem 0.9rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
              <span style={{ fontSize: "0.82rem", fontWeight: 600, color: COLORS.text }}>{d.label}</span>
              <span style={{ fontSize: "0.9rem", fontWeight: 700, color: scoreColor(d.score) }}>{d.score}</span>
            </div>
            <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginBottom: 4 }}>Weight {(d.weight * 100).toFixed(0)}%</div>
            <div style={{ fontSize: "0.75rem", color: COLORS.textMuted }}>{d.rationale}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.green, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.5rem" }}>
            Reasons For
          </div>
          {scorecard.reasons_for.length > 0
            ? scorecard.reasons_for.map((r, i) => <div key={i} style={{ fontSize: "0.8rem", color: COLORS.text, marginBottom: 4 }}>• {r}</div>)
            : <div style={{ fontSize: "0.8rem", color: COLORS.textFaint }}>None identified.</div>}
        </div>
        <div>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.red, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.5rem" }}>
            Reasons Against
          </div>
          {scorecard.reasons_against.length > 0
            ? scorecard.reasons_against.map((r, i) => <div key={i} style={{ fontSize: "0.8rem", color: COLORS.text, marginBottom: 4 }}>• {r}</div>)
            : <div style={{ fontSize: "0.8rem", color: COLORS.textFaint }}>None identified.</div>}
        </div>
      </div>
    </div>
  );
}

// ─── Production tab ─────────────────────────────────────────────────────────────

function ProductionTab({ production }: { production: TrrcDDProductionRow[] }) {
  if (production.length === 0) {
    return <div style={{ color: COLORS.textMuted, fontSize: "0.85rem", padding: "1rem 0" }}>No production rows available for this run — see the Findings tab for why, if the query was attempted.</div>;
  }
  const rows = [...production].sort((a, b) => b.production_month.localeCompare(a.production_month));

  return (
    <div style={{ marginBottom: "1rem", overflowX: "auto" as const }}>
      <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: "0.8rem" }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${COLORS.borderStrong}` }}>
            {["Month", "Oil (BBL)", "Gas (MCF)", "Water (BBL)", "Condensate (BBL)"].map(h => (
              <th key={h} style={{ textAlign: "left" as const, padding: "0.5rem 0.75rem", color: COLORS.textMuted, fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              <td style={{ padding: "0.45rem 0.75rem", color: COLORS.text }}>{r.production_month}</td>
              <td style={{ padding: "0.45rem 0.75rem", color: COLORS.text }}>{r.oil_bbl ?? "—"}</td>
              <td style={{ padding: "0.45rem 0.75rem", color: COLORS.text }}>{r.gas_mcf ?? "—"}</td>
              <td style={{ padding: "0.45rem 0.75rem", color: COLORS.text }}>{r.water_bbl ?? "—"}</td>
              <td style={{ padding: "0.45rem 0.75rem", color: COLORS.text }}>{r.condensate_bbl ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Economics tab — interactive "what if" recalculation ────────────────────────
//
// Asked for directly in the 2026-08-18 Novi call: "do I get to go into
// software and change my assumptions? Does it recalculate the economics on
// the fly?" Hits /recalculate-economics on every input change (debounced),
// which re-runs the same deterministic engine the PDF uses against this
// run's already-persisted production — no re-retrieval, no re-fit-from-
// scratch wait. Starting values (70/3.0) match eia-pricing.ts's own static
// fallback deck, not an arbitrary guess — that fallback is what's actually
// in effect today (EIA_API_KEY isn't confirmed live yet).

interface SensitivityRow {
  oilUsdBbl: number;
  pv10: number | null;
  netCashFlow: number | null;
  isCurrent: boolean;
}

interface RecalcResult {
  pv10: number | null;
  pv15: number | null;
  netCashFlow: number | null;
  grossRevenue: number | null;
  irr: number | null;
  payoutMonths: number | null;
  breakevenOilPriceUsdBbl: number | null;
  costAssumptionNote: string;
  irrPayoutNote: string;
  sufficientData: boolean;
  sensitivityGrid: SensitivityRow[];
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function EconomicsTab({ runId, defaultPurchasePrice, apiFetch }: {
  runId: string;
  defaultPurchasePrice: number | null;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [oilPrice, setOilPrice] = useState(70);
  const [gasPrice, setGasPrice] = useState(3.0);
  const [purchasePrice, setPurchasePrice] = useState(defaultPurchasePrice !== null ? String(defaultPurchasePrice) : "");
  // NGL/Waha — real gaps raised directly in the 2026-08-18 Novi call
  // ("What happens if NGLs? What happens if WAHA is this?"). Zero means
  // "not modeled," matching computeEconomics' own default — these are
  // explicit user assumptions, never automated data (no live NGL/Waha
  // feed exists anywhere in this codebase).
  const [nglYield, setNglYield] = useState("");
  const [nglPrice, setNglPrice] = useState("");
  const [wahaDiff, setWahaDiff] = useState("");
  const [result, setResult] = useState<RecalcResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Debounced so dragging a slider or typing doesn't fire a request per
    // keystroke — 400ms is long enough to coalesce rapid input, short
    // enough that "on the fly" still feels true.
    const handle = setTimeout(async () => {
      try {
        const pp = purchasePrice.trim() ? Number(purchasePrice.trim()) : undefined;
        const ny = nglYield.trim() ? Number(nglYield.trim()) : undefined;
        const np = nglPrice.trim() ? Number(nglPrice.trim()) : undefined;
        const wd = wahaDiff.trim() ? Number(wahaDiff.trim()) : undefined;
        const res = await apiFetch(`/api/trrc/due-diligence/${runId}/recalculate-economics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            oil_usd_bbl: oilPrice,
            gas_usd_mcf: gasPrice,
            ...(pp !== undefined && Number.isFinite(pp) && pp > 0 ? { purchase_price_usd: pp } : {}),
            ...(ny !== undefined && Number.isFinite(ny) && ny >= 0 ? { ngl_yield_bbl_per_mcf: ny } : {}),
            ...(np !== undefined && Number.isFinite(np) && np >= 0 ? { ngl_price_usd_bbl: np } : {}),
            ...(wd !== undefined && Number.isFinite(wd) ? { waha_differential_usd_mcf: wd } : {}),
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) {
          setError(data.error ?? "Recalculation failed.");
          setResult(null);
        } else {
          setResult(data.data as RecalcResult);
        }
      } catch {
        if (!cancelled) setError("Lost connection while recalculating.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [oilPrice, gasPrice, purchasePrice, nglYield, nglPrice, wahaDiff, runId, apiFetch]);

  const inputStyle = {
    width: "100%", background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`,
    borderRadius: 7, color: COLORS.text, fontSize: "0.9rem", padding: "0.5rem 0.7rem",
  };
  const labelStyle = {
    fontSize: "0.68rem", color: COLORS.textMuted, fontWeight: 600,
    textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 5, display: "block" as const,
  };

  return (
    <div>
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1.25rem", marginBottom: "1rem" }}>
        <div style={{ fontSize: "0.85rem", fontWeight: 600, color: COLORS.text, marginBottom: "0.25rem" }}>Interactive Assumptions</div>
        <div style={{ fontSize: "0.75rem", color: COLORS.textMuted, marginBottom: "1rem" }}>
          Adjusts oil/gas price and purchase price live against this run's already-retrieved production — recalculates in place, no re-run needed.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.9rem" }}>
          <div>
            <label style={labelStyle}>Oil Price ($/BBL)</label>
            <input type="number" step="0.5" min="0.01" style={inputStyle} value={oilPrice}
              onChange={e => setOilPrice(Number(e.target.value))} />
          </div>
          <div>
            <label style={labelStyle}>Gas Price ($/MCF)</label>
            <input type="number" step="0.1" min="0.01" style={inputStyle} value={gasPrice}
              onChange={e => setGasPrice(Number(e.target.value))} />
          </div>
          <div>
            <label style={labelStyle}>Purchase Price ($, optional — for IRR/payout)</label>
            <input type="number" step="1000" min="0" style={inputStyle} placeholder="Not supplied" value={purchasePrice}
              onChange={e => setPurchasePrice(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.9rem", marginTop: "0.9rem" }}>
          <div>
            <label style={labelStyle}>NGL Yield (BBL/MCF, optional)</label>
            <input type="number" step="0.01" min="0" style={inputStyle} placeholder="Not modeled" value={nglYield}
              onChange={e => setNglYield(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>NGL Price ($/BBL, optional)</label>
            <input type="number" step="0.5" min="0" style={inputStyle} placeholder="Not modeled" value={nglPrice}
              onChange={e => setNglPrice(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Waha Differential ($/MCF below Henry Hub, optional)</label>
            <input type="number" step="0.1" style={inputStyle} placeholder="Not modeled" value={wahaDiff}
              onChange={e => setWahaDiff(e.target.value)} />
          </div>
        </div>
        <div style={{ fontSize: "0.68rem", color: COLORS.textFaint, marginTop: "0.6rem", fontStyle: "italic" as const }}>
          NGL and Waha are explicit assumptions you enter, not retrieved or live-sourced data — no automated NGL/Waha feed exists yet. Leave blank to exclude either from the calculation.
        </div>
      </div>

      {error && (
        <div style={{ background: COLORS.redDim, border: `1px solid ${COLORS.red}`, borderRadius: 8, padding: "0.75rem 1rem", color: COLORS.red, fontSize: "0.82rem", marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {result && !result.sufficientData && (
        <div style={{ background: COLORS.yellowDim, border: `1px solid ${COLORS.yellow}`, borderRadius: 8, padding: "0.75rem 1rem", color: COLORS.yellow, fontSize: "0.82rem", marginBottom: "1rem" }}>
          Every figure below is a dash because this well doesn't have enough production history for a decline-curve fit — not because the recalculation failed. Nothing is estimated in its place.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.75rem", marginBottom: "1rem", opacity: loading ? 0.55 : 1, transition: "opacity 0.2s ease" }}>
        {[
          { label: "PV-10", value: fmtUsd(result?.pv10 ?? null), color: COLORS.accent },
          { label: "PV-15", value: fmtUsd(result?.pv15 ?? null), color: COLORS.accent },
          { label: "Net Cash Flow", value: fmtUsd(result?.netCashFlow ?? null), color: COLORS.green },
          { label: "Gross Revenue", value: fmtUsd(result?.grossRevenue ?? null), color: COLORS.text },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.85rem" }}>
            <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 5 }}>{label}</div>
            <div style={{ fontSize: "1.15rem", fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem", marginBottom: "1rem", opacity: loading ? 0.55 : 1, transition: "opacity 0.2s ease" }}>
        {[
          { label: "IRR (annualized)", value: result?.irr !== null && result?.irr !== undefined ? `${result.irr.toFixed(1)}%` : "—" },
          { label: "Payout", value: result?.payoutMonths !== null && result?.payoutMonths !== undefined ? `${result.payoutMonths.toFixed(1)} mo` : "—" },
          { label: "Breakeven Oil Price", value: result?.breakevenOilPriceUsdBbl !== null && result?.breakevenOilPriceUsdBbl !== undefined ? fmtUsd(result.breakevenOilPriceUsdBbl) : "—" },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.85rem" }}>
            <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.05em", marginBottom: 5 }}>{label}</div>
            <div style={{ fontSize: "1.05rem", fontWeight: 700, color: COLORS.text }}>{value}</div>
          </div>
        ))}
      </div>

      {result && result.sensitivityGrid.length > 0 && (
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "1rem 1.25rem", marginBottom: "1rem", opacity: loading ? 0.55 : 1, transition: "opacity 0.2s ease" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: COLORS.text, marginBottom: "0.15rem" }}>Price Sensitivity</div>
          <div style={{ fontSize: "0.7rem", color: COLORS.textMuted, marginBottom: "0.75rem" }}>
            PV-10 at $7 increments around the oil price above — everything else held constant.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: "0.8rem" }}>
            <thead>
              <tr>
                {result.sensitivityGrid.map((row) => (
                  <th key={row.oilUsdBbl} style={{
                    textAlign: "center" as const, padding: "0.4rem 0.3rem", fontWeight: 700,
                    color: row.isCurrent ? COLORS.accent : COLORS.textMuted,
                    borderBottom: `2px solid ${row.isCurrent ? COLORS.accent : COLORS.border}`,
                  }}>
                    {fmtUsd(row.oilUsdBbl)}/bbl
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {result.sensitivityGrid.map((row) => (
                  <td key={row.oilUsdBbl} style={{
                    textAlign: "center" as const, padding: "0.55rem 0.3rem", fontWeight: row.isCurrent ? 700 : 500,
                    color: row.isCurrent ? COLORS.text : COLORS.textMuted,
                  }}>
                    {fmtUsd(row.pv10)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <div style={{ fontSize: "0.72rem", color: COLORS.textFaint, lineHeight: 1.5 }}>
          {result.costAssumptionNote}
          {result.irrPayoutNote ? <> · {result.irrPayoutNote}</> : null}
        </div>
      )}
    </div>
  );
}

// ─── Findings tab ───────────────────────────────────────────────────────────────

function FindingsTab({ flags }: { flags: { critical: string[]; important: string[] } }) {
  if (flags.critical.length === 0 && flags.important.length === 0) {
    return <div style={{ color: COLORS.textMuted, fontSize: "0.85rem", padding: "1rem 0" }}>No critical or important findings identified.</div>;
  }
  return (
    <div style={{ marginBottom: "1rem", display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
      {flags.critical.map((f, i) => (
        <div key={`c${i}`} style={{ background: COLORS.redDim, border: `1px solid ${COLORS.red}`, borderRadius: 8, padding: "0.75rem 1rem" }}>
          <span style={{ fontSize: "0.65rem", fontWeight: 700, color: COLORS.red, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Critical</span>
          <div style={{ fontSize: "0.85rem", color: COLORS.text, marginTop: 4 }}>{f}</div>
        </div>
      ))}
      {flags.important.map((f, i) => (
        <div key={`i${i}`} style={{ background: COLORS.yellowDim, border: `1px solid ${COLORS.yellow}`, borderRadius: 8, padding: "0.75rem 1rem" }}>
          <span style={{ fontSize: "0.65rem", fontWeight: 700, color: COLORS.yellow, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Important</span>
          <div style={{ fontSize: "0.85rem", color: COLORS.text, marginTop: 4 }}>{f}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Geology tab ────────────────────────────────────────────────────────────────
//
// Mirrors report-builder.ts's GeologicalDueDiligencePage: every finding gets
// a small colored FACT / CALCULATION / INTERPRETATION label so a reviewer
// can tell at a glance what's directly observed vs. computed vs. a bounded
// conclusion — never presented with uniform-looking confidence.

const GEOLOGY_CLASSIFICATION_COLOR: Record<string, string> = {
  FAVORABLE: COLORS.green, MIXED: COLORS.yellow, UNFAVORABLE: COLORS.red, INSUFFICIENT_DATA: COLORS.textMuted,
};

const STATEMENT_LABEL: Record<string, { text: string; color: string; dim: string }> = {
  observed:   { text: "FACT",           color: COLORS.accent, dim: COLORS.accentDim },
  calculated: { text: "CALCULATION",    color: COLORS.green,  dim: COLORS.greenDim },
  inferred:   { text: "INTERPRETATION", color: COLORS.yellow, dim: COLORS.yellowDim },
};

const GEOLOGY_CATEGORY_LABEL: Record<string, string> = {
  supporting: "Supporting", contradicting: "Contradicting", risk: "Risk", gap: "Data Gap",
};

function GeologyTab({ geology }: { geology: TrrcGeologyDashboardSummary | null }) {
  if (!geology) {
    return (
      <div style={{ color: COLORS.textMuted, fontSize: "0.85rem", padding: "1rem 0" }}>
        Geological due diligence has not been generated for this run yet — download the PDF report to compute it
        (offset-well search, formation context, and the FACT/CALCULATION/INTERPRETATION assessment below all come
        from that same run and appear here afterward).
      </div>
    );
  }

  const findingGroups: Array<{ key: TrrcGeologyDashboardSummary["findings"][number]["category"]; label: string }> = [
    { key: "risk", label: "Risk" },
    { key: "supporting", label: "Supporting" },
    { key: "contradicting", label: "Contradicting" },
    { key: "gap", label: "Data Gap" },
  ];

  return (
    <div style={{ marginBottom: "1rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.6rem", marginBottom: "1rem" }}>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem", textAlign: "center" as const }}>
          <div style={{ fontSize: "1.15rem", fontWeight: 700, color: GEOLOGY_CLASSIFICATION_COLOR[geology.classification] ?? COLORS.text }}>
            {geology.classification.replace("_", " ")}
          </div>
          <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, marginTop: 2, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Assessment</div>
        </div>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem", textAlign: "center" as const }}>
          <div style={{ fontSize: "1.15rem", fontWeight: 700, color: COLORS.text }}>{geology.confidence.replace("_", " ")}</div>
          <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, marginTop: 2, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Confidence</div>
        </div>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem", textAlign: "center" as const }}>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.text }}>{geology.offsetWellCount3mi}</div>
          <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, marginTop: 2, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Offset Wells (3mi)</div>
        </div>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem", textAlign: "center" as const }}>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.text }}>{geology.producingWellCount3mi}</div>
          <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, marginTop: 2, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Producing (3mi)</div>
        </div>
      </div>

      <div style={{ background: COLORS.accentDim, border: `1px solid ${COLORS.accent}`, borderRadius: 8, padding: "0.85rem 1rem", marginBottom: "1rem" }}>
        <span style={{ fontSize: "0.65rem", fontWeight: 700, color: COLORS.accent, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
          Transaction-Specific Implication (Interpretation)
        </span>
        <div style={{ fontSize: "0.85rem", color: COLORS.text, marginTop: 4, lineHeight: 1.5 }}>{geology.diligenceImplication}</div>
      </div>

      {findingGroups.map(({ key, label }) => {
        const group = geology.findings.filter(f => f.category === key);
        if (group.length === 0) return null;
        return (
          <div key={key} style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: COLORS.textMuted, textTransform: "uppercase" as const, letterSpacing: "0.1em", marginBottom: "0.6rem" }}>
              {label} ({group.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
              {group.map((f, i) => {
                const stmt = STATEMENT_LABEL[f.classification] ?? { text: f.classification.toUpperCase(), color: COLORS.textMuted, dim: COLORS.surfaceAlt };
                return (
                  <div key={i} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "0.75rem 1rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{
                        fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" as const,
                        color: stmt.color, background: stmt.dim, borderRadius: 4, padding: "2px 6px",
                      }}>
                        {stmt.text}
                      </span>
                      <span style={{ fontSize: "0.85rem", fontWeight: 600, color: COLORS.text }}>{f.title}</span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: COLORS.textMuted, lineHeight: 1.45 }}>{f.description}</div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "0.6rem" }}>
        {[
          { label: "Subject Formation", value: geology.subjectFormation },
          { label: "Subject TVD", value: geology.subjectTvdFt !== null ? `${geology.subjectTvdFt.toLocaleString()} ft` : null },
          { label: "Subject TVDSS", value: geology.subjectTvdssFt !== null ? `${geology.subjectTvdssFt.toLocaleString()} ft` : null },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "0.5rem 0.75rem" }}>
            <div style={{ fontSize: "0.65rem", color: COLORS.textMuted, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" as const, marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: "0.85rem", color: value ? COLORS.text : COLORS.textFaint, fontWeight: value ? 500 : 400 }}>{value ?? "Not available"}</div>
          </div>
        ))}
      </div>
      {geology.tvdssMethodology && (
        <div style={{ fontSize: "0.72rem", color: COLORS.textFaint, fontStyle: "italic" as const, marginTop: 8 }}>{geology.tvdssMethodology}</div>
      )}
    </div>
  );
}

// ─── Coverage tab ───────────────────────────────────────────────────────────────

const COVERAGE_STATUS_COLOR: Record<string, string> = {
  complete: COLORS.green, partial: COLORS.green,
  retrieval_failed: COLORS.red, manual_required: COLORS.yellow,
  no_applicable_record: COLORS.textMuted, not_checked: COLORS.textFaint,
};

const COVERAGE_STATUS_LABEL: Record<string, string> = {
  complete: "Complete", partial: "Partial", retrieval_failed: "Retrieval Failed",
  manual_required: "Manual Required", no_applicable_record: "No Applicable Record", not_checked: "Not Checked",
};

function CoverageTab({ coverage, run }: { coverage: SourceCoverageStatus[]; run: TrrcDueDiligenceRun }) {
  if (coverage.length === 0) {
    return <div style={{ color: COLORS.textMuted, fontSize: "0.85rem", padding: "1rem 0" }}>No coverage data available for this run.</div>;
  }
  // For anything not fully retrieved, surface a direct link to the TRRC
  // portal and the exact criteria to re-run it by hand — the same
  // buildEvidenceIndex() data the PDF's Missing Documents section and
  // Evidence Index use, so a failed source is never a dead end here either.
  const rawAttempts = (run.source_attempts ?? []) as unknown as import("@/lib/trrc/coverage").LiteSourceAttempt[];
  const evidenceBySource = new Map(buildEvidenceIndex(rawAttempts, run).map(e => [e.source_name, e]));

  return (
    <div style={{ marginBottom: "1rem", display: "flex", flexDirection: "column" as const, gap: "0.4rem" }}>
      {coverage.map(c => {
        const color = COVERAGE_STATUS_COLOR[c.status] ?? COLORS.textMuted;
        const needsFallback = c.status === "retrieval_failed" || c.status === "manual_required";
        const fallbackEntries = needsFallback
          ? c.sources_checked.map(s => evidenceBySource.get(s)).filter((e): e is NonNullable<typeof e> => !!e)
          : [];
        return (
          <div key={c.category} style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderLeft: `3px solid ${color}`, borderRadius: 7, padding: "0.6rem 0.85rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: COLORS.text }}>{c.label}</span>
                {c.notes && <div style={{ fontSize: "0.72rem", color: COLORS.textFaint, marginTop: 2 }}>{c.notes}</div>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                {c.records_found > 0 && <span style={{ fontSize: "0.72rem", color: COLORS.textMuted }}>{c.records_found} record{c.records_found !== 1 ? "s" : ""}</span>}
                <span style={{ fontSize: "0.65rem", fontWeight: 700, color, background: `${color}18`, padding: "0.15rem 0.5rem", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.05em", whiteSpace: "nowrap" as const }}>
                  {COVERAGE_STATUS_LABEL[c.status] ?? c.status}
                </span>
              </div>
            </div>
            {fallbackEntries.map(e => (
              <div key={e.source_name} style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${COLORS.border}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                <a href={e.portal_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.72rem", color: COLORS.accent, textDecoration: "none", fontWeight: 600 }}>
                  {e.portal} ↗
                </a>
                <span style={{ fontSize: "0.72rem", color: COLORS.textFaint }}>Enter: <span style={{ fontFamily: "monospace" }}>{e.query_criteria}</span></span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Source record card ────────────────────────────────────────────────────────

type SourceAttemptRow = NonNullable<TrrcDueDiligenceRun["source_attempts"]>[number];

function SourceCard({ attempt }: { attempt: SourceAttemptRow }) {
  const [expanded, setExpanded] = useState(false);
  const data = (attempt.result_data_json ?? {}) as Record<string, unknown>;
  const label = SOURCE_LABELS[attempt.source_name] ?? attempt.source_name;
  const trrcUrl = data["trrc_source_url"] as string | undefined;
  const isManual = attempt.status === "manual_required";

  const statusColor = isManual ? COLORS.yellow : COLORS.green;
  const statusLabel = isManual ? "MANUAL REQUIRED" : `${attempt.result_count} record${attempt.result_count !== 1 ? "s" : ""}`;

  // Extract a few key facts to show in the card
  const keyFacts: [string, string][] = [];
  if (data["api_number"])      keyFacts.push(["API", String(data["api_number"])]);
  if (data["formatted_api"])   keyFacts.push(["API", String(data["formatted_api"])]);
  if (data["lease_number"])    keyFacts.push(["Lease", String(data["lease_number"])]);
  if (data["district"])        keyFacts.push(["District", String(data["district"])]);
  if (data["operator"])        keyFacts.push(["Operator", String(data["operator"])]);
  if (data["operator_name"])   keyFacts.push(["Operator", String(data["operator_name"])]);
  if (data["county"])          keyFacts.push(["County", String(data["county"])]);
  if (data["org_status"])      keyFacts.push(["Org Status", String(data["org_status"])]);
  if (data["uic_no"])          keyFacts.push(["UIC No.", String(data["uic_no"])]);
  if (data["total_wellbores"]) keyFacts.push(["Wellbores", String(data["total_wellbores"])]);
  if (data["months_returned"]) keyFacts.push(["Months", String(data["months_returned"])]);
  if (data["note"] && !data["data_gap"]) keyFacts.push(["Note", String(data["note"]).slice(0, 80)]);

  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderLeft: `3px solid ${statusColor}`,
      borderRadius: 8,
      padding: "0.85rem 1rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: keyFacts.length > 0 || expanded ? "0.5rem" : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 600, color: COLORS.text, flexShrink: 0 }}>{label}</span>
          <span style={{ fontSize: "0.65rem", fontWeight: 700, color: statusColor, background: `${statusColor}18`, padding: "0.15rem 0.5rem", borderRadius: 4, textTransform: "uppercase" as const, letterSpacing: "0.05em", whiteSpace: "nowrap" as const }}>
            {statusLabel}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {trrcUrl && (
            <a href={trrcUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.75rem", color: COLORS.accent, textDecoration: "none", whiteSpace: "nowrap" as const }}>
              View on TRRC ↗
            </a>
          )}
          {Object.keys(data).length > 0 && (
            <button onClick={() => setExpanded(e => !e)} style={{ background: "transparent", border: "none", color: COLORS.textMuted, fontSize: "0.72rem", cursor: "pointer", padding: 0 }}>
              {expanded ? "Less" : "More"}
            </button>
          )}
        </div>
      </div>

      {/* Key facts row */}
      {keyFacts.length > 0 && !expanded && (
        <div style={{ display: "flex", gap: "1.2rem", flexWrap: "wrap" as const }}>
          {keyFacts.slice(0, 5).map(([k, v]) => (
            <span key={k} style={{ fontSize: "0.72rem", color: COLORS.textMuted }}>
              <span style={{ color: COLORS.textFaint }}>{k}: </span>
              <span style={{ color: COLORS.text, fontWeight: 500 }}>{v}</span>
            </span>
          ))}
        </div>
      )}

      {/* Expanded JSON data */}
      {expanded && (
        <div style={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "0.6rem 0.85rem", marginTop: "0.5rem", overflowX: "auto" as const }}>
          <pre style={{ margin: 0, fontSize: "0.7rem", color: COLORS.textMuted, fontFamily: "monospace", whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const }}>
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

