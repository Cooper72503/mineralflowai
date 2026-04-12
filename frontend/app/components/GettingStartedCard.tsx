"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

const DISMISSED_KEY = "mineral_onboarding_dismissed";

type Step = {
  id: string;
  label: string;
  description: string;
  href: string;
  linkLabel: string;
  done: boolean;
};

export function GettingStartedCard() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const supabase = createClient();

  useEffect(() => {
    // Check localStorage for dismiss
    if (typeof window !== "undefined") {
      if (localStorage.getItem(DISMISSED_KEY) === "1") {
        setDismissed(true);
        setLoaded(true);
        return;
      }
    }

    async function load() {
      // Step 1: any documents at all?
      const { count: docCount } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true });

      // Step 2: any document processed?
      const { count: processedCount } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .not("processed_at", "is", null);

      // Step 3: any document moved out of new_lead? (graceful if column missing)
      let movedCount = 0;
      try {
        const { count } = await supabase
          .from("documents")
          .select("id", { count: "exact", head: true })
          .not("deal_stage", "eq", "new_lead");
        movedCount = count ?? 0;
      } catch {
        // deal_stage column not yet migrated — treat as not done
      }

      const built: Step[] = [
        {
          id: "upload",
          label: "Upload your first document",
          description: "Drop a lease, title opinion, or deed to get started.",
          href: "/upload",
          linkLabel: "Go to Upload →",
          done: (docCount ?? 0) > 0,
        },
        {
          id: "process",
          label: "Process a document",
          description: "Run AI extraction to score and analyze a deal.",
          href: "/documents",
          linkLabel: "View Documents →",
          done: (processedCount ?? 0) > 0,
        },
        {
          id: "pipeline",
          label: "Move a deal in the Pipeline",
          description: "Drag a card to update its stage in your Kanban board.",
          href: "/pipeline",
          linkLabel: "Open Pipeline →",
          done: movedCount > 0,
        },
      ];

      setSteps(built);
      setLoaded(true);
    }

    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss() {
    if (typeof window !== "undefined") {
      localStorage.setItem(DISMISSED_KEY, "1");
    }
    setDismissed(true);
  }

  if (!loaded || dismissed) return null;

  const allDone = steps.every((s) => s.done);
  const completedCount = steps.filter((s) => s.done).length;

  // Auto-dismiss if everything is done and they've been here a while —
  // or just show a completion state
  return (
    <div
      className="card"
      style={{
        marginBottom: "1.5rem",
        border: "1px solid #bfdbfe",
        background: "linear-gradient(135deg, #eff6ff 0%, #f8faff 100%)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "0.875rem",
        }}
      >
        <div>
          <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.2rem", color: "#1e40af" }}>
            {allDone ? "🎉 You're all set!" : "Getting started"}
          </h2>
          <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: 0 }}>
            {allDone
              ? "You've completed all the setup steps."
              : `${completedCount} of ${steps.length} steps complete`}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          style={{
            background: "none",
            border: "none",
            color: "#9ca3af",
            cursor: "pointer",
            fontSize: "1.1rem",
            lineHeight: 1,
            padding: "0.1rem 0.25rem",
          }}
        >
          ✕
        </button>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 4,
          background: "#dbeafe",
          borderRadius: 99,
          marginBottom: "1rem",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${(completedCount / steps.length) * 100}%`,
            height: "100%",
            background: "#2563eb",
            borderRadius: 99,
            transition: "width 0.4s",
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {steps.map((step, i) => (
          <div
            key={step.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.75rem",
              padding: "0.6rem 0.75rem",
              background: step.done ? "#f0fdf4" : "#fff",
              border: `1px solid ${step.done ? "#bbf7d0" : "#e5e7eb"}`,
              borderRadius: 8,
            }}
          >
            {/* Step number / check */}
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: step.done ? "#16a34a" : "#e5e7eb",
                color: step.done ? "#fff" : "#9ca3af",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.75rem",
                fontWeight: 700,
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              {step.done ? "✓" : i + 1}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  margin: "0 0 0.1rem",
                  fontSize: "0.88rem",
                  fontWeight: 600,
                  color: step.done ? "#15803d" : "#111827",
                  textDecoration: step.done ? "line-through" : "none",
                }}
              >
                {step.label}
              </p>
              {!step.done && (
                <p style={{ margin: "0 0 0.3rem", fontSize: "0.78rem", color: "#6b7280" }}>
                  {step.description}
                </p>
              )}
              {!step.done && (
                <Link
                  href={step.href}
                  style={{
                    fontSize: "0.78rem",
                    color: "#2563eb",
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
                  {step.linkLabel}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
