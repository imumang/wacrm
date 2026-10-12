-- CI-ONLY. DO NOT RUN AGAINST ANY REAL DATABASE (the guard below refuses
-- to run unless the database is freshly reset and has no users).
--
-- Give the API roles the table privileges Supabase normally
-- supplies, so the verifiers can exercise Row Level Security.
--
-- WHY THIS EXISTS. No WACRM (or upstream) migration issues table GRANTs;
-- every table relies on the platform's default privileges for the API
-- roles. The Supabase CLI pinned in migrations.yml (2.113.0) leaves
-- those defaults at `Dxtm` (truncate/references/trigger/maintain only)
-- for anon, authenticated and service_role, so a freshly reset database
-- has NO select/insert/update/delete for them. The behavioural verifiers
-- impersonate `authenticated` (SET LOCAL ROLE) to prove account
-- isolation, and fail with "permission denied for table ..." before any
-- policy is evaluated. CLI 2.119.0 leaves `arwdDxtm`, which is why the
-- failure did not reproduce there.
--
-- SCOPE. This file runs only against the throwaway CI database, never
-- against a real project, and is not a migration. It deliberately grants
-- the minimum a signed-in user and the service role need and nothing to
-- anon: RLS remains the only thing that decides which rows are visible,
-- which is exactly what the verifiers then test.
--
-- DEPLOYMENT NOTE. The migrations depend on the platform's default
-- table privileges for anon/authenticated/service_role (standard on
-- hosted Supabase and on CLI >= 2.119.0). A self-hosted or non-Supabase
-- Postgres needs explicit table grants. REMOVE this file and its workflow
-- step when the CLI pin in migrations.yml moves to a version whose
-- default privileges include SELECT/INSERT/UPDATE/DELETE.

-- One DO block: `supabase db query --file` (CLI 2.113.0) runs a single
-- statement, like the verifiers.
DO $$
BEGIN
  -- Fail closed: a real database always has at least one user.
  IF EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'ci-table-privileges.sql refused: this database contains users and is not a fresh CI database';
  END IF;

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
    TO authenticated, service_role;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
    TO authenticated, service_role;

  IF NOT has_table_privilege('authenticated', 'public.historical_import_runs', 'SELECT') THEN
    RAISE EXCEPTION 'CI role privileges were not applied: authenticated cannot SELECT historical_import_runs';
  END IF;
  -- Guard against this file ever widening anon.
  IF has_table_privilege('anon', 'public.historical_import_runs', 'SELECT')
     OR has_table_privilege('anon', 'public.historical_import_runs', 'INSERT') THEN
    RAISE EXCEPTION 'anon must not have table access via the CI privilege file';
  END IF;
END $$;
