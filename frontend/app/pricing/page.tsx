import Link from "next/link";
import { PublicHeader } from "../components/PublicHeader";

const FREE_FEATURES = [
  "25 document analyses per day",
  "AI extraction — lease terms, acreage, royalty, ownership",
  "Deal scoring (A / B / C grades)",
  "Pre-underwriting valuation",
  "Offer calculator with sensitivity matrix",
  "Quick Screen — instant PLSS analysis",
  "Kanban deal pipeline",
  "Well data (Texas RRC + North Dakota NDIC)",
  "Parcel map (PLSS centroid)",
  "Notes per document",
  "Batch upload",
];

const PRO_FEATURES = [
  "Everything in Free",
  "Unlimited document analyses",
  "Priority AI processing queue",
  "PDF export of deal reports",
  "Email alerts on lease expirations",
  "API access for bulk imports",
  "Priority email support",
  "Additional state well data integrations",
  "Advanced export (CSV, Excel)",
];

function CheckGreen() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
      <circle cx="8" cy="8" r="8" fill="#dcfce7" />
      <path d="M5 8l2 2 4-4" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckBlue() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
      <circle cx="8" cy="8" r="8" fill="rgba(255,255,255,0.15)" />
      <path d="M5 8l2 2 4-4" stroke="#86efac" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function PricingPage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main" style={{ paddingTop: "3rem", paddingBottom: "4rem" }}>
        <div style={{ textAlign: "center", marginBottom: "3rem" }}>
          <h1 style={{ fontSize: "2.2rem", fontWeight: 700, color: "#111827", marginBottom: "0.75rem" }}>
            Simple, transparent pricing
          </h1>
          <p style={{ fontSize: "1.05rem", color: "#6b7280", maxWidth: 480, margin: "0 auto" }}>
            Start free — no credit card required. Upgrade when you need higher volume or exports.
          </p>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1.5rem",
          maxWidth: 760,
          margin: "0 auto",
        }}>
          {/* Free Plan */}
          <div style={{
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            padding: "2rem",
          }}>
            <div style={{ marginBottom: "1.5rem" }}>
              <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
                Free
              </p>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.25rem" }}>
                <span style={{ fontSize: "2.5rem", fontWeight: 700, color: "#111827" }}>$0</span>
                <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>/month</span>
              </div>
              <p style={{ fontSize: "0.88rem", color: "#6b7280", marginTop: "0.5rem" }}>
                25 analyses/day · all core features
              </p>
            </div>

            <Link
              href="/signup"
              style={{
                display: "block",
                textAlign: "center",
                padding: "0.65rem 1.25rem",
                background: "#f3f4f6",
                color: "#111827",
                borderRadius: 8,
                fontWeight: 600,
                fontSize: "0.95rem",
                textDecoration: "none",
                marginBottom: "1.75rem",
                border: "1px solid #e5e7eb",
              }}
            >
              Get started free
            </Link>

            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {FREE_FEATURES.map((f) => (
                <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.88rem", color: "#374151" }}>
                  <CheckGreen />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Pro Plan */}
          <div style={{
            background: "#1e40af",
            border: "1px solid #1d4ed8",
            borderRadius: 16,
            padding: "2rem",
            position: "relative",
          }}>
            <div style={{
              position: "absolute",
              top: -12,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#16a34a",
              color: "#fff",
              fontSize: "0.72rem",
              fontWeight: 700,
              padding: "0.2rem 0.75rem",
              borderRadius: 99,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}>
              Most popular
            </div>

            <div style={{ marginBottom: "1.5rem" }}>
              <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "#93c5fd", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.5rem" }}>
                Pro
              </p>
              <div style={{ display: "flex", alignItems: "baseline", gap: "0.25rem" }}>
                <span style={{ fontSize: "2.5rem", fontWeight: 700, color: "#fff" }}>$99</span>
                <span style={{ color: "#93c5fd", fontSize: "0.9rem" }}>/month</span>
              </div>
              <p style={{ fontSize: "0.88rem", color: "#93c5fd", marginTop: "0.5rem" }}>
                Unlimited analyses · priority processing
              </p>
            </div>

            <Link
              href="/billing"
              style={{
                display: "block",
                textAlign: "center",
                padding: "0.65rem 1.25rem",
                background: "#fff",
                color: "#1e40af",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: "0.95rem",
                textDecoration: "none",
                marginBottom: "1.75rem",
              }}
            >
              Upgrade to Pro
            </Link>

            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {PRO_FEATURES.map((f) => (
                <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.88rem", color: "#dbeafe" }}>
                  <CheckBlue />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div style={{ maxWidth: 560, margin: "3rem auto 0", textAlign: "center" }}>
          <p style={{ fontSize: "0.88rem", color: "#6b7280", lineHeight: 1.7 }}>
            All plans include SSL, Supabase-backed auth, and row-level security.
            Cancel anytime. Enterprise and team plans available —{" "}
            <a href="mailto:hello@mineralflow.ai" style={{ color: "#2563eb", textDecoration: "none" }}>
              contact us
            </a>.
          </p>
        </div>
      </main>
    </div>
  );
}
