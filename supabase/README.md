# Supabase setup

## Migrations

Run the SQL in `migrations/` in order in the Supabase Dashboard (**SQL Editor**) or via the Supabase CLI:

- `001_initial_schema.sql` – base tables
- `002_documents_upload_schema.sql` – documents table columns for uploads (file_name, document_type, county, storage_path)
- `003_storage_documents_bucket.sql` – creates the **documents** storage bucket and RLS policies for uploads. Run this for the /documents upload flow to work.
- `011_document_extractions_structured_data.sql` – add `structured_data` JSONB column (legacy `structured_json` still supported)

## Storage bucket for documents

The app uploads files to a bucket named **documents**. Run `003_storage_documents_bucket.sql` to create the bucket and policies. Or create the bucket in Dashboard → Storage and add RLS policies on **storage.objects** for INSERT and SELECT with `bucket_id = 'documents'`.

After the bucket and policies exist, the `/documents` page can upload PDF and CSV files and list them from the `documents` table.
