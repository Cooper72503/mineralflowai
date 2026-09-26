-- The worker publishes a package's sealed evidence record and per-API GOLD
-- drafts in one call (about 6 MB for a 12-well package). Under the 8-second
-- limit it inherited from the API connection role, publication timed out and
-- retried on a small instance (live 2026-09-26). Only the service role, used
-- by the worker and administrative scripts, gets a longer limit; client roles
-- keep theirs.
alter role service_role set statement_timeout = '60s';
notify pgrst, 'reload config';
