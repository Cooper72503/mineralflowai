"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { STAGE_LABELS } from "@/app/components/DealStageSelector";

const STAGE_ORDER = [
  "new_lead",
  "screening",
  "pursuing",
  "under_loi",
  "due_diligence",
  "closed_won",
  "closed_lost",
  "passed",
] as const;

const STAGE_COLORS: Record<string, { header: string; border: string; card: string }> = {
  new_lead:      { header: "#f3f4f6", border: "#d1d5db",  card: "#ffffff" },
  screening:     { header: "#eff6ff", border: "#bfdbfe",  card: "#ffffff" },
  pursuing:      { header: "#ecfdf5", border: "#6ee7b7",  card: "#ffffff" },
  under_loi:     { header: "#fef3c7", border: "#fcd34d",  card: "#fffbeb" },
  due_diligence: { header: "#fef9c3", border: "#fde047",  card: "#fffbeb" },
  closed_won:    { header: "#dcfce7", border: "#86efac",  card: "#f0fdf4" },
  closed_lost:   { header: "#fee2e2", border: "#fca5a5",  card: "#fef2f2" },
  passed:        { header: "#f1f5f9", border: "#cbd5e1",  card: "#f8fafc" },
};

type Deal = {
  id: string;
  file_name: string | null;
  county: string | null;
  state: string | null;
  deal_stage: string;
  created_at: string;
};

export default function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const dragOver = useRef<string | null>(null);

  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data, error: err } = await supabase
        .from("documents")
        .select("id, file_name, county, state, deal_stage, created_at")
        .order("created_at", { ascending: false });
      if (err) {
        // If deal_stage column doesn't exist yet, fall back to loading without it
        if (err.message?.includes("deal_stage")) {
          const { data: fallback, error: fallbackErr } = await supabase
            .from("documents")
            .select("id, file_name, county, state, created_at")
            .order("created_at", { ascending: false });
          if (fallbackErr) { setError("Failed to load deals."); }
          else {
            setDeals((fallback ?? []).map((d) => ({ ...d, deal_stage: "new_lead" })));
            setError("⚠ Pipeline stages need a one-time database migration. Run the SQL in frontend/supabase/migrations/20260410_deal_pipeline.sql in your Supabase dashboard to enable drag-and-drop staging.");
          }
        } else {
          setError("Failed to load deals.");
        }
      } else {
        setDeals(data ?? []);
      }
      setLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byStage = STAGE_ORDER.reduce<Record<string, Deal[]>>((acc, s) => {
    acc[s] = deals.filter((d) => (d.deal_stage ?? "new_lead") === s);
    return acc;
  }, {});

  const activeCount = (byStage.pursuing?.length ?? 0)
    + (byStage.under_loi?.length ?? 0)
    + (byStage.due_diligence?.length ?? 0);

  async function moveDeal(dealId: string, newStage: string) {
    setSaving(dealId);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    try {
      await fetch(`/api/documents/${dealId}/stage`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ stage: newStage }),
      });
      setDeals((prev) =>
        prev.map((d) => d.id === dealId ? { ...d, deal_stage: newStage } : d)
      );
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <div className="container">
        <div className="pageHeader"><h1>Pipeline</h1></div>
        <p style={{ color: "#9ca3af" }}>Loading deals…</p>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Pipeline</h1>
        <p>
          {deals.length} deal{deals.length !== 1 ? "s" : ""} total
          {activeCount > 0 ? ` · ${activeCount} active (Pursuing / LOI / Diligence)` : ""}
        </p>
      </div>

      {error && <p style={{ color: "#dc2626", marginBottom: "1rem" }}>{error}</p>}

      <div style={{
        display: "flex",
        gap: "0.75rem",
        overflowX: "auto",
        paddingBottom: "1rem",
        alignItems: "flex-start",
      }}>
        {STAGE_ORDER.map((stage) => {
          const cols = STAGE_COLORS[stage];
          const stageDeals = byStage[stage] ?? [];
          return (
            <div
              key={stage}
              onDragOver={(e) => { e.preventDefault(); dragOver.current = stage; }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging && dragging !== stage) moveDeal(dragging, stage);
                setDragging(null);
                dragOver.current = null;
              }}
              style={{
                minWidth: 200,
                maxWidth: 220,
                flexShrink: 0,
                border: `1px solid ${cols.border}`,
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {/* Column header */}
              <div style={{
                padding: "0.5rem 0.75rem",
                background: cols.header,
                borderBottom: `1px solid ${cols.border}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}>
                <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#374151" }}>
                  {STAGE_LABELS[stage]}
                </span>
                <span style={{
                  fontSize: "0.72rem", fontWeight: 600,
                  background: "rgba(0,0,0,0.08)",
                  padding: "0.1rem 0.4rem", borderRadius: 10,
                  color: "#374151",
                }}>
                  {stageDeals.length}
                </span>
              </div>

              {/* Cards */}
              <div style={{
                padding: "0.5rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                minHeight: 80,
                maxHeight: "70vh",
                overflowY: "auto",
                background: "#fafafa",
              }}>
                {stageDeals.length === 0 ? (
                  <p style={{ fontSize: "0.75rem", color: "#d1d5db", margin: "0.25rem 0", textAlign: "center" }}>
                    Drop here
                  </p>
                ) : (
                  stageDeals.map((deal) => (
                    <div
                      key={deal.id}
                      draggable
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => { setDragging(null); dragOver.current = null; }}
                      style={{
                        background: cols.card,
                        border: `1px solid ${cols.border}`,
                        borderRadius: 6,
                        padding: "0.5rem 0.6rem",
                        cursor: "grab",
                        opacity: saving === deal.id ? 0.5 : dragging === deal.id ? 0.4 : 1,
                        transition: "opacity 0.15s",
                      }}
                    >
                      <Link
                        href={`/documents/${deal.id}`}
                        style={{ textDecoration: "none", color: "inherit" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p style={{ margin: "0 0 0.2rem", fontSize: "0.82rem", fontWeight: 600, color: "#111827", lineHeight: 1.3 }}>
                          {deal.file_name ?? "Untitled"}
                        </p>
                        {(deal.county || deal.state) && (
                          <p style={{ margin: 0, fontSize: "0.74rem", color: "#6b7280" }}>
                            {[deal.county, deal.state].filter(Boolean).join(", ")}
                          </p>
                        )}
                      </Link>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: "0.78rem", color: "#9ca3af", marginTop: "0.5rem" }}>
        Drag cards between columns to update deal stage. Changes save automatically.
      </p>
    </div>
  );
}
