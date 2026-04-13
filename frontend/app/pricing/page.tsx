"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PublicHeader } from "../components/PublicHeader";

const BASIC_FEATURES = [
  "50 document analyses per week",
  "AI extraction — lease terms, acreage, royalty, ownership",
  "Deal scoring with pursue / skip reasoning",
  "Pre-underwriting valuation",
  "Offer calculator with sensitivity matrix",
  "Quick Screen — instant PLSS analysis",
  "Kanban deal pipeline",
  "Well data (Texas RRC + North Dakota NDIC)",
  "Lease expiration alerts (90 / 30 / 7 days)",
  "Parcel map (PLSS centroid)",
  "Notes per document",
  "PDF export of deal reports",
];

const PRO_FEATURES = [
  "Everything in Basic",
  "Unlimited document analyses",
  "Priority AI processing queue",
  "API access for bulk imports",
  "Priority email support",
  "Additional state well data integrations",
  "Advanced export (CSV, Excel)",
  "Dedicated onboarding",
];

function CheckIcon({ dark }: { dark?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
      <circle cx="8" cy="8" r="8" fill={dark ? "rgba(201,168,76,0.2)" : "#fef3c7"} />
      <path d="M5 8l2 2 4-4" stroke={dark ? "#F0CC6E" : "#92400e"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function PricingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState<"basic" | "pro" | null>(null);

  async function handleCheckout(plan: "basic" | "pro") {
    setLoading(plan);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });

      if (res.status === 401) {
        // Not logged in — send to signup, then back to pricing
        router.push(`/signup?redirect=/pricing`);
        return;
      }

      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error ?? "Something went wrong. Please try again.");
        setLoading(null);
      }
    } catch {
      alert("Something went wrong. Please try again.");
      setLoading(null);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a1628", color: "#e2e8f0" }}>
      <PublicHeader variant="landing" />

      <main style={{ padding: "4rem 1.25rem 5rem" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: "3rem" }}>
          <h1 style={{ fontSize: "2.2rem", fontWeight: 700, color: "#f8fafc", marginBottom: "0.75rem", letterSpacing: "-0.02em" }}>
            Simple, transparent pricing
          </h1>
          <p style={{ fontSize: "1.05rem", color: "#94a3b8", maxWidth: 460, margin: "0 auto" }}>
            No contracts. Cancel anytime. Both plans include the full platform.
          </p>
        </div>

        {/* Cards */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1.5rem",
          maxWidth: 780,
          margin: "0 auto",
        }}>

          {/* Basic */}
          <div style={{
            background: "rgba(13,26,48,0.8)",
            border: "1px solid rgba(201,168,76,0.25)",
            borderRadius: 16,
            padding: "2rem",
          }}>
            <div style={{ marginBottom: "1.5rem" }}>
              <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "#C9A84C", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>
                Basic
              </p>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.3rem" }}>
                <span style={{ fontSize: "2.6rem", fontWeight: 700, color: "#f8fafc" }}>$500</span>
                <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>/month</span>
              </div>
              <p style={{ fontSize: "0.875rem", color: "#94a3b8", marginTop: "0.5rem" }}>
                50 analyses/week · all core features
              </p>
            </div>

            <button
              onClick={() => handleCheckout("basic")}
              disabled={loading !== null}
              style={{
                display: "block",
                width: "100%",
                textAlign: "center",
                padding: "0.7rem 1.25rem",
                background: loading === "basic" ? "rgba(201,168,76,0.6)" : "linear-gradient(135deg,#C9A84C 0%,#d4a832 100%)",
                color: "#0a1628",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: "0.95rem",
                border: "none",
                cursor: loading !== null ? "wait" : "pointer",
                marginBottom: "1.75rem",
                transition: "box-shadow 0.15s",
                boxShadow: "0 2px 8px rgba(201,168,76,0.3)",
              }}
            >
              {loading === "basic" ? "Redirecting to Stripe…" : "Get started"}
            </button>

            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {BASIC_FEATURES.map((f) => (
                <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.875rem", color: "#cbd5e1" }}>
                  <CheckIcon />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Pro */}
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
              Most popular
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "#F0CC6E", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>
                Pro
              </p>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.3rem" }}>
                <span style={{ fontSize: "2.6rem", fontWeight: 700, color: "#f8fafc" }}>$1,250</span>
                <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>/month</span>
              </div>
              <p style={{ fontSize: "0.875rem", color: "#94a3b8", marginTop: "0.5rem" }}>
                Unlimited analyses · priority processing
              </p>
            </div>

            <button
              onClick={() => handleCheckout("pro")}
              disabled={loading !== null}
              style={{
                display: "block",
                width: "100%",
                textAlign: "center",
                padding: "0.7rem 1.25rem",
                background: loading === "pro" ? "rgba(201,168,76,0.6)" : "linear-gradient(135deg,#C9A84C 0%,#d4a832 100%)",
                color: "#0a1628",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: "0.95rem",
                border: "none",
                cursor: loading !== null ? "wait" : "pointer",
                marginBottom: "1.75rem",
                transition: "box-shadow 0.15s",
                boxShadow: "0 2px 10px rgba(201,168,76,0.4)",
              }}
            >
              {loading === "pro" ? "Redirecting to Stripe…" : "Get started"}
            </button>

            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {PRO_FEATURES.map((f) => (
                <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.875rem", color: "#cbd5e1" }}>
                  <CheckIcon dark />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Footer note */}
        <div style={{ maxWidth: 560, margin: "3rem auto 0", textAlign: "center" }}>
          <p style={{ fontSize: "0.875rem", color: "#64748b", lineHeight: 1.7 }}>
            Payments processed securely by Stripe. Cancel anytime from your billing settings.
            Enterprise and team plans available —{" "}
            <a href="mailto:cbosher@mineralflowai.com" style={{ color: "#C9A84C", textDecoration: "none" }}>
              contact us
            </a>.
          </p>
        </div>
      </main>
    </div>
  );
}
