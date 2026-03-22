"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { DocumentDropZone } from "../../components/DocumentDropZone";

function sanitizeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

export default function UploadDocumentPage() {
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  const supabase = useMemo(() => createClient(), []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setUploadSuccess(null);
    if (!file) {
      setUploadError("Please select or drop a file to upload.");
      return;
    }

    setUploading(true);
    const fileName = file.name;

    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        setUploadError("You must be signed in to upload documents.");
        setUploading(false);
        return;
      }

      const safeName = sanitizeFileName(fileName);
      const filePath = `${user.id}/${Date.now()}-${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from("documents")
        .upload(filePath, file, { upsert: false });

      if (uploadErr) {
        setUploadError(
          (uploadErr as { message?: string }).message
            ? `Upload failed: ${(uploadErr as { message?: string }).message}`
            : "Upload failed. Check your connection and try again."
        );
        setUploading(false);
        return;
      }

      const trimmedDocumentType = documentType.trim();
      const trimmedCounty = county.trim();
      const trimmedState = state.trim();
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

      const { error: insertErr } = await supabase
        .from("documents")
        .insert(insertPayload)
        .select("id")
        .maybeSingle();

      if (insertErr) {
        await supabase.storage.from("documents").remove([filePath]);
        setUploadError(
          "We couldn't save the document record. The file was removed. Please try again."
        );
        setUploading(false);
        return;
      }

      setFile(null);
      setDocumentType("");
      setCounty("");
      setState("");
      setUploadSuccess("Document uploaded successfully. You can view it in Documents.");
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      setUploadError(
        rawMessage === "Load failed" || rawMessage === "Failed to fetch"
          ? "Network error. Check your connection and Supabase URL."
          : rawMessage || "Upload failed. Please try again."
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="container">
      <div className="pageHeader">
        <h1>Upload document</h1>
        <p>Drag and drop or select a file to upload mineral deeds and related documents</p>
      </div>

      <div className="card">
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Choose a file
        </h2>
        <div style={{ marginBottom: "1rem" }}>
          <DocumentDropZone
            onFileSelect={setFile}
            disabled={uploading}
          />
        </div>
        {file && (
          <p style={{ fontSize: "0.9rem", color: "#555", marginBottom: "1rem" }}>
            Selected: <strong>{file.name}</strong> ({(file.size / 1024).toFixed(1)} KB)
          </p>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 400 }}>
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
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button
              type="submit"
              className="btn btnPrimary"
              disabled={uploading || !file}
            >
              {uploading ? "Uploading…" : "Upload"}
            </button>
            <Link href="/documents" className="btn btnSecondary" style={{ textDecoration: "none" }}>
              View documents
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
