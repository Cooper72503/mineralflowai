-- ============================================================
-- CRITICAL: Enable Row Level Security on documents tables
-- Without this every user can see every other user's documents.
-- ============================================================

-- ── documents ────────────────────────────────────────────────
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Drop any existing policies first so this is idempotent
DROP POLICY IF EXISTS "users_own_documents_select"  ON documents;
DROP POLICY IF EXISTS "users_own_documents_insert"  ON documents;
DROP POLICY IF EXISTS "users_own_documents_update"  ON documents;
DROP POLICY IF EXISTS "users_own_documents_delete"  ON documents;

CREATE POLICY "users_own_documents_select"
  ON documents FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_own_documents_insert"
  ON documents FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_documents_update"
  ON documents FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_documents_delete"
  ON documents FOR DELETE
  USING (auth.uid() = user_id);

-- ── document_extractions ─────────────────────────────────────
ALTER TABLE document_extractions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_extractions_select" ON document_extractions;
DROP POLICY IF EXISTS "users_own_extractions_insert" ON document_extractions;
DROP POLICY IF EXISTS "users_own_extractions_update" ON document_extractions;
DROP POLICY IF EXISTS "users_own_extractions_delete" ON document_extractions;

CREATE POLICY "users_own_extractions_select"
  ON document_extractions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_own_extractions_insert"
  ON document_extractions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_extractions_update"
  ON document_extractions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_own_extractions_delete"
  ON document_extractions FOR DELETE
  USING (auth.uid() = user_id);

-- ── document_notes (already has RLS — refresh policies) ──────
ALTER TABLE document_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_notes" ON document_notes;

CREATE POLICY "users_own_notes"
  ON document_notes FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
