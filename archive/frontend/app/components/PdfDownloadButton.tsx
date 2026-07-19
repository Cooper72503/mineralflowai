"use client";

/**
 * Wraps PDFDownloadLink + ScreenResultPdfDocument in a single module so they
 * can be loaded together via one dynamic() import — avoids the white-screen
 * crash that happens when PDFDownloadLink receives a null document prop while
 * ScreenResultPdfDocument is still lazy-loading.
 */

import { PDFDownloadLink } from "@react-pdf/renderer";
import { ScreenResultPdfDocument } from "./ScreenResultPdf";
import type { ScreenResultPdfData } from "./ScreenResultPdf";

export function PdfDownloadButton({
  data,
  fileName,
}: {
  data: ScreenResultPdfData;
  fileName: string;
}) {
  return (
    <PDFDownloadLink
      document={<ScreenResultPdfDocument data={data} />}
      fileName={fileName}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.45rem 0.9rem",
        borderRadius: 6,
        fontSize: "0.82rem",
        fontWeight: 600,
        textDecoration: "none",
        cursor: "pointer",
        background: "#f3f4f6",
        border: "1px solid #d1d5db",
        color: "#374151",
      }}
    >
      {({ loading }: { loading: boolean }) =>
        loading ? "Preparing PDF…" : "⬇ Download PDF"
      }
    </PDFDownloadLink>
  );
}
