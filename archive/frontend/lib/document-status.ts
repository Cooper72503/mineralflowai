export const DOCUMENT_STATUSES = ["uploaded", "queued", "processing", "completed", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
