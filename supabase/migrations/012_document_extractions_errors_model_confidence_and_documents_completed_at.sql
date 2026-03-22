-- Extend document processing schema for safer, debuggable pipeline runs.
-- Requirements:
-- - document_extractions: extracted_text, structured_data (jsonb), confidence, model, error_message, created_at
-- - documents: status, error_message, completed_at (keep existing processed_at for backwards compatibility)

ALTER TABLE documents
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Keep processed_at updated by the app, but ensure it exists (older migrations add it).
ALTER TABLE documents
ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

ALTER TABLE documents
ADD COLUMN IF NOT EXISTS error_message TEXT;

-- document_extractions additional metadata + error persistence.
ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS structured_data JSONB;

ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS confidence NUMERIC(5, 4);

ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS model TEXT;

ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Optional indexes for common lookups (safe if already exist).
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_document_extractions_created_at ON document_extractions(created_at);

