"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const supabase = createClient();
      const redirectTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/reset-password`
          : "/reset-password";

      const { error: authError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo }
      );

      if (authError) {
        setError(authError.message);
        return;
      }

      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>📬</div>
        <h1 style={{ fontSize: "1.3rem", fontWeight: 700, marginBottom: "0.5rem" }}>
          Check your email
        </h1>
        <p
          style={{
            color: "#6b7280",
            fontSize: "0.9rem",
            marginBottom: "1.25rem",
            lineHeight: 1.6,
          }}
        >
          We sent a password reset link to <strong>{email}</strong>. Click the
          link to set a new password, then come back and log in.
        </p>
        <a
          href="/login"
          className="btn btnPrimary"
          style={{ textDecoration: "none", display: "inline-block" }}
        >
          Back to login
        </a>
        <p style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#9ca3af" }}>
          Didn&apos;t get it? Check your spam folder or try again.
        </p>
        <p style={{ marginTop: "0.5rem" }}>
          <button
            type="button"
            onClick={() => setSent(false)}
            style={{
              background: "none",
              border: "none",
              color: "#6b7280",
              fontSize: "0.8rem",
              cursor: "pointer",
              textDecoration: "underline",
              padding: 0,
            }}
          >
            Try a different email
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <div className="auth-card-header">
        <h1>Reset your password</h1>
        <p>We&apos;ll send a reset link to your email.</p>
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
          <label htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <button
          type="submit"
          className="btn btnPrimary auth-submit"
          disabled={loading}
        >
          {loading ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <p style={{ marginTop: "1.25rem", textAlign: "center", fontSize: "0.875rem", color: "#6b7280" }}>
        Remember your password?{" "}
        <Link href="/login" style={{ color: "#2563eb", textDecoration: "none", fontWeight: 500 }}>
          Log in
        </Link>
      </p>
    </div>
  );
}
