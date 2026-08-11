#!/usr/bin/env bash
# Gate 2 verification for Phase 1.5B against a disposable local Supabase stack.
# This script must never be pointed at hosted staging or production.

set -uo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./phase15b-verify-artifact}"
mkdir -p "$ARTIFACT_DIR" "$ARTIFACT_DIR/foundation"
overall_status=0

section() {
  echo ""
  echo "=== $1 ==="
}

record_exit() {
  echo "$1=$2" >> "$ARTIFACT_DIR/EXIT_CODE_SUMMARY.txt"
  [ "$2" -eq 0 ] || overall_status=1
}

if [ -z "${DB_URL:-}" ]; then
  echo "DB_URL is not set" >&2
  exit 2
fi

touch "$ARTIFACT_DIR/EXIT_CODE_SUMMARY.txt"

section "Verifying the merged canonical-client and Gate 1 foundation"
ARTIFACT_DIR="$ARTIFACT_DIR/foundation" \
  scripts/ci/verify-pr22-supabase.sh \
  > "$ARTIFACT_DIR/01_foundation.log" 2>&1
foundation_exit=$?
cat "$ARTIFACT_DIR/01_foundation.log"
record_exit foundation_exit "$foundation_exit"
if [ "$foundation_exit" -ne 0 ]; then
  echo "$overall_status" > "$ARTIFACT_DIR/OVERALL_EXIT_CODE"
  exit "$overall_status"
fi

section "Comparing forward-migrated and fresh-install schema contracts"
# The setup file begins a transaction and temporarily emulates the exact
# old hosted source-identity FK. Closing the psql session would roll it back
# even on failure; the explicit final ROLLBACK makes the evidence unambiguous.
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 \
  -f supabase/tests/phase15b_forward_path_setup.sql \
  -f supabase/migrations/20260811000000_client_source_identities_tenant_fk.sql \
  -f supabase/migrations/20260803150000_import_persistence_core.sql \
  -f supabase/tests/phase15b_schema_fingerprint.sql \
  -c 'rollback;' \
  > "$ARTIFACT_DIR/02_forward_path.log" 2>&1
forward_path_exit=$?
cat "$ARTIFACT_DIR/02_forward_path.log"
forward_fingerprint=$(grep -Eo 'SCHEMA_FINGERPRINT=[0-9a-f]{32}' "$ARTIFACT_DIR/02_forward_path.log" | tail -n 1 | cut -d= -f2)
if [ -z "$forward_fingerprint" ]; then
  forward_path_exit=1
fi
record_exit forward_path_exit "$forward_path_exit"

psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260803150000_import_persistence_core.sql \
  > "$ARTIFACT_DIR/03_migration_apply.log" 2>&1
migration_apply_exit=$?
cat "$ARTIFACT_DIR/03_migration_apply.log"
record_exit migration_apply_exit "$migration_apply_exit"

psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260803150000_import_persistence_core.sql \
  > "$ARTIFACT_DIR/04_migration_reapply.log" 2>&1
migration_reapply_exit=$?
cat "$ARTIFACT_DIR/04_migration_reapply.log"
record_exit migration_reapply_exit "$migration_reapply_exit"

psql "$DB_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
  -f supabase/tests/phase15b_schema_fingerprint.sql \
  > "$ARTIFACT_DIR/05_fresh_fingerprint.log" 2>&1
fresh_fingerprint_exit=$?
cat "$ARTIFACT_DIR/05_fresh_fingerprint.log"
fresh_fingerprint=$(grep -Eo 'SCHEMA_FINGERPRINT=[0-9a-f]{32}' "$ARTIFACT_DIR/05_fresh_fingerprint.log" | tail -n 1 | cut -d= -f2)
if [ -z "$fresh_fingerprint" ]; then
  fresh_fingerprint_exit=1
fi
record_exit fresh_fingerprint_exit "$fresh_fingerprint_exit"

convergence_exit=0
if [ "$forward_path_exit" -ne 0 ] \
   || [ "$fresh_fingerprint_exit" -ne 0 ] \
   || [ "$forward_fingerprint" != "$fresh_fingerprint" ]; then
  convergence_exit=1
fi
{
  echo "forward_fingerprint=${forward_fingerprint:-missing}"
  echo "fresh_fingerprint=${fresh_fingerprint:-missing}"
  echo "convergence_exit=$convergence_exit"
} > "$ARTIFACT_DIR/06_schema_convergence.log"
cat "$ARTIFACT_DIR/06_schema_convergence.log"
record_exit convergence_exit "$convergence_exit"

if [ "$migration_apply_exit" -ne 0 ] \
   || [ "$migration_reapply_exit" -ne 0 ] \
   || [ "$convergence_exit" -ne 0 ]; then
  echo "$overall_status" > "$ARTIFACT_DIR/OVERALL_EXIT_CODE"
  exit "$overall_status"
fi

section "Running Phase 1.5B transactional recovery and security groups"
psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/tests/import_persistence_recovery_test.sql \
  > "$ARTIFACT_DIR/07_recovery_integration.log" 2>&1
recovery_exit=$?
cat "$ARTIFACT_DIR/07_recovery_integration.log"
record_exit recovery_exit "$recovery_exit"

expected_groups=(
  eligibility_deny_by_default
  run_idempotency
  lost_response_retry
  cancellation_between_batches
  failed_batch_rollback
  row_vs_batch_exception_classification
  weak_identity_never_auto_persists
  matched_vs_created_on_source_identity_retry
  invoice_source_identity_and_conflicts
  material_field_preservation
  refresh_reconstruction
  authenticated_import_state_rls
  cross_tenant_rejection
  tenant_safe_fk_constraints
)
group_gate_exit=0
for group in "${expected_groups[@]}"; do
  if grep -q "TEST GROUP PASS: $group" "$ARTIFACT_DIR/07_recovery_integration.log"; then
    echo "$group=pass" >> "$ARTIFACT_DIR/08_group_summary.txt"
  else
    echo "$group=missing" >> "$ARTIFACT_DIR/08_group_summary.txt"
    group_gate_exit=1
  fi
done
passed_group_count=$(grep -c '=pass$' "$ARTIFACT_DIR/08_group_summary.txt")
echo "passed_group_count=$passed_group_count" >> "$ARTIFACT_DIR/08_group_summary.txt"
echo "expected_group_count=${#expected_groups[@]}" >> "$ARTIFACT_DIR/08_group_summary.txt"
cat "$ARTIFACT_DIR/08_group_summary.txt"
record_exit group_gate_exit "$group_gate_exit"

section "Running genuine multi-connection concurrency proofs"
chmod +x supabase/tests/import_persistence_concurrency_proof.sh
supabase/tests/import_persistence_concurrency_proof.sh "$DB_URL" \
  > "$ARTIFACT_DIR/09_batch_concurrency.log" 2>&1
batch_concurrency_exit=$?
cat "$ARTIFACT_DIR/09_batch_concurrency.log"
record_exit batch_concurrency_exit "$batch_concurrency_exit"

chmod +x supabase/tests/import_persistence_run_idempotency_concurrency_proof.sh
supabase/tests/import_persistence_run_idempotency_concurrency_proof.sh "$DB_URL" \
  > "$ARTIFACT_DIR/10_run_idempotency_concurrency.log" 2>&1
run_idempotency_concurrency_exit=$?
cat "$ARTIFACT_DIR/10_run_idempotency_concurrency.log"
record_exit run_idempotency_concurrency_exit "$run_idempotency_concurrency_exit"

section "Verifying rollback cleanliness, privileges, and disabled dedup execution"
residue_state=$(psql "$DB_URL" -X -t -A -F',' -v ON_ERROR_STOP=1 <<'SQL'
select
  (select count(*) from public.import_runs),
  (select count(*) from public.import_batches),
  (select count(*) from public.import_rows),
  (select count(*) from public.import_events),
  (select count(*) from public.clients),
  (select count(*) from public.invoices),
  (select count(*) from public.client_source_identities),
  (select count(*) from auth.users where email like 'ckpt1-%@example.test'
    or email in ('concurrency-proof@example.test', 'run-idem-concurrency-proof@example.test')),
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'start_import_run_debug'),
  (select execution_enabled::text from duewatch_ops.client_dedup_config where singleton),
  has_column_privilege('authenticated', 'public.import_batches', 'internal_diagnostic', 'SELECT')::text;
SQL
)
residue_query_exit=$?
IFS=',' read -r leftover_runs leftover_batches leftover_rows leftover_events leftover_clients leftover_invoices leftover_sources leftover_users leftover_debug_function execution_enabled diagnostic_visible <<< "$residue_state"
rollback_clean=0
if [ "$residue_query_exit" -eq 0 ] \
   && [ "${leftover_runs:-1}" = "0" ] \
   && [ "${leftover_batches:-1}" = "0" ] \
   && [ "${leftover_rows:-1}" = "0" ] \
   && [ "${leftover_events:-1}" = "0" ] \
   && [ "${leftover_clients:-1}" = "0" ] \
   && [ "${leftover_invoices:-1}" = "0" ] \
   && [ "${leftover_sources:-1}" = "0" ] \
   && [ "${leftover_users:-1}" = "0" ] \
   && [ "${leftover_debug_function:-1}" = "0" ] \
   && [ "${execution_enabled:-true}" = "false" ] \
   && [ "${diagnostic_visible:-true}" = "false" ]; then
  rollback_clean=1
fi
{
  echo "leftover_import_runs=${leftover_runs:-?}"
  echo "leftover_import_batches=${leftover_batches:-?}"
  echo "leftover_import_rows=${leftover_rows:-?}"
  echo "leftover_import_events=${leftover_events:-?}"
  echo "leftover_clients=${leftover_clients:-?}"
  echo "leftover_invoices=${leftover_invoices:-?}"
  echo "leftover_source_identities=${leftover_sources:-?}"
  echo "leftover_test_users=${leftover_users:-?}"
  echo "leftover_debug_functions=${leftover_debug_function:-?}"
  echo "execution_enabled_after_test=${execution_enabled:-?}"
  echo "authenticated_internal_diagnostic_select=${diagnostic_visible:-?}"
  echo "rollback_clean=$rollback_clean"
} > "$ARTIFACT_DIR/11_rollback_residue.log"
cat "$ARTIFACT_DIR/11_rollback_residue.log"
rollback_exit=1
[ "$rollback_clean" -eq 1 ] && rollback_exit=0
record_exit rollback_exit "$rollback_exit"

echo "overall_exit=$overall_status" >> "$ARTIFACT_DIR/EXIT_CODE_SUMMARY.txt"
echo "$overall_status" > "$ARTIFACT_DIR/OVERALL_EXIT_CODE"
exit "$overall_status"
