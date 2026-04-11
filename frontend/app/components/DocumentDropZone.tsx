"use client";

import { useCallback, useState } from "react";

const ACCEPT_TYPES = ".pdf,.csv,.txt";
const ALLOWED_EXTENSIONS = [".pdf", ".csv", ".txt"];

export type DocumentDropZoneProps = {
  accept?: string;
  maxSizeBytes?: number;
  onFileSelect: (file: File | File[]) => void;
  disabled?: boolean;
  className?: string;
  /** Allow selecting multiple files at once. */
  multiple?: boolean;
};

export function DocumentDropZone({
  accept = ACCEPT_TYPES,
  maxSizeBytes = 20 * 1024 * 1024,
  onFileSelect,
  disabled = false,
  className = "",
  multiple = false,
}: DocumentDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateFile = useCallback(
    (file: File): string | null => {
      const lowerName = file.name.toLowerCase();
      const hasAllowedExtension = ALLOWED_EXTENSIONS.some((ext) =>
        lowerName.endsWith(ext)
      );
      if (!hasAllowedExtension) {
        return "Unsupported file type. Allowed: PDF, CSV, TXT.";
      }
      if (file.size > maxSizeBytes) {
        const mb = (maxSizeBytes / (1024 * 1024)).toFixed(0);
        return `File is too large. Maximum size is ${mb} MB.`;
      }
      return null;
    },
    [maxSizeBytes]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      setError(null);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      const errors = files.map(validateFile).filter(Boolean);
      if (errors.length > 0) { setError(errors[0]!); return; }
      if (multiple) {
        onFileSelect(files);
      } else {
        onFileSelect(files[0]);
      }
    },
    [disabled, multiple, onFileSelect, validateFile]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      setIsDragging(true);
      setError(null);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setError(null);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setError(null);
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      const errors = files.map(validateFile).filter(Boolean);
      if (errors.length > 0) { setError(errors[0]!); e.target.value = ""; return; }
      if (multiple) {
        onFileSelect(files);
      } else {
        onFileSelect(files[0]);
      }
      e.target.value = "";
    },
    [multiple, onFileSelect, validateFile]
  );

  return (
    <div className={className}>
      <label
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        style={{
          display: "block",
          border: `2px dashed ${isDragging ? "#1a1a1a" : "#e5e5e5"}`,
          borderRadius: 8,
          padding: "2rem",
          textAlign: "center",
          background: isDragging ? "#f5f5f5" : "#fafafa",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.7 : 1,
        }}
      >
        <input
          type="file"
          accept={accept}
          onChange={handleChange}
          disabled={disabled}
          multiple={multiple}
          style={{ display: "none" }}
          aria-label="Choose file"
        />
        <p style={{ fontSize: "0.95rem", color: "#555", marginBottom: "0.25rem" }}>
          {isDragging
            ? `Drop file${multiple ? "s" : ""} here`
            : `Drag and drop ${multiple ? "files" : "a file"} here, or click to browse`}
        </p>
        <p style={{ fontSize: "0.8rem", color: "#888" }}>
          PDF, TXT, CSV — max 20 MB{multiple ? " per file" : ""}
        </p>
      </label>
      {error && (
        <p style={{ color: "#b91c1c", fontSize: "0.9rem", marginTop: "0.5rem" }}>
          {error}
        </p>
      )}
    </div>
  );
}
