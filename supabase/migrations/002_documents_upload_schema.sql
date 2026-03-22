-- Documents table for uploads: file_name, document_type, county, extraction_status, storage_path

-- Create table if not present (e.g. only this migration run)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT,
  document_type TEXT,
  county TEXT,
  extraction_status TEXT DEFAULT 'pending',
  storage_path TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- If table already existed from 001_initial_schema, add new columns and migrate
DO $$
BEGIN
  -- Add columns if they don't exist (from old schema that had name, file_path, tract_id, owner_id)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'documents') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'name') AND
       NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'file_name') THEN
      ALTER TABLE documents RENAME COLUMN name TO file_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'file_name') THEN
      ALTER TABLE documents ADD COLUMN file_name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'document_type') THEN
      ALTER TABLE documents ADD COLUMN document_type TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'county') THEN
      ALTER TABLE documents ADD COLUMN county TEXT;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'file_path') AND
       NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'storage_path') THEN
      ALTER TABLE documents RENAME COLUMN file_path TO storage_path;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'storage_path') THEN
      ALTER TABLE documents ADD COLUMN storage_path TEXT;
    END IF;
    ALTER TABLE documents DROP COLUMN IF EXISTS tract_id;
    ALTER TABLE documents DROP COLUMN IF EXISTS owner_id;
    ALTER TABLE documents DROP COLUMN IF EXISTS updated_at;
  END IF;
END $$;
