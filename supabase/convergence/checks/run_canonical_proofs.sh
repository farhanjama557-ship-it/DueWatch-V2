#!/usr/bin/env bash
#
# supabase/convergence/checks/run_canonical_proofs.sh
#
# The canonical-baseline proof suite. Runs entirely against a disposable
# local `supabase start` stack. No hosted credentials, no production data.
#
# PROOFS
#   1  fresh `supabase db reset` succeeds with the single-file active chain
#   2  a second independent fresh build reproduces the same canonical state
#   3  legacy-like fixture + convergence script == fresh canonical state
#      (normalized structural equivalence)
#   4  canonical baseline == archived historical chain end-state
#      (the baseline is a faithful squash, verified object-by-object)
#   5  unknown legacy state fails closed AND rolls back completely
#   6  a second convergence invocation FAILS CLOSED without mutation
#      (one-time-tool contract; no weak "already canonical" shortcut)
#   9  a failure in the FINAL canonical assertion stage (last step before
#      commit) rolls the entire convergence back — legacy state intact
#   7  existing SQL test suites pass against the canonical baseline
#   8  the active migration directory contains exactly the baseline file
#      (no legacy migration is executable by standard tooling)
# (Proof 9, executed between 6 and 7, proves final-assertion rollback.)
#
# Usage (from repo root, with the local stack running):
#   ARTIFACT_DIR=./canonical-proofs-artifact \
#     bash supabase/convergence/checks/run_canonical_proofs.sh
#
# Invoked by .github/workflows/canonical-baseline-verify.yml and by the
# production runbook's rehearsal step.

set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-./canonical-proofs-artifact}"
mkdir -p "$ARTIFACT_DIR"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$ARTIFACT_DIR/proofs.log"
}

fail() {
  log "FATAL: $*"
  exit 1
}

snapshot_db() {
  local db_url="$1" out="$2"
  psql "$db_url" -X -q -t -A -F $'\t' -v ON_ERROR_STOP=1 \
    -f supabase/convergence/checks/canonical_snapshot_queries.sql \
    > "$out.raw" 2> "$out.err" || { cat "$out.err"; fail "snapshot query failed for $out"; }
  LC_ALL=C sort "$out.raw" > "$out"
}

# ---------------------------------------------------------------------------
# Resolve the disposable local stack's connection string (with guard).
# ---------------------------------------------------------------------------
if [ -z "${DB_URL:-}" ]; then
  supabase status -o env > /tmp/canonical_proofs_status.env
  BASE_DB_URL=$(grep '^DB_URL=' /tmp/canonical_proofs_status.env | cut -d '=' -f2- | tr -d '"')
  rm -f /tmp/canonical_proofs_status.env
else
  BASE_DB_URL="$DB_URL"
fi
[ -n "$BASE_DB_URL" ] || fail "Failed to resolve DB_URL"
if [[ ! "$BASE_DB_URL" =~ ^postgresql://[^@]+@(127\.0\.0\.1|localhost|\[::1\]):54322/ ]]; then
  fail "DB_URL does not point to an approved local disposable Supabase instance (port 54322). Aborting."
fi
log "Verified disposable local database target."

ADMIN_DB_URL=$(echo "$BASE_DB_URL" | sed -E 's#/[^/]+$#/postgres#')

# ---------------------------------------------------------------------------
# Helper: create an independent database with the Supabase auth schema
# bootstrapped (same pattern as scripts/ci/verify-payments-foundation-
# current-schema.sh — the auth schema is dump-restored from the stack's
# postgres database so FKs to auth.users work in independent DBs).
# ---------------------------------------------------------------------------
BOOTSTRAPPED_DBS=()
make_db() {
  local db="$1"
  psql "$ADMIN_DB_URL" -X -v ON_ERROR_STOP=1 \
    -c "drop database if exists $db;" \
    -c "create database $db;" > "$ARTIFACT_DIR/dbsetup_$db.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/dbsetup_$db.log"; fail "could not create database $db"; }
  local url; url=$(echo "$BASE_DB_URL" | sed -E "s#/[^/]+\$#/$db#")
  psql "$url" -X -v ON_ERROR_STOP=1 -c "create schema if not exists extensions;" -c "create extension if not exists pgcrypto schema extensions;" \
    >> "$ARTIFACT_DIR/dbsetup_$db.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/dbsetup_$db.log"; fail "pgcrypto missing in $db"; }
  # Replicate the platform PG17 default privileges for role postgres in schema
  # public (the same restricted set the stack's globals install: tables ->
  # DELETE/TRUNCATE/REFERENCES/TRIGGER, sequences -> UPDATE). Without this,
  # independent databases diverge from both db-reset and hosted production
  # grant behavior and the equivalence proof fails spuriously.
  psql "$url" -X -v ON_ERROR_STOP=1 \
    -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT MAINTAIN, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon, authenticated, service_role;" \
    -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT UPDATE ON SEQUENCES TO anon, authenticated, service_role;" \
    >> "$ARTIFACT_DIR/dbsetup_$db.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/dbsetup_$db.log"; fail "default privileges failed for $db"; }
  local container; container=$(docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1)
  [ -n "$container" ] || fail "no running supabase_db_* container"
  docker exec "$container" \
    pg_dump -U postgres --schema=auth --no-owner --no-acl --section=pre-data postgres \
    | psql "$url" -X -v ON_ERROR_STOP=1 >> "$ARTIFACT_DIR/dbsetup_$db.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/dbsetup_$db.log"; fail "auth bootstrap failed for $db"; }
  psql "$url" -X -v ON_ERROR_STOP=1 \
    -c "ALTER TABLE auth.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);" \
    >> "$ARTIFACT_DIR/dbsetup_$db.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/dbsetup_$db.log"; fail "auth.users pk failed for $db"; }
  BOOTSTRAPPED_DBS+=("$db")
  echo "$url"
}

cleanup_dbs() {
  for db in "${BOOTSTRAPPED_DBS[@]:-}"; do
    psql "$ADMIN_DB_URL" -X -q -c "drop database if exists $db;" >> "$ARTIFACT_DIR/dbsetup_cleanup.log" 2>&1 || true
  done
}
trap cleanup_dbs EXIT

BASELINE="supabase/migrations/20260822000000_canonical_baseline.sql"
CONVERGENCE="supabase/convergence/20260822_legacy_live_to_canonical.sql"
FIXTURE="supabase/convergence/fixtures/legacy_live_fixture.sql"
SNAPQ="supabase/convergence/checks/canonical_snapshot_queries.sql"

# ---------------------------------------------------------------------------
# PROOF 8 — active chain contains exactly the baseline (run first: it is
# the structural precondition for every other proof).
# ---------------------------------------------------------------------------
log "PROOF 8: active chain file inventory"
ACTIVE_COUNT=$(ls -1 supabase/migrations/*.sql | wc -l | tr -d ' ')
[ "$ACTIVE_COUNT" = "1" ] || fail "active supabase/migrations must contain exactly 1 file, found $ACTIVE_COUNT"
[ -f "$BASELINE" ] || fail "canonical baseline missing from active migrations"
log "PROOF 8 PASSED: active chain is exactly the canonical baseline."

# ---------------------------------------------------------------------------
# PROOFS 1+2 — fresh db reset twice; snapshots must match.
# ---------------------------------------------------------------------------
log "PROOF 1: fresh supabase db reset (active chain only)"
supabase db reset > "$ARTIFACT_DIR/db_reset_1.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/db_reset_1.log"; fail "db reset failed with the single-file active chain"; }
log "PROOF 1 PASSED: db reset succeeded."
snapshot_db "$BASE_DB_URL" "$ARTIFACT_DIR/snapshot_fresh_1.txt"

log "PROOF 2: second independent fresh build"
supabase db reset > "$ARTIFACT_DIR/db_reset_2.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/db_reset_2.log"; fail "second db reset failed"; }
snapshot_db "$BASE_DB_URL" "$ARTIFACT_DIR/snapshot_fresh_2.txt"
if diff -u "$ARTIFACT_DIR/snapshot_fresh_1.txt" "$ARTIFACT_DIR/snapshot_fresh_2.txt" > "$ARTIFACT_DIR/diff_fresh_1_2.txt"; then
  log "PROOF 2 PASSED: fresh baseline reproducibility confirmed."
else
  cat "$ARTIFACT_DIR/diff_fresh_1_2.txt"
  fail "second fresh build differs from the first"
fi
FRESH_SNAP="$ARTIFACT_DIR/snapshot_fresh_1.txt"

# ---------------------------------------------------------------------------
# PROOF 3 — legacy-like fixture + convergence == fresh canonical state.
# ---------------------------------------------------------------------------
log "PROOF 3: legacy-live fixture + convergence script"
LEGACY_URL=$(make_db canonical_legacyconv)
psql "$LEGACY_URL" -X -v ON_ERROR_STOP=1 -f "$FIXTURE" \
  > "$ARTIFACT_DIR/fixture_apply.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/fixture_apply.log"; fail "legacy fixture failed to apply"; }
psql "$LEGACY_URL" -X -v ON_ERROR_STOP=1 -f "$CONVERGENCE" \
  > "$ARTIFACT_DIR/convergence_apply.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/convergence_apply.log"; fail "convergence script failed against the legacy fixture"; }
snapshot_db "$LEGACY_URL" "$ARTIFACT_DIR/snapshot_converged.txt"
if diff -u "$FRESH_SNAP" "$ARTIFACT_DIR/snapshot_converged.txt" > "$ARTIFACT_DIR/diff_fresh_converged.txt"; then
  log "PROOF 3 PASSED: FRESH + BASELINE == LEGACY-LIKE + CONVERGENCE (structural equivalence)."
else
  cat "$ARTIFACT_DIR/diff_fresh_converged.txt"
  fail "converged state differs from fresh canonical state"
fi

# ---------------------------------------------------------------------------
# PROOF 4 — baseline == archived chain end-state (+ autopilot section).
# ---------------------------------------------------------------------------
log "PROOF 4: canonical intended historical end-state reference build"
# NOTE: the reference is the CANONICAL INTENDED HISTORICAL END-STATE — the
# archived chain with the documented non-replay-safe 20260811000000
# excluded, whose intended effects are already provided by the corrected
# 20260726000000 (composite tenant FK on client_source_identities created
# from the start) and by 20260803021842's later function refresh. This is
# NOT a claim that the broken chronological chain ever ran to completion.
REF_URL=$(make_db canonical_oldchain)
psql "$REF_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations_legacy/schema.sql \
  > "$ARTIFACT_DIR/oldchain_apply.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/oldchain_apply.log"; fail "archived schema.sql failed on reference DB"; }
sed -n '/\[SOURCE: sections\/20260822000001_autopilot_canonical.sql\]/,/^-- \[SOURCE: 20260726/p' "$BASELINE" \
  | sed '$d' | sed 's/^-- \[SECTION: autopilot-canonical \(begin\|end\)\]$//' > "$ARTIFACT_DIR/autopilot_section_extracted.sql"
psql "$REF_URL" -X -v ON_ERROR_STOP=1 -f "$ARTIFACT_DIR/autopilot_section_extracted.sql" \
  >> "$ARTIFACT_DIR/oldchain_apply.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/oldchain_apply.log"; fail "autopilot section failed on reference DB"; }
for mig in \
  20260726000000_canonical_clients.sql \
  20260803021842_enforce_invoice_client_tenant_ownership.sql \
  20260803150000_import_persistence_core.sql \
  20260810000000_client_source_identities_rls.sql \
  20260811083005_phase15b_import_table_privilege_baseline.sql \
  20260811092928_process_import_batch_hosted_compatibility.sql \
  20260813161329_autopilot_execution_claims.sql \
  20260814090000_awaiting_signature_pending_only_uniqueness.sql \
  20260814100000_autopilot_execution_claims_canonical_receipt.sql \
  20260816120000_payments_foundation.sql
do
  log "  reference chain: applying $mig"
  psql "$REF_URL" -X -v ON_ERROR_STOP=1 -f "supabase/migrations_legacy/$mig" \
    >> "$ARTIFACT_DIR/oldchain_apply.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/oldchain_apply.log"; fail "reference chain failed at $mig"; }
done
snapshot_db "$REF_URL" "$ARTIFACT_DIR/snapshot_oldchain.txt"
if diff -u "$FRESH_SNAP" "$ARTIFACT_DIR/snapshot_oldchain.txt" > "$ARTIFACT_DIR/diff_fresh_oldchain.txt"; then
  log "PROOF 4 PASSED: baseline is structurally equivalent to the canonical intended historical end-state."
else
  cat "$ARTIFACT_DIR/diff_fresh_oldchain.txt"
  fail "baseline differs from archived chain end-state"
fi

# ---------------------------------------------------------------------------
# PROOF 5 — unknown state fails closed with full rollback.
# -------------------------------------------------------------------------
log "PROOF 5: unknown legacy state fails closed"
UNKNOWN_URL=$(make_db canonical_unknown)
psql "$UNKNOWN_URL" -X -v ON_ERROR_STOP=1 -f "$FIXTURE" \
  > "$ARTIFACT_DIR/unknown_fixture.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/unknown_fixture.log"; fail "fixture failed on unknown-state DB"; }
psql "$UNKNOWN_URL" -X -v ON_ERROR_STOP=1 \
  -c "create table public.import_runs (id uuid primary key, wrong_shape boolean);" \
  >> "$ARTIFACT_DIR/unknown_fixture.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/unknown_fixture.log"; fail "could not inject unknown state"; }
if psql "$UNKNOWN_URL" -X -v ON_ERROR_STOP=1 -f "$CONVERGENCE" \
     > "$ARTIFACT_DIR/unknown_convergence.log" 2>&1; then
  cat "$ARTIFACT_DIR/unknown_convergence.log"
  fail "convergence unexpectedly SUCCEEDED against an unknown state — fail-closed contract broken"
fi
log "  convergence refused the unknown state (expected failure observed)."
LEFTOVER=$(psql "$UNKNOWN_URL" -X -q -t -A -c "
  select count(*) from (
    select 1 from pg_namespace where nspname = 'duewatch_ops'
    union all select 1 from pg_tables where schemaname='public' and tablename in
      ('autopilot_execution_claims','payments','payment_allocations','import_batches','import_rows')
  ) x;")
[ "$LEFTOVER" = "0" ] || fail "unknown-state run left objects behind (rollback incomplete): $LEFTOVER"
FK_STATE=$(psql "$UNKNOWN_URL" -X -q -t -A -c "
  select count(*) from pg_constraint
  where conrelid = 'public.invoices'::regclass and contype='f'
    and pg_get_constraintdef(oid) like 'FOREIGN KEY (client_id) REFERENCES clients(id)%ON DELETE CASCADE%';")
[ "$FK_STATE" = "1" ] || fail "unknown-state run altered the legacy FK (rollback incomplete)"
log "PROOF 5 PASSED: fail-closed + full rollback verified."

# ---------------------------------------------------------------------------
# PROOF 6 — second invocation after successful convergence FAILS CLOSED
# without changing anything (the one-time-tool contract: no weak
# "already canonical" shortcut exists).
# ---------------------------------------------------------------------------
log "PROOF 6: second convergence invocation must fail closed, no mutation"
if psql "$LEGACY_URL" -X -v ON_ERROR_STOP=1 -f "$CONVERGENCE" \
     > "$ARTIFACT_DIR/convergence_rerun.log" 2>&1; then
  cat "$ARTIFACT_DIR/convergence_rerun.log"
  fail "second convergence invocation unexpectedly SUCCEEDED — fail-closed contract broken"
fi
grep -q "already-mutated state" "$ARTIFACT_DIR/convergence_rerun.log" \
  || { cat "$ARTIFACT_DIR/convergence_rerun.log"; fail "second invocation failed for an unexpected reason (expected the already-mutated refusal)"; }
snapshot_db "$LEGACY_URL" "$ARTIFACT_DIR/snapshot_converged_rerun.txt"
if diff -u "$ARTIFACT_DIR/snapshot_converged.txt" "$ARTIFACT_DIR/snapshot_converged_rerun.txt" \
   > "$ARTIFACT_DIR/diff_rerun.txt"; then
  log "PROOF 6 PASSED: second invocation refused (fail-closed) and left the canonical state unchanged."
else
  cat "$ARTIFACT_DIR/diff_rerun.txt"
  fail "second invocation changed the canonical state despite refusing"
fi

# ---------------------------------------------------------------------------
# PROOF 9 — FINAL-ASSERTION ROLLBACK: a failure in the final canonical
# assertion stage (the LAST thing before commit) must roll the entire
# convergence back, leaving the legacy database untouched. Proven by
# running a sabotaged copy of the baseline (one expected index name in
# the final-assertions section mangled) against the legacy fixture.
# ---------------------------------------------------------------------------
log "PROOF 9: final-assertion failure rolls the whole convergence back"
FINAL_URL=$(make_db canonical_finalassert)
psql "$FINAL_URL" -X -v ON_ERROR_STOP=1 -f "$FIXTURE" \
  > "$ARTIFACT_DIR/finalassert_fixture.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/finalassert_fixture.log"; fail "fixture failed on final-assert DB"; }
sed '/SECTION: final-canonical-assertions begin/,/SECTION: final-canonical-assertions end/ s/awaiting_signature_one_pending_per_invoice/final_assert_sabotaged_name/g' \
  "$BASELINE" > "$ARTIFACT_DIR/baseline_sabotaged.sql"
if psql "$FINAL_URL" -X -v ON_ERROR_STOP=1 -f "$ARTIFACT_DIR/baseline_sabotaged.sql" \
     > "$ARTIFACT_DIR/finalassert_run.log" 2>&1; then
  cat "$ARTIFACT_DIR/finalassert_run.log"
  fail "sabotaged baseline unexpectedly SUCCEEDED — final assertions are not gating"
fi
grep -q "FINAL ASSERTION FAILED" "$ARTIFACT_DIR/finalassert_run.log" \
  || { cat "$ARTIFACT_DIR/finalassert_run.log"; fail "sabotaged run failed for an unexpected reason"; }
# The failure must have occurred at the END (after all mutations ran) and
# still left nothing behind.
LEFTOVER=$(psql "$FINAL_URL" -X -q -t -A -c "
  select count(*) from (
    select 1 from pg_namespace where nspname = 'duewatch_ops'
    union all select 1 from pg_tables where schemaname='public' and tablename in
      ('autopilot_execution_claims','payments','payment_allocations','import_batches','import_rows')
  ) x;")
[ "$LEFTOVER" = "0" ] || fail "final-assertion failure left objects behind (rollback incomplete): $LEFTOVER"
FK_STATE2=$(psql "$FINAL_URL" -X -q -t -A -c "
  select count(*) from pg_constraint
  where conrelid = 'public.invoices'::regclass and contype='f'
    and pg_get_constraintdef(oid) like 'FOREIGN KEY (client_id) REFERENCES clients(id)%ON DELETE CASCADE%';")
[ "$FK_STATE2" = "1" ] || fail "final-assertion failure altered the legacy FK (rollback incomplete)"
PEND=$(psql "$FINAL_URL" -X -q -t -A -c "
  select count(*) from pg_indexes
  where schemaname='public' and tablename='awaiting_signature'
    and indexname='awaiting_signature_one_pending_per_invoice';")
[ "$PEND" = "0" ] || fail "final-assertion failure left the pending-only index behind (rollback incomplete)"
log "PROOF 9 PASSED: end-stage assertion failure rolled everything back (era objects absent, legacy FK intact, no pending index)."

# ---------------------------------------------------------------------------
# PROOF 7 — existing SQL test suites against the canonical baseline.
# ---------------------------------------------------------------------------
log "PROOF 7: existing test suites against canonical baseline"
TESTS_URL=$(make_db canonical_tests)
psql "$TESTS_URL" -X -v ON_ERROR_STOP=1 -f "$BASELINE" \
  > "$ARTIFACT_DIR/tests_baseline_apply.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/tests_baseline_apply.log"; fail "baseline failed on tests DB"; }

run_suite() {
  local name="$1"; shift
  log "  suite: $name"
  "$@" > "$ARTIFACT_DIR/test_${name// /_}.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/test_${name// /_}.log"; fail "suite FAILED: $name"; }
  log "  suite PASSED: $name"
}

run_suite claims_sql psql "$TESTS_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/tests/autopilot_execution_claims_test.sql
run_suite awaiting_uniqueness_sql psql "$TESTS_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/tests/awaiting_signature_pending_uniqueness_test.sql
chmod +x supabase/tests/autopilot_execution_claims_concurrency_proof.sh
run_suite claims_concurrency supabase/tests/autopilot_execution_claims_concurrency_proof.sh "$TESTS_URL"
# The payments suite is MIGRATION-BEHAVIORAL: it asserts audit/snapshot
# values for legacy invoices seeded by its own pre-migration fixtures and
# then migrated by the payments migration itself. It is therefore run the
# same way its CI verifier (scripts/ci/verify-payments-foundation.sh) runs
# it — checkpoint bootstrap + pre-migration seed + the ARCHIVED payments
# migration (unchanged) — proving the archived artifact still behaves.
PAY_URL=$(make_db canonical_payments_suite)
psql "$PAY_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations_legacy/schema.sql \
  > "$ARTIFACT_DIR/payments_suite_bootstrap.log" 2>&1 \
  || { cat "$ARTIFACT_DIR/payments_suite_bootstrap.log"; fail "payments suite bootstrap: schema.sql failed"; }
for mig in \
  20260726000000_canonical_clients.sql \
  20260803021842_enforce_invoice_client_tenant_ownership.sql \
  20260810000000_client_source_identities_rls.sql \
  20260811000000_client_source_identities_tenant_fk.sql
do
  psql "$PAY_URL" -X -v ON_ERROR_STOP=1 -f "supabase/migrations_legacy/$mig" \
    >> "$ARTIFACT_DIR/payments_suite_bootstrap.log" 2>&1 \
    || { cat "$ARTIFACT_DIR/payments_suite_bootstrap.log"; fail "payments suite bootstrap: $mig failed"; }
done
run_suite payments_pre_schema psql "$PAY_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/tests/payments_foundation_pre_migration_schema.sql
run_suite payments_pre_seed psql "$PAY_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/tests/payments_foundation_pre_migration_setup.sql
run_suite payments_migration psql "$PAY_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations_legacy/20260816120000_payments_foundation.sql
run_suite payments_sql psql "$PAY_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/tests/payments_foundation_test.sql
run_suite payments_reapply psql "$PAY_URL" -X -v ON_ERROR_STOP=1 \
  -f supabase/migrations_legacy/20260816120000_payments_foundation.sql
chmod +x supabase/tests/payments_foundation_concurrency_proof.sh
run_suite payments_concurrency supabase/tests/payments_foundation_concurrency_proof.sh "$PAY_URL"
log "PROOF 7 PASSED: claims/awaiting suites green against the canonical baseline; payments suite green via its CI bootstrap sequence against the archived migration."

log "=== ALL CANONICAL PROOFS PASSED ==="
exit 0
