"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const WEEKLY_LIMIT = 50;

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="card"
      style={{ maxWidth: 560, marginBottom: "1.25rem" }}
    >
      <h2
        style={{
          fontSize: "1rem",
          fontWeight: 600,
          marginBottom: "1rem",
          paddingBottom: "0.5rem",
          borderBottom: "1px solid #f0f0f0",
          color: "#111827",
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "0.875rem" }}>
      <label
        style={{
          display: "block",
          fontSize: "0.82rem",
          fontWeight: 500,
          color: "#6b7280",
          marginBottom: "0.3rem",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  fontSize: "0.9rem",
  color: "#111827",
  background: "#fff",
  boxSizing: "border-box",
};

export default function SettingsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [usageCount, setUsageCount] = useState<number | null>(null);

  // Load user info
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (!u) { router.replace("/login"); return; }
      setEmail(u.email ?? "");
      const name =
        (u.user_metadata?.full_name as string | undefined) ??
        (u.user_metadata?.name as string | undefined) ??
        "";
      setDisplayName(name);
      setNameInput(name);
    });

    // Usage in last 7 days
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .not("processed_at", "is", null)
      .gte("processed_at", since)
      .then(({ count }) => setUsageCount(count ?? 0));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setNameSaving(true);
    setNameMsg(null);
    const trimmed = nameInput.trim();
    const { error } = await supabase.auth.updateUser({
      data: { full_name: trimmed },
    });
    setNameSaving(false);
    if (error) {
      setNameMsg({ ok: false, text: error.message });
    } else {
      setDisplayName(trimmed);
      setNameMsg({ ok: true, text: "Name updated." });
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (newPw.length < 8) {
      setPwMsg({ ok: false, text: "Password must be at least 8 characters." });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ ok: false, text: "Passwords do not match." });
      return;
    }
    setPwSaving(true);
    // Supabase doesn't require current password for updateUser — it re-uses the session
    const { error } = await supabase.auth.updateUser({ password: newPw });
    setPwSaving(false);
    if (error) {
      setPwMsg({ ok: false, text: error.message });
    } else {
      setPwMsg({ ok: true, text: "Password updated successfully." });
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const usagePct =
    usageCount !== null ? Math.min(100, (usageCount / WEEKLY_LIMIT) * 100) : 0;
  const usageColor =
    usagePct >= 90 ? "#dc2626" : usagePct >= 60 ? "#d97706" : "#16a34a";

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Settings</h1>
        <p>Manage your account and preferences</p>
      </div>

      {/* Profile */}
      <SectionCard title="Profile">
        <form onSubmit={saveName}>
          <FieldRow label="Email address">
            <input
              type="email"
              value={email}
              readOnly
              style={{ ...inputStyle, background: "#f9fafb", color: "#6b7280", cursor: "default" }}
            />
          </FieldRow>
          <FieldRow label="Display name">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Your name"
              style={inputStyle}
            />
          </FieldRow>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.25rem" }}>
            <button
              type="submit"
              disabled={nameSaving || nameInput.trim() === displayName}
              style={{
                padding: "0.45rem 1rem",
                background: "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: "0.88rem",
                fontWeight: 600,
                cursor: nameSaving ? "wait" : "pointer",
                opacity: nameInput.trim() === displayName ? 0.5 : 1,
              }}
            >
              {nameSaving ? "Saving…" : "Save name"}
            </button>
            {nameMsg && (
              <span
                style={{
                  fontSize: "0.82rem",
                  color: nameMsg.ok ? "#16a34a" : "#dc2626",
                }}
              >
                {nameMsg.text}
              </span>
            )}
          </div>
        </form>
      </SectionCard>

      {/* Security */}
      <SectionCard title="Security">
        <form onSubmit={changePassword}>
          <FieldRow label="New password">
            <input
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              style={inputStyle}
            />
          </FieldRow>
          <FieldRow label="Confirm new password">
            <input
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="Repeat new password"
              autoComplete="new-password"
              style={inputStyle}
            />
          </FieldRow>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.25rem" }}>
            <button
              type="submit"
              disabled={pwSaving || !newPw || !confirmPw}
              style={{
                padding: "0.45rem 1rem",
                background: "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: "0.88rem",
                fontWeight: 600,
                cursor: pwSaving ? "wait" : "pointer",
                opacity: !newPw || !confirmPw ? 0.5 : 1,
              }}
            >
              {pwSaving ? "Updating…" : "Update password"}
            </button>
            {pwMsg && (
              <span
                style={{
                  fontSize: "0.82rem",
                  color: pwMsg.ok ? "#16a34a" : "#dc2626",
                }}
              >
                {pwMsg.text}
              </span>
            )}
          </div>
        </form>
      </SectionCard>

      {/* Usage */}
      <SectionCard title="Usage">
        <p style={{ fontSize: "0.85rem", color: "#6b7280", marginBottom: "0.75rem" }}>
          Documents processed in the last 7 days
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div style={{ flex: 1, height: 8, background: "#f3f4f6", borderRadius: 99, overflow: "hidden" }}>
            <div
              style={{
                width: `${usagePct}%`,
                height: "100%",
                background: usageColor,
                borderRadius: 99,
                transition: "width 0.4s",
              }}
            />
          </div>
          <span style={{ fontSize: "0.88rem", fontWeight: 600, color: usageColor, whiteSpace: "nowrap" }}>
            {usageCount ?? "—"} / {WEEKLY_LIMIT}
          </span>
        </div>
        {usageCount !== null && usagePct >= 90 && (
          <p style={{ fontSize: "0.78rem", color: "#dc2626", marginTop: "0.5rem", marginBottom: 0 }}>
            You&apos;re near the daily limit. Unused quota resets every 24 hours.
          </p>
        )}
        <p style={{ fontSize: "0.75rem", color: "#9ca3af", marginTop: "0.5rem", marginBottom: 0 }}>
          Limit resets on a rolling 7-day basis.
        </p>
      </SectionCard>

      {/* Sign out */}
      <SectionCard title="Session">
        <p style={{ fontSize: "0.85rem", color: "#6b7280", marginBottom: "0.875rem" }}>
          Sign out of your account on this device.
        </p>
        <button
          type="button"
          onClick={signOut}
          style={{
            padding: "0.45rem 1rem",
            background: "#fff",
            color: "#dc2626",
            border: "1px solid #fca5a5",
            borderRadius: 6,
            fontSize: "0.88rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </SectionCard>
    </div>
  );
}
