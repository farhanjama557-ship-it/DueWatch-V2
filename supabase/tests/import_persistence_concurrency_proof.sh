#!/usr/bin/env bash
# Two-connection concurrency proof for public.process_import_batch.
#
# Every other Checkpoint 1 test lives inside one "begin; ... rollback;"
# transaction (see import_persistence_recovery_test.sql), which is the
# right hygiene for logic proofs but cannot exercise real concurrency:
# a single transaction is inherently sequential. Proving "two concurrent
# workers cannot process the same batch/row twice" requires two actual
# database connections racing against each other, so this script commits
# a small fixture, runs the race, asserts on it, and deletes its own
# fixture afterward — it does not rely on rollback for cleanup.
#
# Usage: ./import_persistence_concurrency_proof.sh <database_name>
# Must be run against a local, disposable Postgres instance that already
# has schema.sql and all three prior migrations applied (see
# import_persistence_recovery_test.sql's header for the exact order).
# Never run this against hosted staging or production.
set -euo pipefail

DB="${1:?usage: import_persistence_concurrency_proof.sh <database_name>}"
PSQL="psql -d $DB -v ON_ERROR_STOP=1 -qtA"

echo "=== Concurrency proof: two workers racing on one run ==="

USER_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select gen_random_uuid();")
USER_ID=$(echo "$USER_ID" | tr -d '[:space:]')

psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL
insert into auth.users(id, email) values ('$USER_ID', 'concurrency-proof@example.test');
select set_config('request.jwt.claim.sub', '$USER_ID', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select public.start_import_run('$USER_ID'::uuid, 'concurrency-proof-key', \$j\$[
  {"row_number": 1, "outcome": "ready", "issue_codes": [],
   "normalized": {"client_name": "Concurrency Co", "invoice_number": "CONC-1",
     "invoice_date": "2026-01-01", "amount": "10.00"}}
]\$j\$::jsonb);
SQL

RUN_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select id from public.import_runs where user_id = '$USER_ID' and idempotency_key = 'concurrency-proof-key';
")
RUN_ID=$(echo "$RUN_ID" | tr -d '[:space:]')
echo "run_id=$RUN_ID"

# Session A: holds the exact row lock process_import_batch itself takes
# at its very first statement (select * from import_runs ... for update),
# for 2 seconds, inside its own transaction. This simulates "another
# concurrent process_import_batch call already has this run claimed."
(
  psql -d "$DB" -v ON_ERROR_STOP=1 <<SQL
begin;
select set_config('request.jwt.claim.sub', '$USER_ID', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select * from public.import_runs where id = '$RUN_ID' for update;
select pg_sleep(2);
rollback;
SQL
) > /tmp/concurrency_proof_session_a.log 2>&1 &
SESSION_A_PID=$!

sleep 0.5

# Session B: calls the real entry point while Session A still holds the
# run-row lock. It must block until Session A releases (proving the
# claim is fully serialized per run), not race it and claim/commit the
# same row a second time.
START_B=$(date +%s.%N)
psql -d "$DB" -v ON_ERROR_STOP=1 -c "
  select set_config('request.jwt.claim.sub', '$USER_ID', false);
  select set_config('request.jwt.claim.role', 'authenticated', false);
  select public.process_import_batch('$RUN_ID'::uuid);
" > /tmp/concurrency_proof_session_b.log 2>&1
END_B=$(date +%s.%N)

wait "$SESSION_A_PID"

ELAPSED=$(echo "$END_B - $START_B" | bc)
echo "session B blocked for ${ELAPSED}s waiting on session A's lock"

COMMITTED_COUNT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.import_rows where run_id = '$RUN_ID' and server_status = 'committed';
")
INVOICE_COUNT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.invoices where user_id = '$USER_ID';
")

FAIL=0
if (( $(echo "$ELAPSED < 1.5" | bc -l) )); then
  echo "FAIL: session B did not appear to block on session A's run-row lock (elapsed ${ELAPSED}s)"
  FAIL=1
fi
if [ "$COMMITTED_COUNT" -ne 1 ]; then
  echo "FAIL: expected exactly 1 committed row, got $COMMITTED_COUNT"
  FAIL=1
fi
if [ "$INVOICE_COUNT" -ne 1 ]; then
  echo "FAIL: expected exactly 1 invoice (no duplicate from a second claim), got $INVOICE_COUNT"
  FAIL=1
fi

# Cleanup: this script commits real rows (concurrency cannot be tested
# inside one shared transaction), so it must delete its own fixture
# rather than relying on rollback.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "delete from auth.users where id = '$USER_ID';" > /dev/null
REMAINING=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select (select count(*) from public.import_runs where user_id = '$USER_ID')
       + (select count(*) from public.clients where user_id = '$USER_ID')
       + (select count(*) from public.invoices where user_id = '$USER_ID');
")
if [ "$REMAINING" -ne 0 ]; then
  echo "FAIL: fixture cleanup left $REMAINING row(s) behind"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "=== CONCURRENCY PROOF FAILED ==="
  exit 1
fi
echo "=== CONCURRENCY PROOF PASSED (committed=$COMMITTED_COUNT invoices=$INVOICE_COUNT blocked_for=${ELAPSED}s, fixture cleaned up) ==="
