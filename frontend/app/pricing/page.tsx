"use client";

import { PublicHeader } from "../components/PublicHeader";

const CAPABILITIES = [
  "Every applicable Texas Railroad Commission (TRRC) public record source, queried automatically",
  "Full lease-level production history — not capped to a rolling window",
  "Live compliance, injection, and P-5 operator status checks",
  "Plugging liability estimate per API number",
  "Arps decline-curve fitting — exponential / hyperbolic / harmonic, best-fit by SSE, with EUR",
  "Multi-scenario economics — stress / base / strip / upside pricing, PV-10 / PV-15, offer range",
  "Acquisition Scorecard — automated deal-quality scoring across mechanical, compliance, and operator risk",
  "Offset Analytics — geodesic-radius offset search, analog well scoring, proxy valuation for undeveloped tracts",
  "Evidence-first reporting — every field traceable to its source record; gaps disclosed, not guessed",
  "Full report exports — PDF, Excel workbook, CSV, and ZIP evidence archive",
  "Live drilling-permit tracking with SMS alerts",
];

const MAIL_ACCESS =
  "mailto:cbosher@mineralflowai.com?subject=Request%20access%20%E2%80%94%20MineralFlow%20AI";

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 2 }}>
      <circle cx="8" cy="8" r="8" fill="rgba(201,168,76,0.2)" />
      <path d="M5 8l2 2 4-4" stroke="#F0CC6E" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function AccessPage() {
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
            By Request
          </div>
          <h1 style={{ fontSize: "2.2rem", fontWeight: 700, color: "#f8fafc", marginBottom: "0.75rem", letterSpacing: "-0.02em" }}>
            Request access.
          </h1>
          <p style={{ fontSize: "1.05rem", color: "#94a3b8", maxWidth: 460, margin: "0 auto" }}>
            MineralFlow AI is engaged directly with acquisition teams and service companies operating
            in Texas oil and gas. Reach out and we'll set up your account.
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
            <div style={{ marginBottom: "1.5rem" }}>
              <p style={{ fontSize: "0.8rem", fontWeight: 700, color: "#F0CC6E", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "0.5rem" }}>
                Full Platform
              </p>
              <p style={{ fontSize: "0.95rem", color: "#cbd5e1", lineHeight: 1.6 }}>
                One engagement, tailored to how your team works — diligence volume, alert coverage,
                and reporting are scoped to your operation, not a fixed tier.
              </p>
            </div>

            <a
              href={MAIL_ACCESS}
              style={{
                display: "block",
                width: "100%",
                textAlign: "center",
                padding: "0.7rem 1.25rem",
                background: "linear-gradient(135deg,#C9A84C 0%,#d4a832 100%)",
                color: "#0a1628",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: "0.95rem",
                border: "none",
                cursor: "pointer",
                marginBottom: "1.75rem",
                boxShadow: "0 2px 10px rgba(201,168,76,0.4)",
                textDecoration: "none",
                boxSizing: "border-box",
              }}
            >
              Request Access
            </a>

            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
              {CAPABILITIES.map((f) => (
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
            By requesting access you agree to our{" "}
            <a href="/terms" style={{ color: "#C9A84C", textDecoration: "none" }}>Terms of Service</a>
            {" "}and{" "}
            <a href="/privacy" style={{ color: "#C9A84C", textDecoration: "none" }}>Privacy Policy</a>.
            Already have an account?{" "}
            <a href="/login" style={{ color: "#C9A84C", textDecoration: "none" }}>Log in</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
