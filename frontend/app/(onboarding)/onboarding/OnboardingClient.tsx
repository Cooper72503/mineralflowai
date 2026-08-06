"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { TRIAL_DAYS } from "@/lib/trial/trial-status";

const FEATURES = [
  { icon: "⚡", label: "Instant legal-description screening" },
  { icon: "🛢️", label: "Nearby well intelligence with real well data" },
  { icon: "📊", label: "Pre-underwriting valuation & deal scoring" },
  { icon: "📄", label: "PDF export for every screen result" },
  { icon: "📈", label: "Arps decline-curve analysis & multi-scenario PV-10/PV-15" },
  { icon: "🗺️", label: "PLSS parcel maps & basin activity overlays" },
];

export function OnboardingClient({ email }: { email: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleActivate() {
    setError(null);
    setLoading(true);
    try {
      const supabase = createClient();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const res = await fetch("/api/activate-trial", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      const body = await res.json() as { ok: boolean; error?: string };
      if (!body.ok) {
        setError(body.error ?? "Activation failed. Please try again.");
        return;
      }

      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      width: "100%",
      maxWidth: 480,
      background: "#ffffff",
      borderRadius: 16,
      padding: "2.5rem 2rem",
      boxShadow: "0 25px 60px rgba(0,0,0,0.4)",
    }}>
      {/* Logo / brand */}
      <div style={{ textAlign: "center", marginBottom: "1.75rem" }}>
        <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>⛏️</div>
        <h1 style={{ fontSize: "1.55rem", fontWeight: 800, color: "#0f172a", margin: 0 }}>
          MineralFlow AI
        </h1>
        <p style={{ fontSize: "0.88rem", color: "#6b7280", marginTop: "0.35rem" }}>
          Welcome, {email}
        </p>
      </div>

      {/* Trial headline */}
      <div style={{
        background: "linear-gradient(135deg, #1e3a5f, #2563eb)",
        borderRadius: 12,
        padding: "1.25rem 1.5rem",
        marginBottom: "1.5rem",
        textAlign: "center",
        color: "#fff",
      }}>
        <div style={{ fontSize: "2rem", fontWeight: 900, letterSpacing: "-0.02em" }}>
          {TRIAL_DAYS}-Day Free Trial
        </div>
        <div style={{ fontSize: "0.88rem", opacity: 0.85, marginTop: "0.3rem" }}>
          Full access. No credit card required.
        </div>
      </div>

      {/* Feature list */}
      <ul style={{ listStyle: "none", margin: "0 0 1.75rem", padding: 0, display: "flex", flexDirection: "column", gap: "0.55rem" }}>
        {FEATURES.map(({ icon, label }) => (
          <li key={label} style={{ display: "flex", alignItems: "center", gap: "0.65rem", fontSize: "0.88rem", color: "#374151" }}>
            <span style={{ fontSize: "1rem", flexShrink: 0 }}>{icon}</span>
            {label}
          </li>
        ))}
      </ul>

      {error && (
        <p style={{ color: "#dc2626", fontSize: "0.85rem", marginBottom: "0.75rem", textAlign: "center" }}>
          {error}
        </p>
      )}

      {/* CTA */}
      <button
        onClick={handleActivate}
        disabled={loading}
        style={{
          width: "100%",
          padding: "0.85rem",
          borderRadius: 10,
          border: "none",
          background: loading ? "#93c5fd" : "#2563eb",
          color: "#fff",
          fontSize: "1rem",
          fontWeight: 700,
          cursor: loading ? "not-allowed" : "pointer",
          letterSpacing: "0.01em",
          transition: "background 0.15s",
        }}
      >
        {loading ? "Activating…" : `Start My ${TRIAL_DAYS}-Day Free Trial →`}
      </button>

      <p style={{ fontSize: "0.75rem", color: "#9ca3af", textAlign: "center", marginTop: "0.85rem", lineHeight: 1.5 }}>
        Your trial begins now. After {TRIAL_DAYS} days, upgrade to keep full access.
        No automatic charges — you choose when to upgrade.
      </p>
    </div>
  );
}
