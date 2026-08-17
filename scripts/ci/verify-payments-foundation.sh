#!/usr/bin/env bash
#
# scripts/ci/verify-payments-foundation.sh
#
# Disposable Supabase verification harness for Phase 2 Slice 1: Payments Foundation.
#
# CONTRACT:
# - Runs against a fresh `supabase start` local stack.
# - Uses NO hosted Supabase credentials, no remote project ref, no production data.
# - Applies schema.sql + targeted checkpoint migrations only (NOT full historical replay).
# - Seeds legacy fixtures that represent pre-existing payment state.
# - Applies 20260816120000_payments_foundation.sql.
# - Runs integration tests proving security invariants and legacy reconciliation.
# - Re-applies migration to prove idempotency.
# - The invoking GitHub workflow tears down the disposable stack on completion.
#
# This script is invoked by:
# .github/workflows/phase2-slice1-payments-foundation-verify.yml
#

set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./payments-foundation-verify-artifact}"
mkdir -p "$ARTIFACT_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$ARTIFACT_DIR/verifier.log"
}

fail() {
  log "FATAL: $*"
  exit 1
}

log "Starting Payments Foundation verification harness..."

# Resolve DB_URL from supabase status if not already set
if [ -z "${DB_URL:-}" ]; then
  log "Resolving DB_URL from supabase status..."
  supabase status -o env > /tmp/payments_foundation_supabase_status.env
  DB_URL=$(grep '^DB_URL=' /tmp/payments_foundation_supabase_status.env | cut -d '=' -f2- | tr -d '"')
  if [ -z "$DB_URL" ]; then
    fail "Failed to resolve DB_URL from supabase status"
  fi
  rm -f /tmp/payments_foundation_supabase_status.env
  export DB_URL
fi

# Validate DB_URL is a local disposable instance on port 54322.
# Accepts ONLY: 127.0.0.1:54322, localhost:54322, [::1]:54322.
# Rejects arbitrary private-network hosts and hosted databases.
if [[ ! "$DB_URL" =~ ^postgresql://[^@]+@(127\.0\.0\.1|localhost|\[::1\]):54322/ ]]; then
  fail "DB_URL does not point to an approved local disposable Supabase instance (port 54322). Aborting to prevent accidental remote execution."
fi

log "Verified disposable local database target."

# Step 1: Apply base schema.sql
log "Step 1: Applying schema.sql..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/schema.sql > "$ARTIFACT_DIR/schema_apply.log" 2>&1; then
  log "Schema apply failed. Log:"
  cat "$ARTIFACT_DIR/schema_apply.log"
  fail "schema.sql application failed"
fi
log "schema.sql applied successfully."

# Step 2: Apply targeted checkpoint migrations (NOT full historical replay)
log "Step 2: Applying targeted checkpoint migrations..."

CHECKPOINT_MIGRATIONS=(
  "20260726000000_canonical_clients.sql"
  "20260803021842_enforce_invoice_client_tenant_ownership.sql"
  "20260810000000_client_source_identities_rls.sql"
  "20260811000000_client_source_identities_tenant_fk.sql"
)

for mig in "${CHECKPOINT_MIGRATIONS[@]}"; do
  log "  Applying $mig..."
  if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f "supabase/migrations/$mig" > "$ARTIFACT_DIR/mig_${mig%.sql}.log" 2>&1; then
    log "Migration $mig failed. Log:"
    cat "$ARTIFACT_DIR/mig_${mig%.sql}.log"
    fail "Checkpoint migration $mig failed"
  fi
  log "  $mig applied successfully."
done

log "All checkpoint migrations applied."

# Step 3: Apply narrow pre-Payments schema additions
log "Step 3: Applying pre-Payments schema additions..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/payments_foundation_pre_migration_schema.sql > "$ARTIFACT_DIR/pre_payments_schema.log" 2>&1; then
  log "Pre-Payments schema apply failed. Log:"
  cat "$ARTIFACT_DIR/pre_payments_schema.log"
  fail "Pre-Payments schema application failed"
fi
log "Pre-Payments schema additions applied."

# Step 4: Seed legacy fixtures
log "Step 4: Seeding legacy fixtures..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/payments_foundation_pre_migration_setup.sql > "$ARTIFACT_DIR/legacy_seed.log" 2>&1; then
  log "Legacy seed failed. Log:"
  cat "$ARTIFACT_DIR/legacy_seed.log"
  fail "Legacy fixture seeding failed"
fi
log "Legacy fixtures seeded."

# Step 5: Apply Payments Foundation migration
log "Step 5: Applying Payments Foundation migration (20260816120000)..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260816120000_payments_foundation.sql > "$ARTIFACT_DIR/payments_foundation_apply.log" 2>&1; then
  log "Payments Foundation migration failed. Log:"
  cat "$ARTIFACT_DIR/payments_foundation_apply.log"
  fail "Payments Foundation migration application failed"
fi
log "Payments Foundation migration applied successfully."

# Step 6: Run integration tests
log "Step 6: Running Payments Foundation integration tests..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/payments_foundation_test.sql > "$ARTIFACT_DIR/integration_tests.log" 2>&1; then
  log "Integration tests failed. Log:"
  cat "$ARTIFACT_DIR/integration_tests.log"
  fail "Payments Foundation integration tests failed"
fi
log "Integration tests passed."

# Step 7: Re-apply migration for idempotency
log "Step 7: Re-applying Payments Foundation migration (idempotency check)..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260816120000_payments_foundation.sql > "$ARTIFACT_DIR/payments_foundation_reapply.log" 2>&1; then
  log "Idempotency re-apply failed. Log:"
  cat "$ARTIFACT_DIR/payments_foundation_reapply.log"
  fail "Payments Foundation migration is not idempotent"
fi
log "Idempotency check passed."

log "Payments Foundation verification harness completed successfully."
exit 0
