-- Create the "documents" storage bucket and allow uploads/reads via anon and authenticated.
-- Without this bucket and policies, storage.from("documents").upload() fails (e.g. bucket not found or 401).

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- RLS on storage.objects: allow INSERT and SELECT for the documents bucket (anon + authenticated).
-- By default Storage allows no uploads without these policies.

DROP POLICY IF EXISTS "documents anon insert" ON storage.objects;
CREATE POLICY "documents anon insert"
ON storage.objects FOR INSERT TO anon
WITH CHECK (bucket_id = 'documents');

DROP POLICY IF EXISTS "documents anon select" ON storage.objects;
CREATE POLICY "documents anon select"
ON storage.objects FOR SELECT TO anon
USING (bucket_id = 'documents');

DROP POLICY IF EXISTS "documents authenticated insert" ON storage.objects;
CREATE POLICY "documents authenticated insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'documents');

DROP POLICY IF EXISTS "documents authenticated select" ON storage.objects;
CREATE POLICY "documents authenticated select"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'documents');
