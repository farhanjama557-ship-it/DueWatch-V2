#!/usr/bin/env bash
# Disposable-only Phase 2 Slice 1 verifier. DB_URL must point to an empty local
# Supabase/Postgres test database; this script never discovers or uses a hosted
# project reference.
set -uo pipefail

if [ -z "${DB_URL:-}" ]; then
  echo "DB_URL is required" >&2
  exit 2
fi

artifact_dir="${ARTIFACT_DIR:-./payments-foundation-verify-artifact}"
mkdir -p "$artifact_dir"
overall=0

run() {
  local name="$1"; shift
  "$@" >"$artifact_dir/$name.log" 2>&1
  local code=$?
  echo "$name=$code" | tee -a "$artifact_dir/EXIT_CODE_SUMMARY.txt"
  [ "$code" -eq 0 ] || overall=1
}

run 01_schema psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/schema.sql

for migration in supabase/migrations/*.sql; do
  case "$migration" in
    *20260816120000_payments_foundation.sql) continue ;;
  esac
  name="02_$(basename "$migration" .sql)"
  run "$name" psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f "$migration"
  [ "$overall" -eq 0 ] || break
done

if [ "$overall" -eq 0 ]; then
  run 03_legacy_seed psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/payments_foundation_pre_migration_setup.sql
  run 04_migration psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260816120000_payments_foundation.sql
  run 05_integration psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/payments_foundation_test.sql
  run 06_migration_reapply psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260816120000_payments_foundation.sql
fi

echo "$overall" > "$artifact_dir/OVERALL_EXIT_CODE"
exit "$overall"
