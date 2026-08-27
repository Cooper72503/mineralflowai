declare module "pdf-parse" {
  type PdfParseResult = {
    numpages: number;
    numrender: number;
    text: string;
    info?: unknown;
    metadata?: unknown;
    version?: string | null;
  };

  function pdfParse(
    dataBuffer: Buffer,
    options?: { max?: number; version?: string }
  ): Promise<PdfParseResult>;

  export = pdfParse;
}

// The real implementation, imported directly by extract-apis/route.ts to
// avoid a debug-mode crash in the package's top-level index.js — see that
// route for the full explanation. Same shape as the module above.
declare module "pdf-parse/lib/pdf-parse.js" {
  type PdfParseResult = {
    numpages: number;
    numrender: number;
    text: string;
    info?: unknown;
    metadata?: unknown;
    version?: string | null;
  };

  function pdfParse(
    dataBuffer: Buffer,
    options?: { max?: number; version?: string }
  ): Promise<PdfParseResult>;

  export = pdfParse;
}
