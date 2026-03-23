"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AuthError } from "@supabase/supabase-js";
import { isAuthError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { withTimeout } from "@/lib/with-timeout";

const SIGNUP_REQUEST_TIMEOUT_MS = 10_000;

function formatUnderlyingError(original: unknown): string {
  if (original instanceof Error) {
    const tail =
      original.cause !== undefined
        ? ` · cause: ${formatUnderlyingError(original.cause)}`
        : "";
    return `${original.name}: ${original.message}${tail}`;
  }
  if (
    typeof original === "object" &&
    original !== null &&
    "message" in original &&
    typeof (original as { message: unknown }).message === "string"
  ) {
    return (original as { message: string }).message;
  }
  try {
    return JSON.stringify(original);
  } catch {
    return String(original);
  }
}

function logFullAuthError(prefix: string, err: AuthError) {
  console.error(`${prefix} Supabase auth error (raw instance):`, err);

  const plain: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    status: err.status,
  };
  if ("code" in err && err.code !== undefined) plain.code = err.code;
  if (typeof err.stack === "string") plain.stack = err.stack;

  const withReasons = err as AuthError & { reasons?: unknown };
  if (Array.isArray(withReasons.reasons) && withReasons.reasons.length > 0) {
    plain.reasons = withReasons.reasons;
  }

  const withDetails = err as AuthError & { details?: unknown };
  if (withDetails.details !== undefined && withDetails.details !== null) {
    plain.details = withDetails.details;
  }

  const original = (err as { originalError?: unknown }).originalError;
  if (original !== undefined) {
    plain.originalError = original;
    if (original instanceof Error) {
      plain.originalErrorName = original.name;
      plain.originalErrorMessage = original.message;
      plain.originalErrorStack = original.stack;
      if (original.cause !== undefined) plain.originalErrorCause = original.cause;
    }
  }

  console.error(`${prefix} Supabase auth error (serializable fields):`, plain);
}

function formatAuthErrorForUi(err: AuthError): string {
  const genericNetwork =
    err.message === "Load failed" || err.message === "Failed to fetch";

  const parts: string[] = [];
  if (genericNetwork && err.name !== "AuthError") {
    parts.push(err.name);
  }
  parts.push(err.message);

  if ("code" in err && typeof err.code === "string" && err.code.length > 0) {
    parts.push(`Code: ${err.code}`);
  }
  if (typeof err.status === "number") {
    parts.push(
      err.status === 0
        ? "HTTP status: 0 (no response — network, CORS, blocked request, or wrong Supabase URL)"
        : `HTTP ${err.status}`
    );
  }
  if (!genericNetwork && err.name && err.name !== "AuthError") {
    parts.push(`(${err.name})`);
  }

  const original = (err as { originalError?: unknown }).originalError;
  if (original !== undefined) {
    parts.push(`Underlying: ${formatUnderlyingError(original)}`);
  }

  const withReasons = err as AuthError & { reasons?: unknown };
  if (Array.isArray(withReasons.reasons) && withReasons.reasons.length > 0) {
    parts.push(`Reasons: ${withReasons.reasons.join(", ")}`);
  }

  const withDetails = err as AuthError & { details?: unknown };
  if (withDetails.details !== undefined && withDetails.details !== null) {
    try {
      parts.push(`Details: ${JSON.stringify(withDetails.details)}`);
    } catch {
      parts.push(`Details: ${String(withDetails.details)}`);
    }
  }

  return parts.join(" · ");
}

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    const submittedEmail = email.trim();
    const submittedPassword = password;

    try {
      console.log("SIGNUP START");
      const supabase = createClient();
      const result = await withTimeout(
        supabase.auth.signUp({
          email: submittedEmail,
          password: submittedPassword,
        }),
        SIGNUP_REQUEST_TIMEOUT_MS,
        "Signup timed out, please try again"
      );

      const { data, error: authError } = result;
      console.log("SIGNUP RESPONSE", {
        error: authError,
        userId: data?.user?.id ?? null,
        hasSession: !!data?.session,
      });

      if (authError) {
        console.log("SIGNUP ERROR", authError);
        logFullAuthError("[Signup]", authError);
        setError(formatAuthErrorForUi(authError));
        return;
      }

      if (data.session) {
        router.replace("/dashboard");
        router.refresh();
        return;
      }

      setSuccessMessage(
        "Your account was created. You can log in with your email and password."
      );
    } catch (err) {
      console.log("SIGNUP ERROR", err);
      if (isAuthError(err)) {
        logFullAuthError("[Signup]", err);
        setError(formatAuthErrorForUi(err));
      } else {
        const message =
          err instanceof Error
            ? [err.message, err.cause != null ? `Cause: ${formatUnderlyingError(err.cause)}` : null]
                .filter(Boolean)
                .join(" · ")
            : String(err);
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-card-header">
        <h1>Create an account</h1>
        <p>Mineral Intelligence AI</p>
      </div>
      {successMessage && (
        <div
          className="auth-success"
          role="status"
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "rgba(34, 197, 94, 0.12)",
            border: "1px solid rgba(34, 197, 94, 0.35)",
            borderRadius: "6px",
            color: "#15803d",
            fontSize: "0.875rem",
          }}
        >
          {successMessage}
        </div>
      )}
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
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div className="formGroup">
          <label htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </div>
        <button type="submit" className="btn btnPrimary auth-submit" disabled={loading}>
          {loading ? "Creating account…" : "Sign up"}
        </button>
      </form>
    </div>
  );
}
