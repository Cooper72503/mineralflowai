"use client";

import Link from "next/link";
import { useState } from "react";
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
  const [legalDescription, setLegalDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

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
      const supabase = createClient();
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
      const trimmedLegalDescription = legalDescription.trim();

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

      const { data: docData, error: insertErr } = await supabase
        .from("documents")
        .insert(insertPayload)
        .select("id")
        .maybeSingle();

      if (insertErr || !docData?.id) {
        await supabase.storage.from("documents").remove([filePath]);
        setUploadError(
          "We couldn't save the document record. The file was removed. Please try again."
        );
        setUploading(false);
        return;
      }

      // If the user provided any extraction hints (legal description, county, state),
      // seed a preliminary extraction record so sync-deal-score can use them immediately.
      if (trimmedLegalDescription || trimmedCounty || trimmedState) {
        await supabase.from("document_extractions").insert({
          document_id: docData.id,
          user_id: user.id,
          extracted_text: "",
          legal_description: trimmedLegalDescription || null,
          county: trimmedCounty || null,
          state: trimmedState || null,
          confidence_score: 0,
        });
        // Ignore errors — this is a best-effort hint; full extraction will fill the rest.
      }

      setFile(null);
      setDocumentType("");
      setCounty("");
      setState("");
      setLegalDescription("");
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
        <p>Upload mineral deeds, leases, and related documents for pre-underwriting analysis</p>
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

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 480 }}>
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
              <span style={{ color: "#888", fontWeight: 400 }}>(optional — paste PLSS or metes-and-bounds)</span>
            </label>
            <textarea
              id="legal-description"
              value={legalDescription}
              onChange={(e) => setLegalDescription(e.target.value)}
              placeholder={"e.g. SE/4 of Section 12, Township 140 North, Range 94 West\nor: Township 140 North, Range 94 West, Section 4 SE 1/4"}
              rows={4}
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #e5e5e5",
                borderRadius: 6,
                fontFamily: "inherit",
                fontSize: "0.875rem",
                resize: "vertical",
              }}
            />
            <p style={{ fontSize: "0.8rem", color: "#888", marginTop: "0.25rem" }}>
              Providing this speeds up valuation — the system will also extract it automatically from your document.
            </p>
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
