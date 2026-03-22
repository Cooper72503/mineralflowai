"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type DocumentRow = {
  id: string;
  file_name: string | null;
  county: string | null;
  state: string | null;
  document_type: string | null;
  file_size: number | null;
  status: string | null;
  storage_path: string | null;
  created_at: string;
  processed_at: string | null;
};

const ACCEPT_TYPES = ".pdf,.csv,.txt";
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadgeClass(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "completed" || s === "processed") return "badge badgeActive";
  if (s === "processing" || s === "queued") return "badge badgeNew";
  if (s === "failed") return "badge badgeFailed";
  return "badge badgePending"; // uploaded or unknown
}

export default function DocumentsPage() {
  const [list, setList] = useState<DocumentRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [searchName, setSearchName] = useState("");
  const [filterCounty, setFilterCounty] = useState("");
  const [filterState, setFilterState] = useState("");
  const [filterDocumentType, setFilterDocumentType] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);

  const filteredList = useMemo(() => {
    let out = list;
    const q = searchName.trim().toLowerCase();
    if (q) {
      out = out.filter((d) => (d.file_name ?? "").toLowerCase().includes(q));
    }
    if (filterCounty.trim()) {
      const c = filterCounty.trim().toLowerCase();
      out = out.filter((d) => (d.county ?? "").toLowerCase() === c);
    }
    if (filterState.trim()) {
      const s = filterState.trim().toLowerCase();
      out = out.filter((d) => (d.state ?? "").toLowerCase() === s);
    }
    if (filterDocumentType.trim()) {
      const t = filterDocumentType.trim().toLowerCase();
      out = out.filter((d) => (d.document_type ?? "").toLowerCase() === t);
    }
    return out;
  }, [list, searchName, filterCounty, filterState, filterDocumentType]);

  const filterOptions = useMemo(() => {
    const counties = new Set<string>();
    const states = new Set<string>();
    const types = new Set<string>();
    list.forEach((d) => {
      if (d.county?.trim()) counties.add(d.county.trim());
      if (d.state?.trim()) states.add(d.state.trim());
      if (d.document_type?.trim()) types.add(d.document_type.trim());
    });
    return {
      counties: Array.from(counties).sort(),
      states: Array.from(states).sort(),
      documentTypes: Array.from(types).sort(),
    };
  }, [list]);

  async function loadDocuments() {
    setListLoading(true);
    setListError(null);
    try {
      const { data, error } = await supabase
        .from("documents")
        .select("id, file_name, county, state, document_type, file_size, status, storage_path, created_at, processed_at")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("[Documents] Fetch error:", {
          message: error.message,
          code: (error as { code?: string }).code,
          details: (error as { details?: string }).details,
          hint: (error as { hint?: string }).hint,
        });
        setListError(
          error.code === "PGRST301"
            ? "You don't have permission to view documents. Sign in or check access."
            : error.message || "Failed to load documents. Please try again."
        );
        setList([]);
        return;
      }
      setList((data as DocumentRow[]) ?? []);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      console.error("[Documents] Documents fetch failed:", err);
      const displayMessage =
        rawMessage === "Load failed" || rawMessage === "Failed to fetch"
          ? "Network error: could not reach the server. Check your connection and that NEXT_PUBLIC_SUPABASE_URL is correct."
          : rawMessage || "Unable to load documents. Check your connection and try again.";
      setListError(displayMessage);
      setList([]);
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => {
    loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  async function handleDownload(doc: DocumentRow) {
    setActionError(null);
    const file_path = doc.storage_path ?? null;
    if (!file_path) {
      setActionError("No file available for this document.");
      return;
    }
    console.log("[Documents] createSignedUrl using file_path from documents table:", file_path);
    try {
      const { data, error } = await supabase.storage
        .from("documents")
        .createSignedUrl(file_path, 60);
      if (error) {
        const isNotFound =
          (error.message ?? "").toLowerCase().includes("not found") ||
          (error.message ?? "").toLowerCase().includes("object not found");
        setActionError(
          isNotFound
            ? "This file is no longer available. It may have been moved or deleted."
            : error.message || "Failed to get download link."
        );
        return;
      }
      if (data?.signedUrl) {
        window.open(data.signedUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Download failed.");
    }
  }

  async function handleDelete(doc: DocumentRow) {
    setActionError(null);
    setDeletingId(doc.id);
    try {
      if (doc.storage_path) {
        await supabase.storage.from("documents").remove([doc.storage_path]);
      }
      const { error } = await supabase.from("documents").delete().eq("id", doc.id);
      if (error) {
        setActionError(error.message || "Failed to delete document record.");
        setDeletingId(null);
        return;
      }
      await loadDocuments();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  /** Build a single line from Supabase/PostgREST error for UI. */
  function supabaseErrorMessage(err: { message?: string; code?: string; details?: string; hint?: string }): string {
    const msg = err?.message || "Unknown error";
    const parts = [msg];
    if (err?.code) parts.push(`[${err.code}]`);
    if (err?.details) parts.push(err.details);
    if (err?.hint) parts.push(`Hint: ${err.hint}`);
    return parts.join(" ");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setUploadSuccess(null);

    if (!file) {
      setUploadError("Please select a file to upload.");
      return;
    }

    const trimmedDocumentType = documentType.trim();
    const trimmedCounty = county.trim();

    const lowerName = file.name.toLowerCase();
    const allowedExtensions = [".pdf", ".csv", ".txt"];
    const hasAllowedExtension = allowedExtensions.some((ext) =>
      lowerName.endsWith(ext)
    );
    if (!hasAllowedExtension) {
      setUploadError("Unsupported file type. Allowed types: PDF, CSV, and TXT.");
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      const mb = (MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
      setUploadError(`File is too large. Maximum size is ${mb} MB.`);
      return;
    }

    setUploading(true);
    const fileName = file.name;

    try {
      // --- Get authenticated user for namespacing storage path and RLS on documents table ---
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        console.error("[Documents] Auth error before upload:", userErr);
        setUploadError("Authentication failed: you must be signed in to upload documents.");
        return;
      }

      const safeName = sanitizeFileName(fileName);
      // Single path used for both Storage and documents row (exact same value in both).
      const filePath = `${user.id}/${Date.now()}-${safeName}`;

      // --- Step 1: Storage upload ---
      console.log("[Documents] Step 1: Storage upload starting → bucket 'documents', path:", filePath);
      const { error: uploadErr } = await supabase.storage
        .from("documents")
        .upload(filePath, file, { upsert: false });

      if (uploadErr) {
        console.error("[Documents] Step 1: Storage upload FAILED.", {
          message: (uploadErr as { message?: string }).message,
          error: uploadErr,
          serialized: JSON.stringify(uploadErr, Object.getOwnPropertyNames(uploadErr), 2),
        });
        const storageMsg = (uploadErr as { message?: string }).message;
        setUploadError(
          storageMsg
            ? `Upload failed: ${storageMsg}`
            : "Upload failed. Check your connection and try again."
        );
        setUploading(false);
        return;
      }
      console.log("[Documents] Step 1: Storage upload SUCCESS, path:", filePath);

      // --- Step 2: Database insert (table: documents) — only after storage upload succeeded ---
      const trimmedState = (state as string).trim();
      const insertPayload = {
        user_id: user.id,
        file_name: fileName,
        file_path: filePath,
        file_size: file.size,
        county: trimmedCounty || null,
        state: trimmedState || null,
        document_type: trimmedDocumentType || null,
        status: "uploaded",
        storage_path: filePath,
      };
      console.log("[Documents] Step 2: Database insert → table 'documents', payload:", insertPayload);

      const { data: insertData, error: insertErr } = await supabase
        .from("documents")
        .insert(insertPayload)
        .select("id")
        .maybeSingle();

      if (insertErr) {
        console.error("[Documents] Step 2: Database insert FAILED.", {
          message: insertErr.message,
          code: (insertErr as { code?: string }).code,
          details: (insertErr as { details?: string }).details,
          hint: (insertErr as { hint?: string }).hint,
          serialized: JSON.stringify(insertErr, Object.getOwnPropertyNames(insertErr), 2),
        });
        // Rollback: remove from Storage so Storage and DB stay consistent.
        const { error: removeErr } = await supabase.storage.from("documents").remove([filePath]);
        if (removeErr) {
          console.error("[Documents] Rollback: failed to remove file from Storage after insert failure.", {
            path: filePath,
            error: removeErr,
          });
        } else {
          console.log("[Documents] Rollback: removed file from Storage, path:", filePath);
        }
        setUploadError(
          "We couldn't save the document record. The file was removed. Please try again."
        );
        setUploading(false);
        return;
      }
      console.log("[Documents] Step 2: Database insert SUCCESS, id:", (insertData as { id?: string })?.id);

      setFile(null);
      setDocumentType("");
      setCounty("");
      setState("");
      if (typeof document !== "undefined" && document.getElementById("file-input") instanceof HTMLInputElement) {
        (document.getElementById("file-input") as HTMLInputElement).value = "";
      }
      await loadDocuments();
      setUploadSuccess("Document uploaded successfully.");
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      console.error("[Documents] Upload error (unexpected throw):", {
        message: rawMessage,
        error: err,
        stack: err instanceof Error ? err.stack : undefined,
      });
      const displayMessage =
        rawMessage === "Load failed" || rawMessage === "Failed to fetch"
          ? "Network error: could not reach the server. Check your connection and Supabase URL."
          : rawMessage || "Upload failed. Please try again.";
      setUploadError(displayMessage);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Documents</h1>
        <p>Upload and manage mineral deeds and related documents</p>
      </div>

      <div className="card">
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Upload document
        </h2>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 400 }}>
          <div>
            <label htmlFor="file-input" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              File (PDF, CSV, or TXT)
            </label>
            <input
              id="file-input"
              type="file"
              accept={ACCEPT_TYPES}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ width: "100%", padding: "0.5rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
            />
          </div>
          <div>
            <label htmlFor="document-type" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              Document type
            </label>
            <input
              id="document-type"
              type="text"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              placeholder="e.g. Mineral Deed, Lease"
              style={{ width: "100%", padding: "0.5rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
            />
          </div>
          <div>
            <label htmlFor="county" style={{ display: "block", marginBottom: "0.35rem", fontSize: "0.9rem", color: "#555" }}>
              County
            </label>
            <input
              id="county"
              type="text"
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              placeholder="e.g. Reeves, Loving"
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
              placeholder="e.g. Texas, New Mexico"
              style={{ width: "100%", padding: "0.5rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
            />
          </div>
          {uploadError && (
            <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{uploadError}</p>
          )}
          {uploadSuccess && (
            <p style={{ color: "#15803d", fontSize: "0.9rem" }}>{uploadSuccess}</p>
          )}
          <button
            type="submit"
            className="btn btnPrimary"
          disabled={uploading || !file}
            style={{ alignSelf: "flex-start" }}
          >
          {uploading ? "Uploading…" : "Upload"}
          </button>
        </form>
      </div>

      <div className="card" style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Uploaded documents
        </h2>
        {listLoading && <p style={{ color: "#666", fontSize: "0.9rem" }}>Loading…</p>}
        {listError && <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>{listError}</p>}
        {!listLoading && !listError && list.length === 0 && (
          <p style={{ color: "#666", fontSize: "0.9rem" }}>No documents yet. Upload one above.</p>
        )}
        {!listLoading && !listError && list.length > 0 && (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginBottom: "1rem", alignItems: "center" }}>
              <input
                type="search"
                placeholder="Search by file name"
                value={searchName}
                onChange={(e) => setSearchName(e.target.value)}
                style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6, minWidth: 200 }}
                aria-label="Search by file name"
              />
              <select
                value={filterCounty}
                onChange={(e) => setFilterCounty(e.target.value)}
                style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
                aria-label="Filter by county"
              >
                <option value="">All counties</option>
                {filterOptions.counties.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <select
                value={filterState}
                onChange={(e) => setFilterState(e.target.value)}
                style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
                aria-label="Filter by state"
              >
                <option value="">All states</option>
                {filterOptions.states.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                value={filterDocumentType}
                onChange={(e) => setFilterDocumentType(e.target.value)}
                style={{ padding: "0.5rem 0.75rem", border: "1px solid #e5e5e5", borderRadius: 6 }}
                aria-label="Filter by document type"
              >
                <option value="">All types</option>
                {filterOptions.documentTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            {actionError && (
              <p style={{ color: "#b91c1c", fontSize: "0.9rem", marginBottom: "0.75rem" }}>{actionError}</p>
            )}
            {filteredList.length === 0 ? (
              <p style={{ color: "#666", fontSize: "0.9rem" }}>No documents match the current filters.</p>
            ) : (
              <div className="tableWrap">
                <table>
                  <thead>
                    <tr>
                      <th>File name</th>
                      <th>County</th>
                      <th>State</th>
                      <th>Document type</th>
                      <th>File size</th>
                      <th>Status</th>
                      <th>Completed at</th>
                      <th>Created at</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredList.map((doc) => (
                      <tr key={doc.id}>
                        <td>{doc.file_name ?? "—"}</td>
                        <td>{doc.county ?? "—"}</td>
                        <td>{doc.state ?? "—"}</td>
                        <td>{doc.document_type ?? "—"}</td>
                        <td>{formatFileSize(doc.file_size)}</td>
                        <td>
                          <span className={statusBadgeClass(doc.status)}>
                            {doc.status ?? "—"}
                          </span>
                        </td>
                        <td>{doc.processed_at ? formatDate(doc.processed_at) : "—"}</td>
                        <td>{formatDate(doc.created_at)}</td>
                        <td>
                          <span style={{ display: "inline-flex", gap: "0.5rem" }}>
                            <Link
                              href={`/documents/${doc.id}`}
                              className="btn btnSecondary"
                              style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem", textDecoration: "none" }}
                            >
                              View
                            </Link>
                            <button
                              type="button"
                              className="btn btnSecondary"
                              style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem" }}
                              onClick={() => handleDownload(doc)}
                              disabled={!doc.storage_path}
                            >
                              Download
                            </button>
                            <button
                              type="button"
                              className="btn btnSecondary"
                              style={{ padding: "0.35rem 0.6rem", fontSize: "0.85rem", color: "#b91c1c" }}
                              onClick={() => handleDelete(doc)}
                              disabled={deletingId === doc.id}
                            >
                              {deletingId === doc.id ? "Deleting…" : "Delete"}
                            </button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
