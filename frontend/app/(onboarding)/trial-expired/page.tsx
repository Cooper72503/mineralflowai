import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fetchTrialStatus } from "@/lib/trial/trial-status";

export const dynamic = "force-dynamic";

export default async function TrialExpiredPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const trialStatus = await fetchTrialStatus(supabase, user.id);

  // Still active or paid — no business being here
  if (trialStatus.state === "active" || trialStatus.state === "paid") {
    redirect("/dashboard");
  }

  return (
    <div style={{
      width: "100%",
      maxWidth: 460,
      background: "#ffffff",
      borderRadius: 16,
      padding: "2.5rem 2rem",
      boxShadow: "0 25px 60px rgba(0,0,0,0.4)",
      textAlign: "center",
    }}>
      <div style={{ fontSize: "3rem", marginBottom: "0.75rem" }}>⏰</div>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 800, color: "#0f172a", marginBottom: "0.5rem" }}>
        Your free trial has ended
      </h1>
      <p style={{ fontSize: "0.9rem", color: "#6b7280", lineHeight: 1.6, marginBottom: "1.75rem" }}>
        Your 7-day trial of Mineral Flow AI has expired. Upgrade to a paid plan to restore full access to screening, valuation, well intelligence, and alerts.
      </p>

      {/* Upgrade CTA */}
      <a
        href="/billing"
        style={{
          display: "block",
          padding: "0.85rem",
          borderRadius: 10,
          background: "#2563eb",
          color: "#fff",
          fontSize: "1rem",
          fontWeight: 700,
          textDecoration: "none",
          marginBottom: "0.85rem",
          letterSpacing: "0.01em",
        }}
      >
        Upgrade to continue →
      </a>

      <p style={{ fontSize: "0.82rem", color: "#6b7280", marginBottom: "1.25rem" }}>
        Questions? Email us at{" "}
        <a href="mailto:support@mineralflowai.com" style={{ color: "#2563eb" }}>
          support@mineralflowai.com
        </a>
      </p>

      <a
        href="/login"
        style={{ fontSize: "0.8rem", color: "#9ca3af", textDecoration: "underline" }}
      >
        Sign in with a different account
      </a>
    </div>
  );
}
