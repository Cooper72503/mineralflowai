-- Add file_path and status columns for document uploads (status = 'uploaded' after successful storage upload).

ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_path TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'uploaded';

-- Optional: backfill file_path from storage_path for existing rows
UPDATE documents SET file_path = storage_path WHERE file_path IS NULL AND storage_path IS NOT NULL;
