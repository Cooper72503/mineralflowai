-- RLS on public.documents so authenticated users can insert and select.
-- Without this, "new row violates row-level security policy" occurs when RLS is enabled.

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to select all document rows (scope by org/user later if needed)
DROP POLICY IF EXISTS "documents_authenticated_select" ON documents;
CREATE POLICY "documents_authenticated_select"
  ON documents FOR SELECT
  TO authenticated
  USING (true);

-- Allow authenticated users to insert rows (only allowed columns: file_name, document_type, county, extraction_status, storage_path)
DROP POLICY IF EXISTS "documents_authenticated_insert" ON documents;
CREATE POLICY "documents_authenticated_insert"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (true);
