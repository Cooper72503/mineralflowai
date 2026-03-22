-- Document processing pipeline: timestamps and error message for status workflow.
-- Status values: uploaded | processing | processed | failed

ALTER TABLE documents ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS error_message TEXT;

COMMENT ON COLUMN documents.status IS 'uploaded | processing | processed | failed';
COMMENT ON COLUMN documents.processed_at IS 'Set when status becomes processed';
COMMENT ON COLUMN documents.error_message IS 'Set when status becomes failed; reason for failure';
