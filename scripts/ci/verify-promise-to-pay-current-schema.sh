#!/usr/bin/env bash
#
# scripts/ci/verify-promise-to-pay-current-schema.sh
#
# CURRENT MAIN SCHEMA COMPATIBILITY verification for Phase 2 Slice 1
# (Promise-to-Pay Foundation).
#
# WHY THIS SCRIPT EXISTS (mirrors Payments Foundation's own adversarial
# review, MEDIUM 1): scripts/ci/verify-promise-to-pay.sh proves the
# Promise-to-Pay migration works against a narrow, hand-picked checkpoint
# bootstrap. That is a real and useful proof (fast, deterministic), but it
# is NOT proof that Promise-to-Pay is compatible with the schema actually
# running on current `main` -- ten real historical migrations (now
# including Payments Foundation itself) never get applied in that path.
# CI must not let a TARGETED PROMISE-TO-PAY VERIFICATION pass silently stand
# in for that broader claim. This script is the broader claim, proved
# honestly.
#
# CODIFIED FACT -- one migration is not chronologically replay-safe (same
# fact already documented and independently verified by
# scripts/ci/verify-payments-foundation-current-schema.sh; repeated here
# rather than re-verified, since it's a property of the migration history
# itself, not of anything Promise-to-Pay adds):
# 20260811000000_client_source_identities_tenant_fk.sql ends with a
# postflight check (duewatch_ops.unknown_client_foreign_keys()) that scans
# every real foreign key referencing clients/invoices against a fixed
# allowlist and raises if it finds one the allowlist doesn't know about.
# Replayed straight from a fresh database through
# 20260803150000_import_persistence_core.sql (which creates import_rows
# with FKs to clients/invoices), that scan finds import_rows' FKs -- which
# are NOT in the 20260811000000 allowlist -- and the migration raises.
# Per repo policy, historical migrations are not edited to make old history
# replay after the fact, so this script does not attempt to "fix"
# 20260811000000 -- it documents the failure and skips exactly that one
# migration.
#
# WHY SKIPPING IT IS SAFE FOR THIS PROOF:
# Promise-to-Pay Foundation (20260822130000) never references
# client_source_identities or import_rows. It also composite-FKs to
# invoices(user_id, id), an index created by
# 20260803150000_import_persistence_core.sql -- a migration chronologically
# BEFORE the skipped one, so it is unaffected by the skip. Every migration
# chronologically AFTER 20260811000000 (including Payments Foundation
# itself) was already independently verified to apply cleanly with
# 20260811000000 skipped by the Payments Foundation slice's own current-
# schema verifier; Promise-to-Pay adds nothing that touches that boundary.
#
# This script therefore applies: schema.sql, then every migration in
# chronological order EXCEPT 20260811000000 (explicitly logged, never
# silent), then Promise-to-Pay Foundation itself, then re-applies it to
# prove idempotency against this fuller schema too.
#
# CONTRACT:
# - Runs against a fresh `supabase start` local stack (same disposable
#   instance as the targeted verifier; uses its OWN database within it so
#   the two verification paths never share or corrupt each other's state).
# - Uses NO hosted Supabase credentials, no remote project ref, no
#   production data anywhere.
# - Does not alter any historical migration file.
# - Does not silently skip anything -- every skip is logged with its exact
#   reason.
#
# This script is invoked by:
# .github/workflows/phase2-slice1-promise-to-pay-verify.yml

set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./promise-to-pay-verify-artifact}"
mkdir -p "$ARTIFACT_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$ARTIFACT_DIR/current_schema_verifier.log"
}

fail() {
  log "FATAL: $*"
  exit 1
}

log "=== CURRENT MAIN SCHEMA COMPATIBILITY: starting ==="

if [ -z "${DB_URL:-}" ]; then
  log "Resolving base DB_URL from supabase status..."
  supabase status -o env > /tmp/promise_to_pay_current_schema_status.env
  BASE_DB_URL=$(grep '^DB_URL=' /tmp/promise_to_pay_current_schema_status.env | cut -d '=' -f2- | tr -d '"')
  rm -f /tmp/promise_to_pay_current_schema_status.env
else
  BASE_DB_URL="$DB_URL"
fi
if [ -z "$BASE_DB_URL" ]; then
  fail "Failed to resolve a base DB_URL"
fi

# Same disposable-local guard as the targeted verifier -- localhost/127.0.0.1/[::1]:54322 only.
if [[ ! "$BASE_DB_URL" =~ ^postgresql://[^@]+@(127\.0\.0\.1|localhost|\[::1\]):54322/ ]]; then
  fail "DB_URL does not point to an approved local disposable Supabase instance (port 54322). Aborting to prevent accidental remote execution."
fi
log "Verified disposable local database target."

# Independent database within the same disposable instance -- never the
# same database the targeted verifier applies its own narrower schema to.
CURRENT_SCHEMA_DB="promise_to_pay_current_schema_compat"
ADMIN_DB_URL=$(echo "$BASE_DB_URL" | sed -E 's#/[^/]+$#/postgres#')
CURRENT_SCHEMA_DB_URL=$(echo "$BASE_DB_URL" | sed -E "s#/[^/]+\$#/${CURRENT_SCHEMA_DB}#")

log "Creating independent database '$CURRENT_SCHEMA_DB' for this compatibility proof..."
psql "$ADMIN_DB_URL" -X -v ON_ERROR_STOP=1 -c "drop database if exists ${CURRENT_SCHEMA_DB};" > "$ARTIFACT_DIR/current_schema_dbsetup.log" 2>&1
psql "$ADMIN_DB_URL" -X -v ON_ERROR_STOP=1 -c "create database ${CURRENT_SCHEMA_DB};" >> "$ARTIFACT_DIR/current_schema_dbsetup.log" 2>&1

# Bootstrap Supabase auth prerequisites into the independent database.
# `supabase start` provisions the auth schema (auth.users, auth.uid(),
# etc.) only into the default postgres database. A freshly CREATE'd
# database on the same cluster has cluster-level roles but no auth schema.
# We dump the real auth schema from the main postgres database and restore
# it here -- this is the actual Supabase-provisioned schema, not a stub.
log "Bootstrapping Supabase auth schema into '$CURRENT_SCHEMA_DB'..."
psql "$CURRENT_SCHEMA_DB_URL" -X -v ON_ERROR_STOP=1 \
  -c "create extension if not exists pgcrypto;" \
  >> "$ARTIFACT_DIR/current_schema_dbsetup.log" 2>&1

# pg_dump must come from inside the Supabase DB container -- the runner's
# system pg_dump is typically one major version behind the Supabase Postgres
# image, and pg_dump refuses cross-major dumps. docker exec gives us the
# exact matching version that shipped with the image.
SUPABASE_DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1)
if [ -z "$SUPABASE_DB_CONTAINER" ]; then
  cat "$ARTIFACT_DIR/current_schema_dbsetup.log"
  fail "Cannot find a running supabase_db_* container -- is the Supabase stack up?"
fi
log "  Using container '$SUPABASE_DB_CONTAINER' for version-matched pg_dump..."

if ! docker exec "$SUPABASE_DB_CONTAINER" \
    pg_dump -U postgres --schema=auth --no-owner --no-acl --section=pre-data postgres \
    | psql "$CURRENT_SCHEMA_DB_URL" -X -v ON_ERROR_STOP=1 \
    >> "$ARTIFACT_DIR/current_schema_dbsetup.log" 2>&1; then
  cat "$ARTIFACT_DIR/current_schema_dbsetup.log"
  fail "Failed to bootstrap auth schema into '$CURRENT_SCHEMA_DB'"
fi
log "Auth schema bootstrapped (pre-data section: tables, functions, types -- no triggers)."

# --section=pre-data omits post-data (indexes, constraints, triggers).
# schema.sql and every migration reference auth.users(id) via FK, which
# requires a unique constraint on that column. Add the PK explicitly rather
# than pulling in post-data (which includes the on_auth_user_created trigger
# that calls public.handle_new_user(), a function not yet defined here).
log "  Adding primary key to auth.users.id (stripped by --section=pre-data)..."
if ! psql "$CURRENT_SCHEMA_DB_URL" -X -v ON_ERROR_STOP=1 \
    -c "ALTER TABLE auth.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);" \
    >> "$ARTIFACT_DIR/current_schema_dbsetup.log" 2>&1; then
  cat "$ARTIFACT_DIR/current_schema_dbsetup.log"
  fail "Failed to add primary key to auth.users in '$CURRENT_SCHEMA_DB'"
fi
log "  Primary key added."

log "Step 1: Applying schema.sql..."
if ! psql "$CURRENT_SCHEMA_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/schema.sql > "$ARTIFACT_DIR/current_schema_01_schema.log" 2>&1; then
  cat "$ARTIFACT_DIR/current_schema_01_schema.log"
  fail "schema.sql application failed against the current-schema database"
fi
log "schema.sql applied."

log "Step 2: Applying every migration in chronological order, EXCEPT the documented non-replay-safe one..."
NON_REPLAY_SAFE="20260811000000_client_source_identities_tenant_fk.sql"
for mig_path in supabase/migrations/*.sql; do
  mig=$(basename "$mig_path")
  if [ "$mig" = "$NON_REPLAY_SAFE" ]; then
    log "  SKIPPING $mig -- codified non-replay-safe (see this script's header comment: import_rows FK drift vs. its unknown-FK allowlist). Not a silent skip; logged explicitly."
    continue
  fi
  log "  Applying $mig..."
  if ! psql "$CURRENT_SCHEMA_DB_URL" -X -v ON_ERROR_STOP=1 -f "$mig_path" > "$ARTIFACT_DIR/current_schema_mig_${mig%.sql}.log" 2>&1; then
    cat "$ARTIFACT_DIR/current_schema_mig_${mig%.sql}.log"
    fail "Migration $mig failed against the current-schema database"
  fi
done
log "All non-skipped historical migrations applied."

log "Step 3: Applying Promise-to-Pay Foundation migration (20260822130000) against this fuller schema..."
if ! psql "$CURRENT_SCHEMA_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260822130000_promise_to_pay_foundation.sql > "$ARTIFACT_DIR/current_schema_promise_to_pay_apply.log" 2>&1; then
  cat "$ARTIFACT_DIR/current_schema_promise_to_pay_apply.log"
  fail "Promise-to-Pay Foundation migration failed against the current-main-shaped schema"
fi
log "Promise-to-Pay Foundation applied cleanly against current-main schema."

log "Step 4: Re-applying Promise-to-Pay Foundation for idempotency in this fuller schema..."
if ! psql "$CURRENT_SCHEMA_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260822130000_promise_to_pay_foundation.sql > "$ARTIFACT_DIR/current_schema_promise_to_pay_reapply.log" 2>&1; then
  cat "$ARTIFACT_DIR/current_schema_promise_to_pay_reapply.log"
  fail "Promise-to-Pay Foundation migration is not idempotent against current-main schema"
fi
log "Idempotency confirmed against current-main schema."

log "=== CURRENT MAIN SCHEMA COMPATIBILITY: PASSED ==="
exit 0
