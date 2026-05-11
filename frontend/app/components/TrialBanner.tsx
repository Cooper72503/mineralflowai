"use client";

export function TrialBanner({ daysLeft }: { daysLeft: number }) {
  const urgent = daysLeft <= 2;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "0.75rem",
      padding: "0.55rem 1rem",
      background: urgent ? "#fef2f2" : "#fffbeb",
      borderBottom: `1px solid ${urgent ? "#fecaca" : "#fde68a"}`,
      fontSize: "0.82rem",
      color: urgent ? "#991b1b" : "#92400e",
      flexWrap: "wrap",
    }}>
      <span>
        {urgent ? "⚠️ " : "⏳ "}
        <strong>
          {daysLeft === 1 ? "Last day" : `${daysLeft} days`} left in your free trial.
        </strong>
        {" "}Upgrade to keep access after your trial ends.
      </span>
      <a
        href="/billing"
        style={{
          padding: "0.3rem 0.75rem",
          borderRadius: 6,
          background: urgent ? "#dc2626" : "#d97706",
          color: "#fff",
          fontSize: "0.78rem",
          fontWeight: 600,
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Upgrade now →
      </a>
    </div>
  );
}
