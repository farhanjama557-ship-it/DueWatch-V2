#!/usr/bin/env bash
#
# supabase/convergence/checks/run_ledger_rehearsal.sh
#
# NO-LEDGER REHEARSAL for the production convergence runbook.
#
# Production has NO supabase_migrations.schema_migrations table (verified
# live 2026-08-22). Before the runbook executes `supabase migration
# repair` against production, this rehearsal proves — on a disposable
# local database, with the exact pinned CLI version recorded — what each
# ledger command does when that metadata table does not exist:
#
#   1. build a canonical database WITHOUT any migration ledger
#      (post-convergence production shape);
#   2. assert the metadata table is absent;
#   3. observe `supabase migration list`;
#   4. observe `supabase migration repair 20260822000000 --status applied`
#      (timestamp-only version form);
#   5. if repair does NOT initialize the metadata safely, derive and test
#      the minimal safe initialization (creating the CLI-expected
#      supabase_migrations.schema_migrations table) and repeat repair;
#   6. require `supabase migration list` local/remote agreement;
#   7. require `supabase db push --dry-run` reports ZERO pending.
#
# The observed transcript is written to the artifact directory and is the
# evidence the production runbook cites. NO production experimentation.

set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./canonical-proofs-artifact}"
mkdir -p "$ARTIFACT_DIR"

REHEARSAL_LOG="$ARTIFACT_DIR/ledger_rehearsal.log"
log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$REHEARSAL_LOG"
}
fail() {
  log "FATAL: $*"
  exit 1
}

# ---------------------------------------------------------------------------
# Pinned CLI version — the production window MUST use the same version.
# ---------------------------------------------------------------------------
PINNED_CLI_VERSION="$(supabase --version)"
log "PINNED SUPABASE CLI VERSION: $PINNED_CLI_VERSION"

if [ -z "${DB_URL:-}" ]; then
  supabase status -o env > /tmp/ledger_rehearsal_status.env
  BASE_DB_URL=$(grep '^DB_URL=' /tmp/ledger_rehearsal_status.env | cut -d '=' -f2- | tr -d '"')
  rm -f /tmp/ledger_rehearsal_status.env
else
  BASE_DB_URL="$DB_URL"
fi
[ -n "$BASE_DB_URL" ] || fail "failed to resolve DB_URL"
if [[ ! "$BASE_DB_URL" =~ ^postgresql://[^@]+@(127\.0\.0\.1|localhost|\[::1\]):54322/ ]]; then
  fail "DB_URL is not an approved disposable local instance (port 54322). Aborting."
fi
log "Verified disposable local database target."

ADMIN_DB_URL=$(echo "$BASE_DB_URL" | sed -E 's#/[^/]+$#/postgres#')
DB="canonical_ledger_rehearsal"
URL=$(echo "$BASE_DB_URL" | sed -E "s#/[^/]+\$#/$DB#")

cleanup() {
  psql "$ADMIN_DB_URL" -X -q -c "drop database if exists $DB;" >> "$REHEARSAL_LOG" 2>&1 || true
}
trap cleanup EXIT

psql "$ADMIN_DB_URL" -X -v ON_ERROR_STOP=1 \
  -c "drop database if exists $DB;" -c "create database $DB;" >> "$REHEARSAL_LOG" 2>&1 \
  || fail "could not create rehearsal database"

CONTAINER=$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1)
[ -n "$CONTAINER" ] || fail "no running supabase_db_* container"
psql "$URL" -X -v ON_ERROR_STOP=1 -c "create schema if not exists extensions;" -c "create extension if not exists pgcrypto schema extensions;" >> "$REHEARSAL_LOG" 2>&1 || fail "pgcrypto"
psql "$URL" -X -v ON_ERROR_STOP=1 \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT MAINTAIN, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated, service_role;" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO anon, authenticated, service_role;" \
  >> "$REHEARSAL_LOG" 2>&1 || fail "default privileges"
docker exec "$CONTAINER" pg_dump -U postgres --schema=auth --no-owner --no-acl --section=pre-data postgres \
  | psql "$URL" -X -v ON_ERROR_STOP=1 >> "$REHEARSAL_LOG" 2>&1 \
  || fail "auth bootstrap failed"
psql "$URL" -X -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE auth.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);" >> "$REHEARSAL_LOG" 2>&1 \
  || fail "auth.users pk failed"

# Canonical schema, applied via psql — therefore NO ledger table exists.
psql "$URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260822000000_canonical_baseline.sql >> "$REHEARSAL_LOG" 2>&1 \
  || fail "baseline failed on rehearsal database"

# ---------------------------------------------------------------------------
# Step 2 — assert no ledger metadata exists.
# ---------------------------------------------------------------------------
if [ "$(psql "$URL" -X -q -t -A -c "select to_regclass('supabase_migrations.schema_migrations') is not null;")" = "t" ]; then
  LEDGER_STATE="present:$(psql "$URL" -X -q -t -A -c "select coalesce(string_agg(version, ','), '') from supabase_migrations.schema_migrations;")"
else
  LEDGER_STATE="absent"
fi
log "ledger metadata before repair: $LEDGER_STATE"
[ "$LEDGER_STATE" = "absent" ] || fail "expected no ledger metadata on a psql-applied database"

# ---------------------------------------------------------------------------
# Step 3 — migration list against a ledger-less database (observe).
# ---------------------------------------------------------------------------
log "STEP: supabase migration list --db-url (no ledger present) — observing behavior"
if supabase migration list --db-url "$URL" > "$ARTIFACT_DIR/ledger_list_before.txt" 2>&1; then
  log "  migration list exited 0 (output recorded)"
else
  log "  migration list exited nonzero (output recorded) — proceeding to repair"
fi
sed 's/^/    | /' "$ARTIFACT_DIR/ledger_list_before.txt" | tee -a "$REHEARSAL_LOG"

# ---------------------------------------------------------------------------
# Step 4 — repair with the timestamp-only version form.
# ---------------------------------------------------------------------------
log "STEP: supabase migration repair 20260822000000 --status applied --db-url ..."
if supabase migration repair 20260822000000 --status applied --db-url "$URL" \
     > "$ARTIFACT_DIR/ledger_repair.txt" 2>&1; then
  log "  repair exited 0"
else
  log "  repair exited nonzero:"
  sed 's/^/    | /' "$ARTIFACT_DIR/ledger_repair.txt" | tee -a "$REHEARSAL_LOG"
  log "STEP: repair did not initialize metadata on its own — deriving minimal safe initialization"

  # Minimal safe initialization: create the CLI-expected metadata table.
  # (OBSERVED, not assumed: this branch only runs if repair proved unable
  # to bootstrap it, and its result is re-verified by list/push below.)
  psql "$URL" -X -v ON_ERROR_STOP=1 <<'SQL' >> "$REHEARSAL_LOG" 2>&1 || fail "manual metadata initialization failed"
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text
);
SQL
  log "  metadata table initialized manually"
  supabase migration repair 20260822000000 --status applied --db-url "$URL" \
    > "$ARTIFACT_DIR/ledger_repair_retry.txt" 2>&1 \
    || { sed 's/^/    | /' "$ARTIFACT_DIR/ledger_repair_retry.txt" | tee -a "$REHEARSAL_LOG"; fail "repair failed even after metadata initialization"; }
  log "  repair retry exited 0"
fi
sed 's/^/    | /' "$ARTIFACT_DIR/ledger_repair.txt" | tee -a "$REHEARSAL_LOG"

LEDGER_STATE="present:$(psql "$URL" -X -q -t -A -c "select coalesce(string_agg(version, ','), '') from supabase_migrations.schema_migrations;")"
log "ledger metadata after repair: $LEDGER_STATE"
[ "$LEDGER_STATE" = "present:20260822000000" ] || fail "repair did not record the baseline version (state: $LEDGER_STATE)"

# ---------------------------------------------------------------------------
# Step 6 — local/remote agreement.
# ---------------------------------------------------------------------------
log "STEP: supabase migration list --db-url (after repair) — requiring agreement"
supabase migration list --db-url "$URL" > "$ARTIFACT_DIR/ledger_list_after.txt" 2>&1 \
  || { sed 's/^/    | /' "$ARTIFACT_DIR/ledger_list_after.txt" | tee -a "$REHEARSAL_LOG"; fail "migration list failed after repair"; }
sed 's/^/    | /' "$ARTIFACT_DIR/ledger_list_after.txt" | tee -a "$REHEARSAL_LOG"
if grep -qE '(Required|Pending)' "$ARTIFACT_DIR/ledger_list_after.txt"; then
  fail "migration list shows non-applied entries after repair — no agreement"
fi
log "  local/remote agreement confirmed"

# ---------------------------------------------------------------------------
# Step 7 — db push dry-run must report nothing pending.
# ---------------------------------------------------------------------------
log "STEP: supabase db push --dry-run --db-url ... — requiring zero pending"
supabase db push --dry-run --db-url "$URL" > "$ARTIFACT_DIR/ledger_push_dryrun.txt" 2>&1 \
  || { sed 's/^/    | /' "$ARTIFACT_DIR/ledger_push_dryrun.txt" | tee -a "$REHEARSAL_LOG"; fail "db push --dry-run failed"; }
sed 's/^/    | /' "$ARTIFACT_DIR/ledger_push_dryrun.txt" | tee -a "$REHEARSAL_LOG"
if grep -qiE 'apply|pending|following' "$ARTIFACT_DIR/ledger_push_dryrun.txt"; then
  fail "db push --dry-run reports pending migrations — ledger repair insufficient"
fi
log "  zero pending migrations confirmed"

log "=== LEDGER REHEARSAL PASSED (pinned CLI: $PINNED_CLI_VERSION) ==="
exit 0
