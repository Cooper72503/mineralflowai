-- Ensure extraction/processing columns exist.
-- This migration is intentionally idempotent (uses IF NOT EXISTS) so the app
-- can keep working even if earlier migrations were partially applied.

-- document_extractions: required by the API route payload
ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS extracted_text TEXT;

ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS structured_data JSONB;

ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS confidence NUMERIC(5, 4);

ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS model TEXT;

ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS error_message TEXT;

-- documents: required by the API route status updates
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE documents
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

