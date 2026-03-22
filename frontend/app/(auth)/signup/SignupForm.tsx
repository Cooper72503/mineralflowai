"use client";

import { useState } from "react";

export function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // Placeholder: auth not wired yet
    setTimeout(() => setLoading(false), 500);
  }

  return (
    <div className="auth-card">
      <div className="auth-card-header">
        <h1>Create an account</h1>
        <p>Mineral Intelligence AI</p>
      </div>
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
