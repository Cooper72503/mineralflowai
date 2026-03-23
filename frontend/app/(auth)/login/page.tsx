export const dynamic = "force-dynamic";

import { Suspense } from "react";
import Link from "next/link";
import { LoginForm } from "./LoginForm";

function LoginFallback() {
  return (
    <div className="auth-card">
      <div className="auth-card-header">
        <h1>Mineral Flow AI</h1>
        <p>Sign in to your account</p>
      </div>
      <p className="auth-muted">Loading…</p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="auth-page">
      <Suspense fallback={<LoginFallback />}>
        <LoginForm />
      </Suspense>
      <p className="auth-footer">
        Don&apos;t have an account? <Link href="/signup">Sign up</Link>
      </p>
    </div>
  );
}
