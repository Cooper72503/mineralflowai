-- ============================================================
-- Deal pipeline: stage tracking + notes
-- Run this in the Supabase SQL editor or via CLI
-- ============================================================

-- 1. Deal stage column on documents
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS deal_stage TEXT NOT NULL DEFAULT 'new_lead'
  CHECK (deal_stage IN (
    'new_lead',
    'screening',
    'pursuing',
    'under_loi',
    'due_diligence',
    'closed_won',
    'closed_lost',
    'passed'
  ));

CREATE INDEX IF NOT EXISTS documents_deal_stage_idx ON documents (deal_stage);

-- 2. Per-document notes
CREATE TABLE IF NOT EXISTS document_notes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  note        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE document_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_own_notes" ON document_notes;
CREATE POLICY "users_own_notes" ON document_notes
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS document_notes_document_id_idx ON document_notes (document_id);
CREATE INDEX IF NOT EXISTS document_notes_user_id_idx     ON document_notes (user_id);
