-- Ensure `document_extractions` follows the "one row per document" model.
-- The app uses `upsert(..., { onConflict: "document_id" })`, so we must have
-- a UNIQUE constraint (or unique index) on `document_id`.
--
-- This migration is safe for existing data: if duplicates exist, it keeps the
-- most recently created row per `document_id` and deletes the rest before
-- adding the UNIQUE constraint.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'document_extractions_document_id_unique'
  ) THEN
    -- Dedupe existing rows first so the UNIQUE constraint add doesn't fail.
    WITH ranked AS (
      SELECT
        id,
        document_id,
        created_at,
        ROW_NUMBER() OVER (
          PARTITION BY document_id
          ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS rn
      FROM document_extractions
    )
    DELETE FROM document_extractions d
    USING ranked r
    WHERE d.id = r.id
      AND r.rn > 1;

    -- Required by the app's `ON CONFLICT (document_id)` upsert.
    ALTER TABLE document_extractions
      ADD CONSTRAINT document_extractions_document_id_unique
      UNIQUE (document_id);
  END IF;
END $$;

