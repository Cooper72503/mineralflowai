"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      background: "#0f1117",
      color: "#e2e8f0",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      gap: "1rem",
      padding: "2rem",
      textAlign: "center",
    }}>
      <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>Something went wrong</div>
      <div style={{ display: "flex", gap: "0.75rem" }}>
        <button
          onClick={reset}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: 7,
            border: "1px solid rgba(255,255,255,0.15)",
            background: "transparent",
            color: "#e2e8f0",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          Try again
        </button>
        <a
          href="/dashboard"
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: 7,
            background: "#4f8ef7",
            color: "#fff",
            textDecoration: "none",
            fontSize: "0.875rem",
          }}
        >
          Go to dashboard
        </a>
      </div>
    </div>
  );
}
