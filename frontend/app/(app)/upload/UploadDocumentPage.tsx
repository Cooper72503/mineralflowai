"use client";

import Link from "next/link";
import { useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { DocumentDropZone } from "../../components/DocumentDropZone";

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

type FileStatus = "queued" | "uploading" | "done" | "error";

type QueuedFile = {
  id: string;
  file: File;
  status: FileStatus;
  error: string | null;
  docId: string | null;
};

function StatusBadge({ status }: { status: FileStatus }) {
  const map: Record<FileStatus, { bg: string; color: string; label: string }> = {
    queued:    { bg: "#f3f4f6", color: "#374151", label: "Queued" },
    uploading: { bg: "#eff6ff", color: "#1e40af", label: "Uploading…" },
    done:      { bg: "#dcfce7", color: "#14532d", label: "Done ✓" },
    error:     { bg: "#fee2e2", color: "#7f1d1d", label: "Error" },
  };
  const s = map[status];
  return (
    <span style={{
      display: "inline-block", fontSize: "0.72rem", fontWeight: 600,
      padding: "0.15rem 0.5rem", borderRadius: 4,
      background: s.bg, color: s.color,
    }}>
      {s.label}
    </span>
  );
}

export default function UploadDocumentPage() {
  const [queue, setQueue]           = useState<QueuedFile[]>([]);
  const [documentType, setDocumentType] = useState("");
  const [county, setCounty]         = useState("");
  const [state, setState]           = useState("");
  const [legalDescription, setLegalDescription] = useState("");
  const [uploading, setUploading]   = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [summary, setSummary]       = useState<string | null>(null);

  const supabase = createClient();

  const handleFilesSelect = useCallback((files: File[]) => {
    setSummary(null);
    setGlobalError(null);
    setQueue((prev) => {
      const existing = new Set(prev.map((q) => q.file.name + q.file.size));
      const newEntries: QueuedFile[] = files
        .filter((f) => !existing.has(f.name + f.size))
        .map((f) => ({
          id: `${f.name}-${f.size}-${Math.random()}`,
          file: f,
          status: "queued",
          error: null,
          docId: null,
        }));
      return [...prev, ...newEntries];
    });
  }, []);

  function removeFromQueue(id: string) {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  }

  function updateQueueItem(id: string, patch: Partial<QueuedFile>) {
    setQueue((prev) => prev.map((q) => q.id === id ? { ...q, ...patch } : q));
  }

  async function uploadSingleFile(qf: QueuedFile): Promise<boolean> {
    const supabaseClient = createClient();
    const { data: { user }, error: userErr } = await supabaseClient.auth.getUser();
    if (userErr || !user) {
      updateQueueItem(qf.id, { status: "error", error: "Not signed in." });
      return false;
    }

    updateQueueItem(qf.id, { status: "uploading" });

    const safeName  = sanitizeFileName(qf.file.name);
    const filePath  = `${user.id}/${Date.now()}-${safeName}`;

    const { error: uploadErr } = await supabaseClient.storage
      .from("documents")
      .upload(filePath, qf.file, { upsert: false });

    if (uploadErr) {
      updateQueueItem(qf.id, {
        status: "error",
        error: (uploadErr as { message?: string }).message ?? "Upload failed.",
      });
      return false;
    }

    const trimmedDocumentType   = documentType.trim();
    const trimmedCounty         = county.trim();
    const trimmedState          = state.trim();
    const trimmedLegalDescription = legalDescription.trim();

    const { data: docData, error: insertErr } = await supabaseClient
      .from("documents")
      .insert({
        user_id: user.id,
        file_name: qf.file.name,
        file_path: filePath,
        file_size: qf.file.size,
        county: trimmedCounty || null,
        state: trimmedState || null,
        document_type: trimmedDocumentType || null,
        status: "uploaded",
        storage_path: filePath,
      })
      .select("id")
      .maybeSingle();

    if (insertErr || !docData?.id) {
      await supabaseClient.storage.from("documents").remove([filePath]);
      updateQueueItem(qf.id, { status: "error", error: "Failed to save document record." });
      return false;
    }

    if (trimmedLegalDescription || trimmedCounty || trimmedState) {
      await supabaseClient.from("document_extractions").insert({
        document_id: docData.id,
        user_id: user.id,
        extracted_text: "",
        legal_description: trimmedLegalDescription || null,
        county: trimmedCounty || null,
        state: trimmedState || null,
        confidence_score: 0,
      });
    }

    updateQueueItem(qf.id, { status: "done", docId: docData.id });
    return true;
  }

  async function handleUploadAll(e: React.FormEvent) {
    e.preventDefault();
    setGlobalError(null);
    setSummary(null);

    const pending = queue.filter((q) => q.status === "queued" || q.status === "error");
    if (pending.length === 0) {
      setGlobalError("No files queued. Select files first.");
      return;
    }

    setUploading(true);
    let succeeded = 0;
    let failed = 0;

    for (const qf of pending) {
      const ok = await uploadSingleFile(qf);
      if (ok) succeeded++; else failed++;
    }

    setUploading(false);
    setSummary(
      failed === 0
        ? `${succeeded} file${succeeded !== 1 ? "s" : ""} uploaded successfully.`
        : `${succeeded} succeeded · ${failed} failed. Check errors below.`
    );
  }

  const hasQueued = queue.some((q) => q.status === "queued" || q.status === "error");
  const allDone   = queue.length > 0 && queue.every((q) => q.status === "done");

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Upload document{queue.length > 1 ? "s" : ""}</h1>
        <p>Upload mineral deeds, leases, and related documents for pre-underwriting analysis</p>
      </div>

      <div className="card">
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Choose files
        </h2>
        <div style={{ marginBottom: "1rem" }}>
          <DocumentDropZone
            onFileSelect={(f) => handleFilesSelect(Array.isArray(f) ? f : [f])}
            disabled={uploading}
            multiple
          />
        </div>

        {/* Queue list */}
        {queue.length > 0 && (
          <div style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: "0.82rem", color: "#6b7280", marginBottom: "0.4rem" }}>
              {queue.length} file{queue.length !== 1 ? "s" : ""} selected
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              {queue.map((qf) => (
                <li key={qf.id} style={{
                  display: "flex", alignItems: "center", gap: "0.5rem",
                  padding: "0.35rem 0.5rem",
                  background: "#f9fafb", borderRadius: 6,
                  border: "1px solid #e5e7eb",
                }}>
                  <StatusBadge status={qf.status} />
                  <span style={{ flex: 1, fontSize: "0.85rem", color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {qf.file.name}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "#9ca3af", whiteSpace: "nowrap" }}>
                    {(qf.file.size / 1024).toFixed(0)} KB
                  </span>
                  {qf.status === "done" && qf.docId && (
                    <Link href={`/documents/${qf.docId}`} style={{ fontSize: "0.75rem", color: "#2563eb" }}>
                      View →
                    </Link>
                  )}
                  {qf.error && (
                    <span style={{ fontSize: "0.72rem", color: "#dc2626" }} title={qf.error}>⚠</span>
                  )}
                  {qf.status !== "uploading" && (
                    <button
                      type="button"
                      onClick={() => removeFromQueue(qf.id)}
                      style={{ fontSize: "0.75rem", color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "0 0.2rem" }}
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={handleUploadAll} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 480 }}>
          <div>
            <label htmlFor="document-type" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              Document type
            </label>
            <input
              id="document-type"
              type="text"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              placeholder="e.g. Mineral Deed, Lease, Mineral Property Summary"
              style={{ width: "100%", padding: "0.5rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label htmlFor="county" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                County
              </label>
              <input
                id="county"
                type="text"
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                placeholder="e.g. Stark, Reeves"
                style={{ width: "100%", padding: "0.5rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
              />
            </div>
            <div>
              <label htmlFor="state" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
                State
              </label>
              <input
                id="state"
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="e.g. North Dakota, Texas"
                style={{ width: "100%", padding: "0.5rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
              />
            </div>
          </div>

          <div>
            <label htmlFor="legal-description" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              Legal description{" "}
              <span style={{ color: "#888", fontWeight: 400 }}>(optional — applied to all files)</span>
            </label>
            <textarea
              id="legal-description"
              value={legalDescription}
              onChange={(e) => setLegalDescription(e.target.value)}
              placeholder={"e.g. SE/4 of Section 12, Township 140 North, Range 94 West"}
              rows={3}
              style={{
                width: "100%", padding: "0.5rem",
                border: "1px solid #e5e5e5", borderRadius: 6,
                fontFamily: "inherit", fontSize: "0.875rem", resize: "vertical",
              }}
            />
          </div>

          {globalError && <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{globalError}</p>}
          {summary && (
            <p style={{ color: allDone ? "#15803d" : "#92400e", fontSize: "0.9rem" }}>{summary}</p>
          )}

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="submit"
              className="btn btnPrimary"
              disabled={uploading || queue.length === 0 || !hasQueued}
            >
              {uploading
                ? "Uploading…"
                : queue.length > 1
                ? `Upload ${queue.filter((q) => q.status === "queued" || q.status === "error").length} file${queue.filter((q) => q.status === "queued" || q.status === "error").length !== 1 ? "s" : ""}`
                : "Upload"}
            </button>
            {queue.length > 0 && !uploading && (
              <button
                type="button"
                className="btn btnSecondary"
                onClick={() => { setQueue([]); setSummary(null); setGlobalError(null); }}
              >
                Clear all
              </button>
            )}
            <Link href="/documents" className="btn btnSecondary" style={{ textDecoration: "none" }}>
              View documents
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
