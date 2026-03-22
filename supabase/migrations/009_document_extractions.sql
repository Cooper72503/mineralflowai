-- document_extractions: AI/OCR extraction results per document.
-- One row per document; created as placeholder when processing starts, filled by parser.

CREATE TABLE document_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  extracted_text TEXT,
  lessor TEXT,
  lessee TEXT,
  county TEXT,
  state TEXT,
  legal_description TEXT,
  effective_date TEXT,
  recording_date TEXT,
  royalty_rate TEXT,
  term_length TEXT,
  confidence_score NUMERIC(5, 4),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(document_id)
);

CREATE INDEX idx_document_extractions_document_id ON document_extractions(document_id);
CREATE INDEX idx_document_extractions_user_id ON document_extractions(user_id);

ALTER TABLE document_extractions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_extractions_select_own"
  ON document_extractions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "document_extractions_insert_own"
  ON document_extractions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "document_extractions_update_own"
  ON document_extractions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "document_extractions_delete_own"
  ON document_extractions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
