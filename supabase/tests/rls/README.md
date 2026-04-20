# Supabase RLS Test Suite

SQL-based assertion tests for Row Level Security invariants. Each file
maps 1:1 to a migration and validates the policies that migration introduces.

## Running locally

```bash
# 1. Reset local Supabase to a clean state (applies all migrations)
supabase db reset

# 2. Run the tests against the local DB
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -f supabase/tests/rls/021_team_governance_rls.sql
```

Each script:

- Wraps every test in `BEGIN ... ROLLBACK` so fixture rows never persist.
- Uses `_rls_test_impersonate(uid)` to switch to the `authenticated` role
  with a synthetic `auth.uid()` claim — this is how PostgREST behaves at
  runtime, so RLS policies are exercised exactly as in production.
- RAISEs on assertion failure; a successful run ends with
  `ALL RLS TESTS PASSED`.

## Running in CI

The CI pipeline does not yet run these scripts (no Supabase-in-CI yet).
Follow-up PR will add a `supabase start` + `psql -f` step once we stand up
a local-stack job. Until then, run manually before merging migrations that
touch RLS.

## Invariants documented per suite

See the header comment at the top of each `*.sql` file for the specific
security invariants that suite asserts.
