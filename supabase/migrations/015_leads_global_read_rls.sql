-- Allow any authenticated user to read completed documents and their extractions (global Leads feed).
-- INSERT/UPDATE/DELETE remain scoped to document owner via existing policies.

CREATE POLICY "documents_authenticated_select_completed_global"
  ON documents FOR SELECT
  TO authenticated
  USING (status = 'completed');

CREATE POLICY "document_extractions_select_for_completed_documents"
  ON document_extractions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_extractions.document_id
        AND d.status = 'completed'
    )
  );
