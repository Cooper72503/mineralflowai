"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Step = {
  id: string;
  label: string;
  description: string;
  href: string;
  linkLabel: string;
  done: boolean;
};

function dismissedKey(userId: string) {
  return `mineral_onboarding_dismissed_${userId}`;
}

export function GettingStartedCard({ welcome }: { welcome?: boolean }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("");

  const supabase = createClient();

  useEffect(() => {
    async function load() {
      // Get user first so we can key dismissed state per user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoaded(true); return; }

      setUserId(user.id);
      const name =
        (user.user_metadata?.full_name as string | undefined) ??
        (user.user_metadata?.name as string | undefined) ??
        user.email?.split("@")[0] ??
        "";
      setDisplayName(name);

      // Per-user dismissed check
      if (typeof window !== "undefined") {
        if (localStorage.getItem(dismissedKey(user.id)) === "1") {
          setDismissed(true);
          setLoaded(true);
          return;
        }
      }

      // Step 1: any documents uploaded?
      const { count: docCount } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true });

      // Step 2: any document processed?
      const { count: processedCount } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .not("processed_at", "is", null);

      // Step 3: any document moved out of new_lead?
      let movedCount = 0;
      try {
        const { count } = await supabase
          .from("documents")
          .select("id", { count: "exact", head: true })
          .not("deal_stage", "eq", "new_lead");
        movedCount = count ?? 0;
      } catch {
        // deal_stage column not yet migrated
      }

      const built: Step[] = [
        {
          id: "upload",
          label: "Begin your first underwriting",
          description: "Enter an API number, operator, or upload LOE statements to generate institutional-grade diligence.",
          href: "/underwriting",
          linkLabel: "MineralFlow Underwriting →",
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
    if (typeof window !== "undefined" && userId) {
      localStorage.setItem(dismissedKey(userId), "1");
    }
    setDismissed(true);
  }

  if (!loaded || dismissed) return null;

  const allDone = steps.every((s) => s.done);
  const completedCount = steps.filter((s) => s.done).length;
  const isNewUser = completedCount === 0;

  return (
    <div
      className="card"
      style={{
        marginBottom: "1.5rem",
        border: "1px solid #bfdbfe",
        background: "linear-gradient(135deg, #eff6ff 0%, #f8faff 100%)",
        padding: "1.5rem",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1rem" }}>
        <div>
          {(welcome || isNewUser) ? (
            <>
              <h2 style={{ fontSize: "1.2rem", fontWeight: 700, margin: "0 0 0.3rem", color: "#1e40af" }}>
                👋 Welcome to Mineral Flow AI{displayName ? `, ${displayName}` : ""}!
              </h2>
              <p style={{ fontSize: "0.88rem", color: "#3b82f6", margin: 0 }}>
                The fastest way to screen, score, and manage mineral rights deals. Let&apos;s get you set up in 3 steps.
              </p>
            </>
          ) : allDone ? (
            <>
              <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.2rem", color: "#1e40af" }}>
                🎉 You&apos;re all set!
              </h2>
              <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: 0 }}>
                You&apos;ve completed all the setup steps.
              </p>
            </>
          ) : (
            <>
              <h2 style={{ fontSize: "1rem", fontWeight: 700, margin: "0 0 0.2rem", color: "#1e40af" }}>
                Getting started
              </h2>
              <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: 0 }}>
                {completedCount} of {steps.length} steps complete
              </p>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1, padding: "0.1rem 0.25rem", flexShrink: 0 }}
        >
          ✕
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: "#dbeafe", borderRadius: 99, marginBottom: "1rem", overflow: "hidden" }}>
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

      {/* Steps */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {steps.map((step, i) => (
          <div
            key={step.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.75rem",
              padding: "0.65rem 0.75rem",
              background: step.done ? "#f0fdf4" : "#fff",
              border: `1px solid ${step.done ? "#bbf7d0" : "#e5e7eb"}`,
              borderRadius: 8,
            }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                background: step.done ? "#16a34a" : "#e5e7eb",
                color: step.done ? "#fff" : "#9ca3af",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.8rem",
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
                  fontSize: "0.9rem",
                  fontWeight: 600,
                  color: step.done ? "#15803d" : "#111827",
                  textDecoration: step.done ? "line-through" : "none",
                }}
              >
                {step.label}
              </p>
              {!step.done && (
                <p style={{ margin: "0 0 0.35rem", fontSize: "0.78rem", color: "#6b7280" }}>
                  {step.description}
                </p>
              )}
              {!step.done && (
                <Link
                  href={step.href}
                  style={{ fontSize: "0.82rem", color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
                >
                  {step.linkLabel}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* New user quick-start tip */}
      {isNewUser && (
        <p style={{ margin: "1rem 0 0", fontSize: "0.78rem", color: "#6b7280", textAlign: "center" }}>
          Start by uploading a lease, deed, or title opinion — AI extracts the key terms in seconds.
        </p>
      )}
    </div>
  );
}
