-- Purchaser run statements a user supplies for a package: what the seller's
-- purchaser bought from each lease by month, read from the statement text.
-- Seller-supplied evidence, kept apart from TRRC's reported production and
-- reconciled against it when the deal is built. The PDF itself is not
-- stored; its SHA-256 identifies the file the rows were read from.
create table public.trrc_package_sales_statements (
 id uuid primary key default gen_random_uuid(),
 package_id uuid not null references public.trrc_packages(id) on delete cascade,
 user_id uuid not null references auth.users(id),
 file_name text not null check (length(file_name) between 1 and 300),
 file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
 page_count integer not null check (page_count > 0),
 pages_without_text integer not null default 0 check (pages_without_text >= 0),
 purchasers text[] not null default '{}',
 rows_json jsonb not null check (jsonb_typeof(rows_json) = 'array'),
 warnings_json jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings_json) = 'array'),
 created_at timestamptz not null default now(),
 unique (package_id, file_sha256)
);
alter table public.trrc_package_sales_statements enable row level security;
revoke all on public.trrc_package_sales_statements from anon, authenticated;
grant select on public.trrc_package_sales_statements to authenticated;
grant select, insert, delete on public.trrc_package_sales_statements to service_role;
create policy sales_statement_owner_read on public.trrc_package_sales_statements for select to authenticated using (user_id = auth.uid());
create index trrc_package_sales_statements_package on public.trrc_package_sales_statements(package_id, created_at);
