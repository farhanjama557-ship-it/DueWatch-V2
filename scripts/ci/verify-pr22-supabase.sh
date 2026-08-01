#!/usr/bin/env bash
# PR #22 CI verification wrapper.
#
# Applies the repository schema and the Phase 0 canonical-clients migration
# to a local, ephemeral `supabase start` instance, then runs the existing
# (unmodified) SQL test suites against it and records evidence of what
# happened. This script does not alter test assertions or gate logic — it
# only orchestrates running the tests that already exist in the repository
# and captures their output for the CI artifact.
#
# Required env: DB_URL (local Supabase Postgres connection string).
# Writes all evidence files into $ARTIFACT_DIR (default: ./pr22-verify-artifact).

set -uo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./pr22-verify-artifact}"
mkdir -p "$ARTIFACT_DIR"

FK_WARNING="WARNING: LOCAL REPOSITORY-SCHEMA SMOKE CHECK ONLY. THIS IS NOT STAGING AND DOES NOT SATISFY LIVE SCHEMA-DRIFT VERIFICATION."

overall_status=0

section() {
  echo ""
  echo "=== $1 ==="
}

require_db_url() {
  if [ -z "${DB_URL:-}" ]; then
    echo "DB_URL is not set" >&2
    exit 2
  fi
}

require_db_url

section "Applying repository schema (supabase/schema.sql)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/schema.sql \
  > "$ARTIFACT_DIR/01_schema_apply.log" 2>&1
schema_exit=$?
echo "schema.sql exit code: $schema_exit" | tee -a "$ARTIFACT_DIR/01_schema_apply.log"
if [ "$schema_exit" -ne 0 ]; then
  overall_status=1
fi

section "Applying PR #22 migration (supabase/migrations/20260726000000_canonical_clients.sql)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20260726000000_canonical_clients.sql \
  > "$ARTIFACT_DIR/02_migration_apply.log" 2>&1
migration_exit=$?
echo "migration exit code: $migration_exit" | tee -a "$ARTIFACT_DIR/02_migration_apply.log"
if [ "$migration_exit" -ne 0 ]; then
  overall_status=1
fi

if [ "$schema_exit" -ne 0 ] || [ "$migration_exit" -ne 0 ]; then
  echo "Schema or migration application failed; skipping downstream tests." >&2
  echo "$overall_status" > "$ARTIFACT_DIR/OVERALL_EXIT_CODE"
  exit "$overall_status"
fi

section "Running supabase/tests/canonical_clients_test.sql (transactional integration test, unmodified)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/canonical_clients_test.sql \
  > "$ARTIFACT_DIR/03_integration_test.log" 2>&1
integration_exit=$?
echo "integration test exit code: $integration_exit" | tee -a "$ARTIFACT_DIR/03_integration_test.log"
if [ "$integration_exit" -ne 0 ]; then
  overall_status=1
fi

section "Rollback verification (post-test state checks)"
{
  echo "Transaction boundary: supabase/tests/canonical_clients_test.sql wraps its"
  echo "entire body in a single 'begin; ... rollback;' block (see file header)."
  echo "Rollback mechanism: the script's own trailing 'rollback;' statement,"
  echo "executed by psql on the same session/transaction that ran the test."
  echo ""
  echo "Post-test checks (run in a fresh session after the test script exited):"
} > "$ARTIFACT_DIR/04_rollback_evidence.log"

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -A -F' | ' <<'SQL' >> "$ARTIFACT_DIR/04_rollback_evidence.log" 2>&1
select
  (select count(*) from auth.users where email = 'phase0-test@example.test')
    as leftover_test_auth_users,
  (select count(*) from public.clients
     where email = 'billing@example.test'
        or (company = 'Shared Office')
        or (name = 'Different Company'))
    as leftover_test_clients,
  (select count(*) from public.client_dedup_runs) as leftover_dedup_runs,
  (select count(*) from public.client_merge_candidates) as leftover_merge_candidates,
  (select execution_enabled from duewatch_ops.client_dedup_config where singleton)
    as execution_enabled_after_test;
SQL
rollback_query_exit=$?

leftover_summary=$(psql "$DB_URL" -X -t -A -F',' <<'SQL'
select
  (select count(*) from auth.users where email = 'phase0-test@example.test'),
  (select count(*) from public.clients
     where email = 'billing@example.test'
        or (company = 'Shared Office')
        or (name = 'Different Company')),
  (select count(*) from public.client_dedup_runs),
  (select count(*) from public.client_merge_candidates),
  (select execution_enabled::text from duewatch_ops.client_dedup_config where singleton);
SQL
)
IFS=',' read -r leftover_users leftover_clients leftover_runs leftover_candidates exec_enabled_after <<< "$leftover_summary"

rollback_clean=1
if [ "$rollback_query_exit" -ne 0 ]; then
  rollback_clean=0
fi
if [ "${leftover_users:-1}" != "0" ] || [ "${leftover_clients:-1}" != "0" ] \
   || [ "${leftover_runs:-1}" != "0" ] || [ "${leftover_candidates:-1}" != "0" ] \
   || [ "${exec_enabled_after:-true}" != "false" ]; then
  rollback_clean=0
fi

{
  echo ""
  if [ "$rollback_clean" -eq 1 ]; then
    echo "ROLLBACK VERIFIED: no test fixtures, dedup runs, candidates, or config"
    echo "mutations from the transactional integration test remained in the"
    echo "database after it exited. execution_enabled correctly reverted to false."
  else
    echo "ROLLBACK CHECK FAILED: leftover rows or config mutation detected."
    echo "leftover_users=${leftover_users:-?} leftover_clients=${leftover_clients:-?}"
    echo "leftover_runs=${leftover_runs:-?} leftover_candidates=${leftover_candidates:-?}"
    echo "execution_enabled_after_test=${exec_enabled_after:-?}"
    overall_status=1
  fi
} >> "$ARTIFACT_DIR/04_rollback_evidence.log"

section "Repository-schema FK smoke check (NOT staging verification)"
{
  echo "$FK_WARNING"
  echo ""
  echo "This step runs supabase/verification/phase0_foreign_keys.sql against a"
  echo "fresh local database built ONLY from this repository's schema.sql and"
  echo "the Phase 0 migration. It cannot detect foreign keys, tables, or"
  echo "relationships that exist only in a live/staging/production database."
  echo "It does not satisfy PR #22's staging-fidelity readiness gate."
} > "$ARTIFACT_DIR/05_fk_smoke_check.log"

psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/verification/phase0_foreign_keys.sql \
  >> "$ARTIFACT_DIR/05_fk_smoke_check.log" 2>&1
fk_exit=$?
echo "" >> "$ARTIFACT_DIR/05_fk_smoke_check.log"
echo "FK smoke check exit code: $fk_exit" >> "$ARTIFACT_DIR/05_fk_smoke_check.log"
echo "" >> "$ARTIFACT_DIR/05_fk_smoke_check.log"
echo "$FK_WARNING" >> "$ARTIFACT_DIR/05_fk_smoke_check.log"
if [ "$fk_exit" -ne 0 ]; then
  overall_status=1
fi

echo "$overall_status" > "$ARTIFACT_DIR/OVERALL_EXIT_CODE"
echo "schema_exit=$schema_exit migration_exit=$migration_exit integration_exit=$integration_exit rollback_clean=$rollback_clean fk_exit=$fk_exit" \
  > "$ARTIFACT_DIR/EXIT_CODE_SUMMARY.txt"

exit "$overall_status"
