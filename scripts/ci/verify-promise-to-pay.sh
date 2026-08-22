#!/usr/bin/env bash
#
# scripts/ci/verify-promise-to-pay.sh
#
# TARGETED PROMISE-TO-PAY VERIFICATION for Phase 2 Slice 1: Promise-to-Pay
# Foundation (core lifecycle: propose -> confirm, happy path only).
#
# This proves the Promise-to-Pay migration's own behavior (governance
# invariant, immutability, currency snapshot, tenant isolation, idempotency)
# against a fast, deterministic, narrow bootstrap. It does NOT prove
# compatibility with the full migration history actually running on current
# `main` -- following the precedent set by Payments Foundation's own
# adversarial review (MEDIUM 1), see
# scripts/ci/verify-promise-to-pay-current-schema.sh for the separate
# CURRENT MAIN SCHEMA COMPATIBILITY proof, which applies every real
# historical migration (minus the same documented, independently-verified
# non-replay-safe exception) and is what actually stands in for "compatible
# with current main."
#
# CONTRACT:
# - Runs against a fresh `supabase start` local stack.
# - Uses NO hosted Supabase credentials, no remote project ref, no production data.
# - Applies schema.sql + targeted checkpoint migrations only (NOT full historical replay --
#   see the CURRENT MAIN SCHEMA COMPATIBILITY script above for that proof).
# - Applies the minimal invoices.currency / invoices_user_id_id_uidx additions
#   Promise-to-Pay Foundation depends on (no legacy fixture seeding needed --
#   unlike Payments, this migration performs no backfill).
# - Applies 20260822130000_promise_to_pay_foundation.sql.
# - Runs integration tests proving the governance invariant, immutability,
#   currency snapshot, and tenant isolation.
# - Re-applies migration to prove idempotency.
# - The invoking GitHub workflow tears down the disposable stack on completion.
#
# This script is invoked by:
# .github/workflows/phase2-slice1-promise-to-pay-verify.yml
#

set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./promise-to-pay-verify-artifact}"
mkdir -p "$ARTIFACT_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$ARTIFACT_DIR/verifier.log"
}

fail() {
  log "FATAL: $*"
  exit 1
}

log "=== TARGETED PROMISE-TO-PAY VERIFICATION: starting ==="

if [ -z "${DB_URL:-}" ]; then
  log "Resolving DB_URL from supabase status..."
  supabase status -o env > /tmp/promise_to_pay_supabase_status.env
  DB_URL=$(grep '^DB_URL=' /tmp/promise_to_pay_supabase_status.env | cut -d '=' -f2- | tr -d '"')
  if [ -z "$DB_URL" ]; then
    fail "Failed to resolve DB_URL from supabase status"
  fi
  rm -f /tmp/promise_to_pay_supabase_status.env
  export DB_URL
fi

# Validate DB_URL is a local disposable instance on port 54322.
if [[ ! "$DB_URL" =~ ^postgresql://[^@]+@(127\.0\.0\.1|localhost|\[::1\]):54322/ ]]; then
  fail "DB_URL does not point to an approved local disposable Supabase instance (port 54322). Aborting to prevent accidental remote execution."
fi

log "Verified disposable local database target."

log "Step 1: Applying schema.sql..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/schema.sql > "$ARTIFACT_DIR/schema_apply.log" 2>&1; then
  cat "$ARTIFACT_DIR/schema_apply.log"
  fail "schema.sql application failed"
fi
log "schema.sql applied successfully."

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
    cat "$ARTIFACT_DIR/mig_${mig%.sql}.log"
    fail "Checkpoint migration $mig failed"
  fi
  log "  $mig applied successfully."
done
log "All checkpoint migrations applied."

log "Step 3: Applying pre-Promise-to-Pay schema additions..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/promise_to_pay_pre_migration_schema.sql > "$ARTIFACT_DIR/pre_promise_to_pay_schema.log" 2>&1; then
  cat "$ARTIFACT_DIR/pre_promise_to_pay_schema.log"
  fail "Pre-Promise-to-Pay schema application failed"
fi
log "Pre-Promise-to-Pay schema additions applied."

log "Step 4: Applying Promise-to-Pay Foundation migration (20260822130000)..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260822130000_promise_to_pay_foundation.sql > "$ARTIFACT_DIR/promise_to_pay_apply.log" 2>&1; then
  cat "$ARTIFACT_DIR/promise_to_pay_apply.log"
  fail "Promise-to-Pay Foundation migration application failed"
fi
log "Promise-to-Pay Foundation migration applied successfully."

log "Step 5: Running Promise-to-Pay integration tests..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/promise_to_pay_test.sql > "$ARTIFACT_DIR/integration_tests.log" 2>&1; then
  cat "$ARTIFACT_DIR/integration_tests.log"
  fail "Promise-to-Pay integration tests failed"
fi
log "Integration tests passed."

log "Step 6: Re-applying Promise-to-Pay Foundation migration (idempotency check)..."
if ! psql "$DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260822130000_promise_to_pay_foundation.sql > "$ARTIFACT_DIR/promise_to_pay_reapply.log" 2>&1; then
  cat "$ARTIFACT_DIR/promise_to_pay_reapply.log"
  fail "Promise-to-Pay Foundation migration is not idempotent"
fi
log "Idempotency check passed."

log "=== TARGETED PROMISE-TO-PAY VERIFICATION: PASSED ==="
exit 0
