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
