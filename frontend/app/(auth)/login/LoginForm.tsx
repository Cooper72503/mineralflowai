"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const submittedEmail = email.trim();
    const submittedPassword = password;

    console.log("[Login] Submitting:", {
      email: submittedEmail,
      passwordLength: submittedPassword.length,
    });

    try {
      const supabase = createClient();
      const result = await supabase.auth.signInWithPassword({
        email: submittedEmail,
        password: submittedPassword,
      });

      const { data, error: authError } = result;

      // 3. Log exact auth response and exact error object to browser console
      console.log("[Login] Exact auth response (full):", result);
      console.log("[Login] Exact auth data:", data);
      console.log("[Login] Exact auth error object:", authError);
      if (authError) {
        console.log("[Login] Error.message:", authError.message);
        console.log("[Login] Error (stringified):", JSON.stringify(authError, null, 2));
      }

      // 5. Log whether a session is created after login
      const sessionExists = !!data?.session;
      console.log("[Login] Session created after login?", sessionExists);
      if (data?.session) {
        console.log("[Login] Session details:", {
          access_token: data.session.access_token ? "(present)" : "(missing)",
          expires_at: data.session.expires_at,
          user_id: data.session.user?.id,
        });
      }

      if (authError) {
        const message = authError.message || "Sign in failed";
        console.error("[Login] Auth failed — error.message:", message);
        setError(message); // 4. Show error.message directly in the UI
        setLoading(false);
        return; // 8. Do not redirect on failure
      }

      if (!data.session) {
        const message = "Sign in succeeded but no session was returned.";
        console.error("[Login]", message);
        setError(message);
        setLoading(false);
        return;
      }

      // 6. Redirect only after session exists; use full-page navigation so middleware sees cookies
      console.log("[Login] Session exists. Redirecting to /dashboard (after session exists).");
      window.location.href = "/dashboard";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Login] Unexpected error:", err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-card-header">
        <h1>Mineral Intelligence AI</h1>
        <p>Sign in to your account</p>
      </div>
      {error && (
        <div
          className="auth-error"
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
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div className="formGroup">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        <button type="submit" className="btn btnPrimary auth-submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
