"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export const STAGE_LABELS: Record<string, string> = {
  new_lead:      "New Lead",
  screening:     "Screening",
  pursuing:      "Pursuing",
  under_loi:     "Under LOI",
  due_diligence: "Due Diligence",
  closed_won:    "Closed ✓",
  closed_lost:   "Closed ✗",
  passed:        "Passed",
};

const STAGE_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  new_lead:      { bg: "#f3f4f6", color: "#374151", border: "#d1d5db" },
  screening:     { bg: "#eff6ff", color: "#1e40af", border: "#bfdbfe" },
  pursuing:      { bg: "#ecfdf5", color: "#065f46", border: "#6ee7b7" },
  under_loi:     { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  due_diligence: { bg: "#fef9c3", color: "#713f12", border: "#fde047" },
  closed_won:    { bg: "#dcfce7", color: "#14532d", border: "#86efac" },
  closed_lost:   { bg: "#fee2e2", color: "#7f1d1d", border: "#fca5a5" },
  passed:        { bg: "#f1f5f9", color: "#475569", border: "#cbd5e1" },
};

type Props = {
  documentId: string;
  currentStage?: string | null;
  onStageChange?: (stage: string) => void;
};

export function DealStageSelector({ documentId, currentStage, onStageChange }: Props) {
  const [stage, setStage] = useState(currentStage ?? "new_lead");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);

  const supabase = createClient();

  // Fetch current stage independently — avoids crashing the parent page query
  // when deal_stage column doesn't exist yet (migration not yet run).
  useEffect(() => {
    if (currentStage != null) return; // already provided by parent
    supabase
      .from("documents")
      .select("deal_stage")
      .eq("id", documentId)
      .maybeSingle()
      .then(({ data, error: err }) => {
        if (err) {
          // Column doesn't exist yet — silently hide the selector
          setMigrationMissing(true);
          return;
        }
        if (data?.deal_stage) setStage(data.deal_stage as string);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  if (migrationMissing) return null;

  async function handleChange(newStage: string) {
    setSaving(true);
    setError(null);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;

    try {
      const res = await fetch(`/api/documents/${documentId}/stage`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ stage: newStage }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Failed to update stage.");
        return;
      }
      setStage(newStage);
      onStageChange?.(newStage);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const colors = STAGE_COLORS[stage] ?? STAGE_COLORS.new_lead;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <select
          value={stage}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saving}
          style={{
            padding: "0.3rem 0.6rem",
            fontSize: "0.82rem",
            fontWeight: 600,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            background: colors.bg,
            color: colors.color,
            cursor: "pointer",
            appearance: "auto",
          }}
        >
          {Object.entries(STAGE_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
        {saving && (
          <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>Saving…</span>
        )}
      </div>
      {error && <p style={{ fontSize: "0.75rem", color: "#dc2626", margin: 0 }}>{error}</p>}
    </div>
  );
}
