-- Store full AI structured extraction output for debugging/auditing.
-- This is separate from the flattened columns so we can persist the exact JSON shape.
ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS structured_json JSONB;

