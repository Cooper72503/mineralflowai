"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type BillingStatus = {
  plan: "free" | "pro";
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  has_stripe_customer: boolean;
  stripe_configured: boolean;
};

function PlanBadge({ plan }: { plan: string }) {
  const isPro = plan === "pro";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.6rem",
        borderRadius: 99,
        fontSize: "0.78rem",
        fontWeight: 700,
        background: isPro ? "#1d4ed8" : "#f3f4f6",
        color: isPro ? "#fff" : "#6b7280",
        letterSpacing: "0.03em",
        textTransform: "uppercase",
      }}
    >
      {isPro ? "Pro" : "Free"}
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function BillingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const successParam = searchParams.get("success");
  const canceledParam = searchParams.get("canceled");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) { router.replace("/login"); return; }
    });

    fetch("/api/billing/status")
      .then((r) => r.json())
      .then((body) => {
        if (body.ok) setStatus(body as BillingStatus);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpgrade() {
    setActionLoading(true);
    setActionError(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const body = await res.json();
      if (!body.ok || !body.url) {
        setActionError(body.error ?? "Failed to start checkout.");
        return;
      }
      window.location.href = body.url;
    } catch {
      setActionError("Network error. Please try again.");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleManage() {
    setActionLoading(true);
    setActionError(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const body = await res.json();
      if (!body.ok || !body.url) {
        setActionError(body.error ?? "Failed to open billing portal.");
        return;
      }
      window.location.href = body.url;
    } catch {
      setActionError("Network error. Please try again.");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Billing</h1>
        <p>Manage your subscription and payment methods</p>
      </div>

      {/* Success / cancel banners */}
      {successParam === "1" && (
        <div
          style={{
            background: "#dcfce7",
            border: "1px solid #86efac",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            marginBottom: "1.25rem",
            color: "#14532d",
            fontSize: "0.9rem",
            fontWeight: 500,
          }}
        >
          ✓ Subscription activated — welcome to Pro!
        </div>
      )}
      {canceledParam === "1" && (
        <div
          style={{
            background: "#fef9c3",
            border: "1px solid #fde047",
            borderRadius: 8,
            padding: "0.75rem 1rem",
            marginBottom: "1.25rem",
            color: "#713f12",
            fontSize: "0.9rem",
          }}
        >
          Checkout was canceled. No charges were made.
        </div>
      )}

      {loading && (
        <div className="card" style={{ maxWidth: 560 }}>
          <p style={{ color: "#9ca3af", fontSize: "0.9rem" }}>Loading billing info…</p>
        </div>
      )}

      {!loading && (
        <>
          {/* Current plan card */}
          <div className="card" style={{ maxWidth: 560, marginBottom: "1.25rem" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: "1rem",
              }}
            >
              <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>
                Current plan
              </h2>
              <PlanBadge plan={status?.plan ?? "free"} />
            </div>

            {status?.plan === "pro" ? (
              <div style={{ fontSize: "0.88rem", color: "#374151" }}>
                <p style={{ margin: "0 0 0.4rem" }}>
                  <strong>MineralFlow AI Pro</strong>
                </p>
                <p style={{ margin: "0 0 0.2rem", color: "#6b7280" }}>
                  Status:{" "}
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        status.status === "active"
                          ? "#16a34a"
                          : status.status === "past_due"
                          ? "#dc2626"
                          : "#6b7280",
                    }}
                  >
                    {status.status.replace("_", " ")}
                  </span>
                </p>
                {status.current_period_end && (
                  <p style={{ margin: "0 0 0.2rem", color: "#6b7280" }}>
                    {status.cancel_at_period_end
                      ? `Cancels on: ${formatDate(status.current_period_end)}`
                      : `Renews on: ${formatDate(status.current_period_end)}`}
                  </p>
                )}
              </div>
            ) : (
              <div style={{ fontSize: "0.88rem", color: "#374151" }}>
                <p style={{ margin: "0 0 0.4rem" }}>
                  <strong>No active subscription</strong>
                </p>
                <p style={{ margin: "0 0 0.75rem", color: "#6b7280" }}>
                  Start a 7-day free trial to get full platform access — $1,250/mo after the trial, cancel anytime.
                </p>
              </div>
            )}

            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "1rem" }}>
              {status?.plan !== "pro" && status?.stripe_configured && (
                <button
                  type="button"
                  onClick={handleUpgrade}
                  disabled={actionLoading}
                  style={{
                    padding: "0.5rem 1.25rem",
                    background: "#2563eb",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    fontSize: "0.9rem",
                    fontWeight: 600,
                    cursor: actionLoading ? "wait" : "pointer",
                  }}
                >
                  {actionLoading ? "Redirecting…" : "Start free trial"}
                </button>
              )}
              {status?.has_stripe_customer && (
                <button
                  type="button"
                  onClick={handleManage}
                  disabled={actionLoading}
                  style={{
                    padding: "0.5rem 1.25rem",
                    background: "#fff",
                    color: "#374151",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    fontSize: "0.9rem",
                    fontWeight: 600,
                    cursor: actionLoading ? "wait" : "pointer",
                  }}
                >
                  {actionLoading ? "Redirecting…" : "Manage subscription"}
                </button>
              )}
            </div>

            {actionError && (
              <p style={{ fontSize: "0.82rem", color: "#dc2626", margin: "0.5rem 0 0" }}>
                {actionError}
              </p>
            )}
          </div>

          {/* Pro features card */}
          {status?.plan !== "pro" && (
            <div className="card" style={{ maxWidth: 560 }}>
              <h2
                style={{
                  fontSize: "1rem",
                  fontWeight: 600,
                  marginBottom: "0.875rem",
                }}
              >
                What&apos;s included — $1,250/mo, 7-day free trial
              </h2>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.25rem",
                  fontSize: "0.88rem",
                  color: "#374151",
                  lineHeight: 1.8,
                }}
              >
                <li>Every applicable TRRC public record source, queried automatically</li>
                <li>Full lease-level production history and Arps decline-curve analysis</li>
                <li>Multi-scenario economics — PV-10 / PV-15 and offer range</li>
                <li>Acquisition Scorecard and Offset Analytics</li>
                <li>Full report exports — PDF, Excel, CSV, ZIP evidence archive</li>
                <li>Priority email support</li>
              </ul>
              {!status?.stripe_configured && (
                <p
                  style={{
                    fontSize: "0.78rem",
                    color: "#9ca3af",
                    marginTop: "0.75rem",
                    marginBottom: 0,
                  }}
                >
                  Questions about upgrading?{" "}
                  <a
                    href="mailto:cbosher@mineralflowai.com?subject=MineralFlow%20AI%20%E2%80%94%20Upgrade%20inquiry"
                    style={{ color: "#C9A84C", textDecoration: "none" }}
                  >
                    Contact us
                  </a>{" "}
                  and we&apos;ll get you set up.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
