"use client";

export function TrialBanner({ daysLeft }: { daysLeft: number }) {
  const urgent = daysLeft <= 2;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "0.75rem",
      padding: "0.6rem 1.25rem",
      background: urgent
        ? "linear-gradient(90deg, #450a0a, #7f1d1d)"
        : "linear-gradient(90deg, #1c1407, #451a03)",
      borderBottom: `1px solid ${urgent ? "rgba(248,113,113,0.2)" : "rgba(251,191,36,0.2)"}`,
      fontSize: "0.82rem",
      color: urgent ? "#fca5a5" : "#fcd34d",
      flexWrap: "wrap",
      letterSpacing: "-0.01em",
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: urgent ? "rgba(220,38,38,0.3)" : "rgba(217,119,6,0.3)",
          fontSize: "0.7rem",
          flexShrink: 0,
        }}>
          {urgent ? "!" : "⏱"}
        </span>
        <span>
          <strong style={{ color: urgent ? "#fca5a5" : "#fde68a" }}>
            {daysLeft === 1 ? "Last day" : `${daysLeft} days`} left in your free trial.
          </strong>
          {" "}Upgrade to keep full access.
        </span>
      </span>
      <a
        href="/billing"
        style={{
          padding: "0.35rem 0.85rem",
          borderRadius: 6,
          background: urgent ? "#dc2626" : "#d97706",
          color: "#fff",
          fontSize: "0.78rem",
          fontWeight: 700,
          textDecoration: "none",
          whiteSpace: "nowrap",
          letterSpacing: "0.01em",
          boxShadow: urgent ? "0 1px 4px rgba(220,38,38,0.4)" : "0 1px 4px rgba(217,119,6,0.4)",
        }}
      >
        Upgrade now →
      </a>
    </div>
  );
}
