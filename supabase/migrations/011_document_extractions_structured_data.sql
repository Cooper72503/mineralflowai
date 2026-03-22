-- Preferred storage for the full AI/OCR structured extraction payload.
-- Kept separate from the legacy `structured_json` column for backward compatibility.
ALTER TABLE document_extractions
ADD COLUMN IF NOT EXISTS structured_data JSONB;
