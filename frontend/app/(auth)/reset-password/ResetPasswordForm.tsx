"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Status = "loading" | "ready" | "success" | "error" | "invalid";

export function ResetPasswordForm() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Supabase PKCE flow: the reset link arrives as either:
  //   ?code=xxx  (PKCE, newer)  — exchanged server-side automatically by Supabase SSR
  //   #access_token=xxx&type=recovery  (implicit flow)
  // We listen for the PASSWORD_RECOVERY auth event to know when a recovery session is active.
  useEffect(() => {
    const supabase = createClient();

    // If there's a code param, exchange it
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");

    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) {
          setStatus("invalid");
        } else {
          setStatus("ready");
        }
      });
      return;
    }

    // Implicit flow — listen for recovery event from hash fragment
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event) => {
        if (event === "PASSWORD_RECOVERY") {
          setStatus("ready");
        }
      }
    );

    // If no code and no hash, the link may be missing
    const hash = window.location.hash;
    if (!hash.includes("type=recovery") && !hash.includes("access_token")) {
      // Give it 1.5s for onAuthStateChange to fire before declaring invalid
      const timer = setTimeout(() => setStatus("invalid"), 1500);
      return () => {
        clearTimeout(timer);
        subscription.unsubscribe();
      };
    }

    return () => subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      setStatus("success");
      setTimeout(() => router.replace("/underwriting"), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="auth-card" style={{ textAlign: "center" }}>
        <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>Verifying reset link…</p>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="auth-card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>⚠️</div>
        <h1 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "0.5rem" }}>
          Link expired or invalid
        </h1>
        <p style={{ color: "#6b7280", fontSize: "0.9rem", marginBottom: "1.25rem", lineHeight: 1.6 }}>
          This password reset link has expired or already been used. Request a new one.
        </p>
        <a
          href="/forgot-password"
          className="btn btnPrimary"
          style={{ textDecoration: "none", display: "inline-block" }}
        >
          Request new link
        </a>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="auth-card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>✅</div>
        <h1 style={{ fontSize: "1.2rem", fontWeight: 700, marginBottom: "0.5rem" }}>
          Password updated
        </h1>
        <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          Redirecting you to the dashboard…
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <div className="auth-card-header">
        <h1>Set a new password</h1>
        <p>Choose a strong password for your account.</p>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            borderRadius: "6px",
            color: "#b91c1c",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="formGroup">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            placeholder="At least 8 characters"
            minLength={8}
          />
        </div>
        <div className="formGroup">
          <label htmlFor="confirm-password">Confirm password</label>
          <input
            id="confirm-password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
            placeholder="Re-enter your password"
          />
        </div>
        <button
          type="submit"
          className="btn btnPrimary auth-submit"
          disabled={saving}
        >
          {saving ? "Updating…" : "Set new password"}
        </button>
      </form>
    </div>
  );
}
