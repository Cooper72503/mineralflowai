-- Add user_id, state, and file_size to documents; scope RLS by user_id.

-- Columns
ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_size BIGINT;

-- Index for user-scoped queries
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);

-- RLS: replace broad policies with user-scoped ones
DROP POLICY IF EXISTS "documents_authenticated_select" ON documents;
CREATE POLICY "documents_authenticated_select"
  ON documents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "documents_authenticated_insert" ON documents;
CREATE POLICY "documents_authenticated_insert"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Allow users to update/delete only their own rows (e.g. delete document)
DROP POLICY IF EXISTS "documents_authenticated_update" ON documents;
CREATE POLICY "documents_authenticated_update"
  ON documents FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "documents_authenticated_delete" ON documents;
CREATE POLICY "documents_authenticated_delete"
  ON documents FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Backfill user_id for existing rows: optional (leave NULL if no way to attribute).
-- New uploads will always set user_id via the app.
