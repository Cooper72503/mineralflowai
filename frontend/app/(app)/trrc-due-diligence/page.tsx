"use client";

import React, { useState, useEffect, useCallback } from "react";
import type {
  TrrcDueDiligenceRun,
  TrrcIdentifierType,
  SourceAttemptStatus,
  FindingSeverity,
  AcquisitionRecommendation,
  TrrcFinding,
  TrrcMissingItem,
  SourceCoverageStatus,
  ScoreDimension,
  ResolvedEntity,
} from "../../../lib/trrc/types";
import { detectInputType } from "../../../lib/trrc/normalization";

// ─── Design tokens (matches UnderwritingPage.tsx exactly) ─────────────────────

const COLORS = {
  bg:           "#0f1117",
  surface:      "#181c25",
  surfaceAlt:   "#1e2333",
  border:       "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.15)",
  text:         "#e2e8f0",
  textMuted:    "#8892a4",
  textFaint:    "#5a6478",
  accent:       "#4f8ef7",
  accentDim:    "rgba(79,142,247,0.12)",
  green:        "#22c55e",
  greenDim:     "rgba(34,197,94,0.12)",
  yellow:       "#f59e0b",
  yellowDim:    "rgba(245,158,11,0.12)",
  red:          "#ef4444",
  redDim:       "rgba(239,68,68,0.12)",
  purple:       "#a78bfa",
  purpleDim:    "rgba(167,139,250,0.12)",
};

// ─── District options ──────────────────────────────────────────────────────────

const DISTRICTS = ["01","02","03","04","05","06","07B","07C","08","09","10","C1","C2","C3"];

const INPUT_TYPES: { value: TrrcIdentifierType; label: string }[] = [
  { value: "api_number",       label: "API Number" },
  { value: "rrc_lease_number", label: "Lease Number" },
  { value: "gas_well_id",      label: "Gas Well ID" },
  { value: "operator_name",    label: "Operator Name" },
  { value: "p5_number",        label: "P-5 Number" },
  { value: "legal_description",label: "Legal Description" },
  { value: "lease_name",       label: "Lease Name" },
];

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

// ─── Source status helpers ─────────────────────────────────────────────────────

function sourceStatusIcon(status: SourceAttemptStatus): string {
  switch (status) {
    case "success":          return "✅";
    case "manual_required":  return "📋";
    case "failed_transient":
    case "failed_permanent": return "❌";
    case "rate_limited":     return "⏳";
    default:                 return "⏳";
  }
}

function sourceStatusColor(status: SourceAttemptStatus): string {
  switch (status) {
    case "success":          return COLORS.green;
    case "manual_required":  return COLORS.yellow;
    case "failed_transient":
    case "failed_permanent": return COLORS.red;
    default:                 return COLORS.textFaint;
  }
}

function coverageStatusColor(status: string): string {
  switch (status) {
    case "complete":               return COLORS.green;
    case "partial":                return COLORS.yellow;
    case "manual_required":        return COLORS.yellow;
    case "retrieval_failed":       return COLORS.red;
    case "no_applicable_record":   return COLORS.textMuted;
    default:                       return COLORS.textFaint;
  }
}

function severityColor(sev: FindingSeverity): string {
  switch (sev) {
    case "critical": return COLORS.red;
    case "high":     return "#f97316";
    case "medium":   return COLORS.yellow;
    case "low":      return COLORS.accent;
    default:         return COLORS.textMuted;
  }
}

function severityBg(sev: FindingSeverity): string {
  switch (sev) {
    case "critical": return COLORS.redDim;
    case "high":     return "rgba(249,115,22,0.12)";
    case "medium":   return COLORS.yellowDim;
    case "low":      return COLORS.accentDim;
    default:         return "rgba(255,255,255,0.04)";
  }
}

function recColor(rec: AcquisitionRecommendation): { bg: string; border: string; color: string } {
  switch (rec) {
    case "PURSUE":  return { bg: "rgba(34,197,94,0.1)",  border: COLORS.green,  color: COLORS.green };
    case "REVIEW":  return { bg: "rgba(245,158,11,0.1)", border: COLORS.yellow, color: COLORS.yellow };
    case "PASS":    return { bg: "rgba(239,68,68,0.1)",  border: COLORS.red,    color: COLORS.red };
    case "BLOCKED": return { bg: "rgba(255,255,255,0.04)", border: COLORS.textFaint, color: COLORS.textMuted };
  }
}

// ─── Form state type ───────────────────────────────────────────────────────────

type FormState = {
  query: string;
  county: string;
  district: string;
  inputTypeOverride: TrrcIdentifierType | "auto";
  searchHistorical: boolean;
  includeOffsetWells: boolean;
  productionMonths: number;
};

type Phase = "form" | "running" | "selecting" | "complete" | "error";
type TabKey = "summary" | "scorecard" | "production" | "findings" | "coverage" | "missing";

// ─── Main page component ───────────────────────────────────────────────────────

export default function TrrcDueDiligencePage() {
  const [phase, setPhase]           = useState<Phase>("form");
  const [runId, setRunId]           = useState<string | null>(null);
  const [run, setRun]               = useState<TrrcDueDiligenceRun | null>(null);
  const [activeTab, setActiveTab]   = useState<TabKey>("summary");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [detectedType, setDetectedType] = useState<TrrcIdentifierType>("unknown");

  const [form, setForm] = useState<FormState>({
    query: "",
    county: "",
    district: "",
    inputTypeOverride: "auto",
    searchHistorical: true,
    includeOffsetWells: false,
    productionMonths: 36,
  });

  // Auto-detect input type
  useEffect(() => {
    if (form.query.trim()) {
      setDetectedType(detectInputType(form.query.trim()));
    } else {
      setDetectedType("unknown");
    }
  }, [form.query]);

  // Polling
  useEffect(() => {
    if (!runId || phase !== "running") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/trrc/due-diligence/${runId}`);
        const data = await res.json();
        if (data.ok) {
          setRun(data.data);
          if (data.data.status === "awaiting_selection") {
            setPhase("selecting");
            clearInterval(interval);
          } else if (data.data.status === "complete") {
            setPhase("complete");
            clearInterval(interval);
          } else if (data.data.status === "failed" || data.data.status === "cancelled") {
            setError(data.data.error_summary ?? "The run failed or was cancelled.");
            setPhase("error");
            clearInterval(interval);
          }
        }
      } catch {
        // network hiccup — keep polling
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [runId, phase]);

  const handleSubmit = useCallback(async () => {
    setError(null);
    try {
      const payload = {
        input: form.query.trim(),
        county: form.county.trim() || undefined,
        district: form.district || undefined,
        input_type_override: form.inputTypeOverride === "auto" ? undefined : form.inputTypeOverride,
        search_historical: form.searchHistorical,
        include_offset_wells: form.includeOffsetWells,
        production_months: form.productionMonths,
      };
      const res = await fetch("/api/trrc/due-diligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "Failed to start run");
      const id: string = data.data.id;
      setRunId(id);
      setRun(data.data);
      setPhase("running");
      // Trigger execute
      await fetch(`/api/trrc/due-diligence/${id}/execute`, { method: "POST" });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setPhase("error");
    }
  }, [form]);

  const handleCancel = useCallback(async () => {
    if (runId) {
      await fetch(`/api/trrc/due-diligence/${runId}/cancel`, { method: "POST" }).catch(() => {});
    }
    setRunId(null);
    setRun(null);
    setPhase("form");
    setError(null);
  }, [runId]);

  const handleResolve = useCallback(async (entityId: string) => {
    if (!runId) return;
    try {
      await fetch(`/api/trrc/due-diligence/${runId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_id: entityId }),
      });
      setPhase("running");
      await fetch(`/api/trrc/due-diligence/${runId}/execute`, { method: "POST" });
    } catch {
      setError("Failed to resolve entity selection.");
    }
  }, [runId]);

  const handleReset = useCallback(() => {
    setPhase("form");
    setRunId(null);
    setRun(null);
    setError(null);
    setActiveTab("summary");
  }, []);

  const handleDownload = useCallback(async (type: "report" | "archive" | "manifest") => {
    if (!runId) return;
    window.open(`/api/trrc/due-diligence/${runId}/${type}`, "_blank");
  }, [runId]);

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
            detectedType={detectedType}
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
          />
        )}
      </div>
    </div>
  );
}

// ─── Search Form ───────────────────────────────────────────────────────────────

function SearchForm({
  form, setForm, showAdvanced, setShowAdvanced, detectedType, onSubmit,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  showAdvanced: boolean;
  setShowAdvanced: React.Dispatch<React.SetStateAction<boolean>>;
  detectedType: TrrcIdentifierType;
  onSubmit: () => void;
}) {
  const canSubmit = form.query.trim().length > 0;
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
    fontSize: "0.85rem",
    padding: "0.55rem 0.85rem",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
    ...overrides,
  });

  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 12,
      padding: "1.75rem",
    }}>
      {/* Main search input */}
      <div style={{ marginBottom: "1.25rem" }}>
        <label style={{
          display: "block",
          fontSize: "0.75rem",
          fontWeight: 600,
          color: COLORS.textMuted,
          letterSpacing: "0.06em",
          textTransform: "uppercase" as const,
          marginBottom: "0.5rem",
        }}>
          Enter any identifier
        </label>
        <textarea
          value={form.query}
          onChange={e => setForm(f => ({ ...f, query: e.target.value }))}
          placeholder={"42-151-01734  |  Lease #12345  |  Operator Name  |  P-5 #123456  |  Lease Name"}
          rows={2}
          style={{
            ...inp(),
            resize: "none",
            lineHeight: 1.5,
            fontSize: "1rem",
          }}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) handleRun();
          }}
        />
        {/* Auto-detect badge */}
        {form.query.trim() && (
          <div style={{ marginTop: "0.5rem" }}>
            {detectedType !== "unknown" ? (
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: COLORS.accentDim,
                border: `1px solid ${COLORS.accent}40`,
                borderRadius: 5,
                padding: "0.2rem 0.6rem",
                fontSize: "0.72rem",
                color: COLORS.accent,
                fontWeight: 600,
              }}>
                <span style={{ opacity: 0.7 }}>Detected:</span> {TYPE_LABEL[detectedType]}
              </span>
            ) : (
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: COLORS.yellowDim,
                border: `1px solid ${COLORS.yellow}40`,
                borderRadius: 5,
                padding: "0.2rem 0.6rem",
                fontSize: "0.72rem",
                color: COLORS.yellow,
                fontWeight: 600,
              }}>
                Unable to auto-detect — specify type in Advanced Options
              </span>
            )}
          </div>
        )}
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
          marginBottom: showAdvanced ? "1rem" : 0,
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
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "0.9rem",
          }}>
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

            {/* Input type override */}
            <div>
              <label style={{ display: "block", fontSize: "0.72rem", fontWeight: 600, color: COLORS.textMuted, marginBottom: "0.35rem", letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                Input Type Override
              </label>
              <select
                value={form.inputTypeOverride}
                onChange={e => setForm(f => ({ ...f, inputTypeOverride: e.target.value as TrrcIdentifierType | "auto" }))}
                style={inp({ appearance: "none" } as React.CSSProperties)}
              >
                <option value="auto">Auto-Detect</option>
                {INPUT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
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
        This search queries publicly available TRRC records only. Results are for preliminary screening purposes and do not constitute title verification, reserve engineering, or legal due diligence.
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
  const attempts = run.source_attempts ?? [];
  const manualCount  = attempts.filter(a => a.status === "manual_required").length;
  const successCount = attempts.filter(a => a.status === "success").length;
  const recordCount  = attempts.reduce((s, a) => s + a.result_count, 0);
  const findingCount = (run.findings ?? []).length;

  const stageLabel: Record<string, string> = {
    pending:            "Initializing",
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
              {run.result_summary ?? "Processing your request…"}
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
          {attempts.map(a => (
            <div key={a.source_id} style={{
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              padding: "0.7rem 0.9rem",
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}>
              <span style={{ fontSize: "1rem", lineHeight: 1 }}>{sourceStatusIcon(a.status)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  color: COLORS.text,
                  whiteSpace: "nowrap" as const,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}>
                  {a.source_name}
                </div>
                <div style={{ fontSize: "0.68rem", color: sourceStatusColor(a.status), marginTop: 2 }}>
                  {a.status.replace(/_/g, " ")}
                  {a.result_count > 0 && ` · ${a.result_count} records`}
                </div>
                {a.status === "manual_required" && a.manual_action_url && (
                  <a
                    href={a.manual_action_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-block",
                      marginTop: 4,
                      fontSize: "0.65rem",
                      color: COLORS.yellow,
                      textDecoration: "underline",
                    }}
                  >
                    Open manual URL →
                  </a>
                )}
              </div>
            </div>
          ))}
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

const TABS: { key: TabKey; label: string }[] = [
  { key: "summary",    label: "Summary" },
  { key: "scorecard",  label: "Scorecard" },
  { key: "production", label: "Production" },
  { key: "findings",   label: "Findings" },
  { key: "coverage",   label: "Source Coverage" },
  { key: "missing",    label: "Missing Records" },
];

function ResultsDashboard({
  run, activeTab, setActiveTab, onReset, onDownload,
}: {
  run: TrrcDueDiligenceRun;
  activeTab: TabKey;
  setActiveTab: (t: TabKey) => void;
  onReset: () => void;
  onDownload: (type: "report" | "archive" | "manifest") => void;
}) {
  const sc = run.scorecard;

  return (
    <div>
      {/* Recommendation banner */}
      {sc && <RecommendationBanner scorecard={sc} />}

      {/* Tab bar */}
      <div style={{
        display: "flex",
        gap: 2,
        marginBottom: "1rem",
        borderBottom: `1px solid ${COLORS.border}`,
        overflowX: "auto" as const,
      }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: activeTab === t.key ? `2px solid ${COLORS.accent}` : "2px solid transparent",
              color: activeTab === t.key ? COLORS.accent : COLORS.textMuted,
              fontSize: "0.82rem",
              fontWeight: activeTab === t.key ? 600 : 400,
              padding: "0.6rem 1rem",
              cursor: "pointer",
              whiteSpace: "nowrap" as const,
              transition: "color 0.15s",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "summary"    && <SummaryTab run={run} />}
      {activeTab === "scorecard"  && sc && <ScorecardTab scorecard={sc} />}
      {activeTab === "production" && <ProductionTab run={run} />}
      {activeTab === "findings"   && <FindingsTab run={run} />}
      {activeTab === "coverage"   && <CoverageTab run={run} />}
      {activeTab === "missing"    && <MissingTab run={run} />}

      {/* Downloads */}
      <div style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: "1.25rem 1.5rem",
        marginTop: "1rem",
      }}>
        <div style={{
          fontSize: "0.75rem",
          fontWeight: 700,
          color: COLORS.textMuted,
          textTransform: "uppercase" as const,
          letterSpacing: "0.1em",
          marginBottom: "0.85rem",
        }}>
          Downloads
        </div>
        <div style={{ display: "flex", gap: "0.65rem", flexWrap: "wrap" as const }}>
          {([
            { type: "report" as const,   label: "Download PDF Report" },
            { type: "archive" as const,  label: "Download ZIP Archive" },
            { type: "manifest" as const, label: "Download JSON Manifest" },
          ]).map(({ type, label }) => (
            <button key={type} onClick={() => onDownload(type)} style={{
              background: COLORS.surfaceAlt,
              border: `1px solid ${COLORS.borderStrong}`,
              borderRadius: 7,
              color: COLORS.text,
              fontSize: "0.8rem",
              fontWeight: 500,
              padding: "0.5rem 1rem",
              cursor: "pointer",
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* New search */}
      <div style={{ marginTop: "1rem", textAlign: "center" as const }}>
        <button onClick={onReset} style={{
          background: "transparent",
          border: `1px solid ${COLORS.border}`,
          borderRadius: 7,
          color: COLORS.textMuted,
          fontSize: "0.8rem",
          padding: "0.5rem 1.25rem",
          cursor: "pointer",
        }}>
          New Search
        </button>
      </div>
    </div>
  );
}

// ─── Recommendation Banner ─────────────────────────────────────────────────────

function RecommendationBanner({ scorecard }: { scorecard: NonNullable<TrrcDueDiligenceRun["scorecard"]> }) {
  const c = recColor(scorecard.recommendation);
  return (
    <div style={{
      background: c.bg,
      border: `1px solid ${c.border}40`,
      borderRadius: 10,
      padding: "1.25rem 1.5rem",
      marginBottom: "1rem",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      flexWrap: "wrap" as const,
      gap: 12,
    }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <span style={{
            fontSize: "1.1rem",
            fontWeight: 800,
            color: c.color,
            letterSpacing: "0.05em",
          }}>
            {scorecard.recommendation}
          </span>
          <Pill bg={c.bg} color={c.color}>
            Opportunity {scorecard.opportunity_score}/100
          </Pill>
          <Pill bg={COLORS.redDim} color={COLORS.red}>
            Risk {scorecard.risk_score}/100
          </Pill>
          <Pill bg={COLORS.accentDim} color={COLORS.accent}>
            Confidence {scorecard.overall_confidence}%
          </Pill>
        </div>
        {scorecard.gating_conditions.length > 0 && (
          <div style={{ fontSize: "0.78rem", color: COLORS.textMuted }}>
            <span style={{ fontWeight: 600, color: COLORS.yellow }}>Gating conditions: </span>
            {scorecard.gating_conditions.join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Summary Tab ───────────────────────────────────────────────────────────────

function SummaryTab({ run }: { run: TrrcDueDiligenceRun }) {
  const critHighFindings = (run.findings ?? []).filter(f => f.severity === "critical" || f.severity === "high");
  const manualCount = (run.source_attempts ?? []).filter(a => a.status === "manual_required").length;
  const totalRecords = (run.source_attempts ?? []).reduce((s, a) => s + a.result_count, 0);

  return (
    <div>
      <SectionCard title="Asset Identity" icon="🏷">
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "0.75rem",
        }}>
          {[
            { label: "API Number",      value: run.resolved_primary_api },
            { label: "Lease Number",    value: run.resolved_lease_number },
            { label: "Gas Well ID",     value: run.resolved_gas_id },
            { label: "TRRC District",   value: run.resolved_district },
            { label: "Operator #",      value: run.resolved_operator_number },
            { label: "Original Input",  value: run.original_input },
          ].map(({ label, value }) => (
            <div key={label} style={{
              background: COLORS.surfaceAlt,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 7,
              padding: "0.65rem 0.85rem",
            }}>
              <div style={{ fontSize: "0.68rem", color: COLORS.textMuted, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" as const, marginBottom: 4 }}>
                {label}
              </div>
              <div style={{ fontSize: "0.85rem", color: value ? COLORS.text : COLORS.textFaint, fontWeight: value ? 600 : 400 }}>
                {value ?? "—"}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Quick Stats" icon="📊">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.75rem" }}>
          {[
            { label: "Total Records", value: totalRecords },
            { label: "Manual Required", value: manualCount },
            { label: "Total Findings", value: (run.findings ?? []).length },
          ].map(({ label, value }) => (
            <div key={label} style={{
              background: COLORS.surfaceAlt,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 7,
              padding: "0.85rem 1rem",
              textAlign: "center" as const,
            }}>
              <div style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.text }}>{value}</div>
              <div style={{ fontSize: "0.68rem", color: COLORS.textMuted, marginTop: 3, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{label}</div>
            </div>
          ))}
        </div>
      </SectionCard>

      {critHighFindings.length > 0 && (
        <SectionCard title="Critical & High Severity Findings" icon="⚠">
          <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.6rem" }}>
            {critHighFindings.map(f => (
              <FindingCard key={f.id} finding={f} compact />
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ─── Scorecard Tab ─────────────────────────────────────────────────────────────

function ScorecardTab({ scorecard }: { scorecard: NonNullable<TrrcDueDiligenceRun["scorecard"]> }) {
  const dims = scorecard.dimensions;
  const dimList: [string, ScoreDimension][] = Object.entries(dims) as [string, ScoreDimension][];

  return (
    <div>
      {/* Overall scores */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "0.75rem",
        marginBottom: "1rem",
      }}>
        {[
          { label: "Opportunity Score", value: scorecard.opportunity_score, color: COLORS.green },
          { label: "Risk Score",        value: scorecard.risk_score,        color: COLORS.red },
          { label: "Confidence",        value: scorecard.overall_confidence, color: COLORS.accent },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            padding: "1.1rem 1.25rem",
            textAlign: "center" as const,
          }}>
            <div style={{ fontSize: "2.25rem", fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
            <div style={{ fontSize: "0.68rem", color: COLORS.textMuted, marginTop: 5, textTransform: "uppercase" as const, letterSpacing: "0.07em" }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Dimensions grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: "0.75rem",
        marginBottom: "1rem",
      }}>
        {dimList.map(([key, dim]) => (
          <DimensionCard key={key} dim={dim} />
        ))}
      </div>

      {/* Reasons for / against */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <SectionCard title="Reasons For" icon="✅">
          {scorecard.reasons_for.length === 0
            ? <p style={{ color: COLORS.textFaint, fontSize: "0.8rem", margin: 0 }}>None identified.</p>
            : <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                {scorecard.reasons_for.map((r, i) => (
                  <li key={i} style={{ fontSize: "0.82rem", color: COLORS.text, marginBottom: 5, lineHeight: 1.5 }}>{r}</li>
                ))}
              </ul>
          }
        </SectionCard>
        <SectionCard title="Reasons Against" icon="❌">
          {scorecard.reasons_against.length === 0
            ? <p style={{ color: COLORS.textFaint, fontSize: "0.8rem", margin: 0 }}>None identified.</p>
            : <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                {scorecard.reasons_against.map((r, i) => (
                  <li key={i} style={{ fontSize: "0.82rem", color: COLORS.text, marginBottom: 5, lineHeight: 1.5 }}>{r}</li>
                ))}
              </ul>
          }
        </SectionCard>
      </div>
    </div>
  );
}

function DimensionCard({ dim }: { dim: ScoreDimension }) {
  const scoreColor = dim.score >= 70 ? COLORS.green : dim.score >= 40 ? COLORS.yellow : COLORS.red;
  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 9,
      padding: "1rem 1.1rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: "0.78rem", fontWeight: 600, color: COLORS.textMuted }}>{dim.label}</div>
        <div style={{ fontSize: "1rem", fontWeight: 700, color: scoreColor }}>{dim.score}</div>
      </div>
      {/* Score bar */}
      <div style={{ height: 4, background: COLORS.surfaceAlt, borderRadius: 99, marginBottom: 8 }}>
        <div style={{
          height: "100%",
          width: `${dim.score}%`,
          background: scoreColor,
          borderRadius: 99,
          transition: "width 0.5s ease",
        }} />
      </div>
      <div style={{ fontSize: "0.72rem", color: COLORS.textFaint, lineHeight: 1.5 }}>{dim.rationale}</div>
      <div style={{ fontSize: "0.65rem", color: COLORS.textFaint, marginTop: 4 }}>
        Weight: {(dim.weight * 100).toFixed(0)}%
      </div>
    </div>
  );
}

// ─── Production Tab ────────────────────────────────────────────────────────────

function ProductionTab({ run }: { run: TrrcDueDiligenceRun }) {
  const rows = run.production ?? [];
  const isLease = rows.some(r => r.entity_type === "lease");

  if (rows.length === 0) {
    return (
      <SectionCard title="Production History" icon="📈">
        <p style={{ color: COLORS.textFaint, fontSize: "0.85rem", margin: 0 }}>No production data available.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Production History" icon="📈">
      {isLease && (
        <div style={{
          background: COLORS.yellowDim,
          border: `1px solid ${COLORS.yellow}30`,
          borderRadius: 6,
          padding: "0.5rem 0.85rem",
          fontSize: "0.75rem",
          color: COLORS.yellow,
          marginBottom: "0.85rem",
        }}>
          Reported at lease level — multiple wells may share this production.
        </div>
      )}
      <DdTable
        headers={["Month", "Oil (bbl)", "Casing Gas (MCF)", "Gas (MCF)", "Condensate (bbl)", "Water (bbl)"]}
        rows={rows.map(r => [
          r.production_month,
          r.oil_bbl != null ? r.oil_bbl.toLocaleString() : null,
          r.casinghead_gas_mcf != null ? r.casinghead_gas_mcf.toLocaleString() : null,
          r.gas_mcf != null ? r.gas_mcf.toLocaleString() : null,
          r.condensate_bbl != null ? r.condensate_bbl.toLocaleString() : null,
          r.water_bbl != null ? r.water_bbl.toLocaleString() : null,
        ])}
      />
    </SectionCard>
  );
}

// ─── Findings Tab ──────────────────────────────────────────────────────────────

const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

function FindingsTab({ run }: { run: TrrcDueDiligenceRun }) {
  const findings = run.findings ?? [];

  if (findings.length === 0) {
    return (
      <SectionCard title="Findings" icon="🔍">
        <p style={{ color: COLORS.textFaint, fontSize: "0.85rem", margin: 0 }}>No findings generated.</p>
      </SectionCard>
    );
  }

  return (
    <div>
      {SEVERITY_ORDER.map(sev => {
        const group = findings.filter(f => f.severity === sev);
        if (group.length === 0) return null;
        return (
          <div key={sev} style={{ marginBottom: "1.25rem" }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: "0.6rem",
              paddingBottom: "0.4rem",
              borderBottom: `1px solid ${COLORS.border}`,
            }}>
              <div style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: severityColor(sev),
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: "0.78rem",
                fontWeight: 700,
                color: severityColor(sev),
                textTransform: "uppercase" as const,
                letterSpacing: "0.08em",
              }}>
                {sev} ({group.length})
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.65rem" }}>
              {group.map(f => <FindingCard key={f.id} finding={f} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FindingCard({ finding, compact = false }: { finding: TrrcFinding; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      background: COLORS.surface,
      border: `1px solid ${severityColor(finding.severity)}30`,
      borderLeft: `3px solid ${severityColor(finding.severity)}`,
      borderRadius: 8,
      padding: compact ? "0.75rem 1rem" : "0.9rem 1.1rem",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: "0.85rem", fontWeight: 600, color: COLORS.text }}>{finding.title}</div>
        <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
          <Pill bg={severityBg(finding.severity)} color={severityColor(finding.severity)}>
            {finding.severity}
          </Pill>
          <Pill
            bg={finding.is_directly_reported ? COLORS.greenDim : COLORS.purpleDim}
            color={finding.is_directly_reported ? COLORS.green : COLORS.purple}
          >
            {finding.is_directly_reported ? "Direct" : "Inferred"}
          </Pill>
        </div>
      </div>

      <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.78rem", color: COLORS.textMuted, lineHeight: 1.55 }}>
        {finding.description}
      </p>

      {!compact && (
        <>
          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              background: "transparent",
              border: "none",
              color: COLORS.accent,
              fontSize: "0.72rem",
              padding: 0,
              cursor: "pointer",
            }}
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
          {expanded && (
            <div style={{ marginTop: "0.6rem" }}>
              {Object.keys(finding.evidence).length > 0 && (
                <div style={{
                  background: COLORS.surfaceAlt,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  padding: "0.5rem 0.75rem",
                  fontSize: "0.72rem",
                  color: COLORS.textMuted,
                  fontFamily: "monospace",
                  marginBottom: "0.5rem",
                  overflowX: "auto" as const,
                }}>
                  {JSON.stringify(finding.evidence, null, 2)}
                </div>
              )}
              <div style={{ fontSize: "0.75rem", color: COLORS.textMuted }}>
                <span style={{ fontWeight: 600, color: COLORS.text }}>Recommended: </span>
                {finding.recommended_action}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Source Coverage Tab ───────────────────────────────────────────────────────

function CoverageTab({ run }: { run: TrrcDueDiligenceRun }) {
  const coverage: SourceCoverageStatus[] = run.coverage ?? [];

  return (
    <SectionCard title="Source Coverage" icon="📡">
      <DdTable
        headers={["Source", "Status", "Records", "Data Through", "Notes"]}
        rows={coverage.map(c => [
          <span key="label" style={{ fontWeight: 500, color: COLORS.text }}>{c.label}</span>,
          <span key="status" style={{ color: coverageStatusColor(c.status), fontWeight: 600, fontSize: "0.72rem", textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
            {c.status.replace(/_/g, " ")}
          </span>,
          c.records_found > 0 ? String(c.records_found) : null,
          c.data_current_through ?? null,
          c.notes ?? null,
        ])}
      />
      {coverage.length === 0 && (
        <p style={{ color: COLORS.textFaint, fontSize: "0.8rem", margin: 0 }}>No coverage data available.</p>
      )}
    </SectionCard>
  );
}

// ─── Missing Records Tab ───────────────────────────────────────────────────────

const MISSING_STATUS_LABELS: Record<TrrcMissingItem["status"], string> = {
  confirmed_no_record: "Confirmed No Record",
  no_result_from_query: "No Results Found",
  retrieval_failed: "Retrieval Failed",
  source_unavailable: "Source Unavailable",
  manual_required: "Manual Required",
  outside_date_range: "Outside Date Range",
};

function MissingTab({ run }: { run: TrrcDueDiligenceRun }) {
  const items: TrrcMissingItem[] = run.missing_items ?? [];

  return (
    <SectionCard title="Missing Records" icon="📭">
      <DdTable
        headers={["Type", "Category", "Status", "Action"]}
        rows={items.map(item => [
          <span key="type" style={{ fontWeight: 500 }}>{item.expected_record_type}</span>,
          <span key="cat" style={{ fontSize: "0.72rem", color: COLORS.textMuted, textTransform: "capitalize" as const }}>
            {item.category.replace(/_/g, " ")}
          </span>,
          <span key="status" style={{
            color: item.status === "confirmed_no_record" ? COLORS.textFaint
                 : item.status === "manual_required"     ? COLORS.yellow
                 : item.status === "retrieval_failed"    ? COLORS.red
                 : COLORS.textMuted,
            fontSize: "0.72rem",
            fontWeight: 600,
          }}>
            {MISSING_STATUS_LABELS[item.status]}
          </span>,
          item.manual_retrieval_url ? (
            <a
              key="url"
              href={item.manual_retrieval_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: COLORS.accent, fontSize: "0.75rem", textDecoration: "underline" }}
            >
              Retrieve manually →
            </a>
          ) : (
            <span key="nourl" style={{ fontSize: "0.75rem", color: COLORS.textFaint }}>{item.recommended_action}</span>
          ),
        ])}
      />
      {items.length === 0 && (
        <p style={{ color: COLORS.textFaint, fontSize: "0.8rem", margin: 0 }}>No missing items recorded.</p>
      )}
    </SectionCard>
  );
}
