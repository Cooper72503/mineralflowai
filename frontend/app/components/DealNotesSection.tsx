"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

type Note = { id: string; note: string; created_at: string };

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type Props = { documentId: string };

export function DealNotesSection({ documentId }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const supabase = createClient();

  useEffect(() => {
    async function load() {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      try {
        const res = await fetch(`/api/documents/${documentId}/notes`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const body = await res.json();
        if (body.ok) setNotes(body.notes ?? []);
      } finally {
        setLoading(false);
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    setError(null);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;

    try {
      const res = await fetch(`/api/documents/${documentId}/notes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ note: text.trim() }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Failed to save note.");
        return;
      }
      setNotes((prev) => [body.note, ...prev]);
      setText("");
      textareaRef.current?.focus();
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 560, marginBottom: "1.5rem" }}>
      <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>Notes</h2>

      <form onSubmit={handleAdd} style={{ marginBottom: "1rem" }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleAdd(e as unknown as React.FormEvent);
            }
          }}
          placeholder="Add a note… (⌘↵ to save)"
          rows={3}
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "0.45rem 0.6rem",
            border: "1px solid #d1d5db", borderRadius: 6,
            fontSize: "0.88rem", fontFamily: "inherit",
            resize: "vertical", lineHeight: 1.5,
            marginBottom: "0.5rem",
          }}
          disabled={saving}
        />
        {error && <p style={{ fontSize: "0.8rem", color: "#dc2626", margin: "0 0 0.5rem" }}>{error}</p>}
        <button
          type="submit"
          className="btn btnPrimary"
          disabled={saving || !text.trim()}
          style={{ fontSize: "0.82rem", padding: "0.3rem 0.75rem" }}
        >
          {saving ? "Saving…" : "Add Note"}
        </button>
      </form>

      {loading ? (
        <p style={{ fontSize: "0.85rem", color: "#9ca3af" }}>Loading…</p>
      ) : notes.length === 0 ? (
        <p style={{ fontSize: "0.85rem", color: "#9ca3af" }}>No notes yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {notes.map((n) => (
            <li key={n.id} style={{ borderLeft: "3px solid #e5e7eb", paddingLeft: "0.75rem" }}>
              <p style={{ margin: "0 0 0.2rem", fontSize: "0.88rem", color: "#111827", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {n.note}
              </p>
              <span style={{ fontSize: "0.72rem", color: "#9ca3af" }}>{formatRelative(n.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
