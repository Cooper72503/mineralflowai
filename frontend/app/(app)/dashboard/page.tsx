"use client";

import Link from "next/link";

export default function DashboardPage() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0f1117",
      color: "#e2e8f0",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "2.5rem 2rem",
    }}>
      <div style={{ maxWidth: 800, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: "2.5rem" }}>
          <h1 style={{
            margin: "0 0 0.4rem 0",
            fontSize: "1.75rem",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "#e2e8f0",
          }}>
            MineralFlow AI
          </h1>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "#8892a4" }}>
            Select a tool to get started.
          </p>
        </div>

        {/* Tools grid */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "1rem",
        }}>
          <Link href="/trrc-due-diligence" style={{ textDecoration: "none" }}>
            <div style={{
              background: "#181c25",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 12,
              padding: "1.5rem",
              cursor: "pointer",
              transition: "border-color 0.15s",
            }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = "rgba(79,142,247,0.5)")}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)")}
            >
              <div style={{
                width: 40,
                height: 40,
                background: "rgba(79,142,247,0.12)",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: "1rem",
              }}>
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="#4f8ef7" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/>
                  <path d="M10 2v3h3"/>
                  <path d="M5.5 7.5h5M5.5 10h3"/>
                  <circle cx="11" cy="11" r="2"/>
                  <path d="M12.5 12.5L14 14"/>
                </svg>
              </div>
              <div style={{ fontSize: "1rem", fontWeight: 600, color: "#e2e8f0", marginBottom: "0.35rem" }}>
                TRRC Due Diligence
              </div>
              <div style={{ fontSize: "0.82rem", color: "#8892a4", lineHeight: 1.5 }}>
                Query every Texas Railroad Commission public record for any well, lease, or operator.
              </div>
              <div style={{
                marginTop: "1rem",
                fontSize: "0.75rem",
                fontWeight: 600,
                color: "#4f8ef7",
                letterSpacing: "0.04em",
              }}>
                Open →
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
