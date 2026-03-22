-- Allow authenticated users to delete only their own objects in the documents bucket.
-- Path format is {user_id}/{timestamp}-{filename}, so first path segment = auth.uid().

DROP POLICY IF EXISTS "documents authenticated delete" ON storage.objects;
CREATE POLICY "documents authenticated delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
