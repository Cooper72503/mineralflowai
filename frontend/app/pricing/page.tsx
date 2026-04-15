"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PublicHeader } from "../components/PublicHeader";
import { createClient } from "@/lib/supabase/client";

const PILOT_FEATURES = [
  "Unlimited document analyses",
  "AI extraction — lease terms, acreage, royalty, ownership",
  "Deal scoring with pursue / skip reasoning",
  "Pre-underwriting valuation",
  "Offer calculator with sensitivity matrix",
  "Quick Screen — instant legal description analysis (TX, ND, OK, WV, OH)",
  "Kanban deal pipeline",
  "Live well data (Texas RRC, North Dakota NDIC, Oklahoma OCC, West Virginia DEP)",
  "Lease expiration alerts (90 / 30 / 7 days)",
  "Parcel map (PLSS centroid)",
  "Notes per document",
  "PDF export of deal reports",
  "Priority email support",
  "Dedicated onboarding",
];

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
      <circle cx="8" cy="8" r="8" fill="rgba(201,168,76,0.2)" />
      <path d="M5 8l2 2 4-4" stroke="#F0CC6E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function PricingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleCheckout() {
    setLoading(true);
    try {
      const supabase = createClient();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ plan: "pro" }),
      });

      if (res.status === 401) {
        router.push(`/login?redirect=/pricing&plan=pro`);
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error ?? `Error ${res.status} — please try again.`);
        setLoading(false);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Network error — please try again.");
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a1628", color: "#e2e8f0" }}>
      <PublicHeader variant="landing" />

      <main style={{ padding: "4rem 1.25rem 5rem" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: "3rem" }}>
          <div style={{
            display: "inline-block",
            background: "rgba(201,168,76,0.12)",
            border: "1px solid rgba(201,168,76,0.3)",
            borderRadius: 99,
            padding: "0.3rem 0.9rem",
            fontSize: "0.78rem",
            fontWeight: 700,
            color: "#C9A84C",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "1rem",
          }}>
            Pilot Program
          </div>
          <h1 style={{ fontSize: "2.2rem", fontWeight: 700, color: "#f8fafc", marginBottom: "0.75rem", letterSpacing: "-0.02em" }}>
            One plan. Full access.
          </h1>
          <p style={{ fontSize: "1.05rem", color: "#94a3b8", maxWidth: 460, margin: "0 auto" }}>
            Everything included for pilot customers. No tiered limits, no feature gates.
          </p>
        </div>

        {/* Card */}
        <div style={{ maxWidth: 420, margin: "0 auto" }}>
          <div style={{
            background: "linear-gradient(160deg,#0f1e35 0%,#0a1628 100%)",
            border: "1px solid rgba(201,168,76,0.5)",
            borderRadius: 16,
            padding: "2rem",
            position: "relative",
            boxShadow: "0 0 40px rgba(201,168,76,0.08)",
          }}>
            {/* Badge */}
            <div style={{
              position: "absolute",
              top: -13,
              left: "50%",
              transform: "translateX(-50%)",
              background: "linear-gradient(135deg,#C9A84C 0%,#d4a832 100%)",
              color: "#0a1628",
              fontSize: "0.72rem",
              fontWeight: 800,
              padding: "0.25rem 0.85rem",
              borderRadius: 99,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}>
              Pilot Access
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "#F0CC6E", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>
                Full Platform
              </p>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.3rem" }}>
                <span style={{ fontSize: "2.6rem", fontWeight: 700, color: "#f8fafc" }}>$1,250</span>
                <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>/month</span>
              </div>
              <p style={{ fontSize: "0.875rem", color: "#94a3b8", marginTop: "0.5rem" }}>
                All features · unlimited analyses · priority support
              </p>
            </div>

            <button
              onClick={handleCheckout}
              disabled={loading}
              style={{
                display: "block",
                width: "100%",
                textAlign: "center",
                padding: "0.7rem 1.25rem",
                background: loading ? "rgba(201,168,76,0.6)" : "linear-gradient(135deg,#C9A84C 0%,#d4a832 100%)",
                color: "#0a1628",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: "0.95rem",
                border: "none",
                cursor: loading ? "wait" : "pointer",
                marginBottom: "1.75rem",
                boxShadow: "0 2px 10px rgba(201,168,76,0.4)",
              }}
            >
              {loading ? "Redirecting to Stripe…" : "Join the pilot"}
            </button>

            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {PILOT_FEATURES.map((f) => (
                <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.875rem", color: "#cbd5e1" }}>
                  <CheckIcon />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Footer note */}
        <div style={{ maxWidth: 420, margin: "3rem auto 0", textAlign: "center" }}>
          <p style={{ fontSize: "0.875rem", color: "#64748b", lineHeight: 1.7 }}>
            Payments processed securely by Stripe. Cancel anytime from your billing settings.
            Questions?{" "}
            <a href="mailto:cbosher@mineralflowai.com" style={{ color: "#C9A84C", textDecoration: "none" }}>
              Contact us
            </a>.
          </p>
        </div>
      </main>
    </div>
  );
}
