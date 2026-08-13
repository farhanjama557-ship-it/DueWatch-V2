#!/usr/bin/env bash
# Two-connection concurrency proof for acquire_autopilot_execution_claim's
# atomic claim acquisition (post-2A.1 execution safety checkpoint).
#
# This is the load-bearing guarantee behind Autopilot's at-most-once
# automatic reminder-send: two concurrent scheduler runs (or a genuine
# overlap between a manual dispatch and a cron run, or two rapid founder
# approval attempts) racing the SAME (user_id, invoice_id, rule_id,
# action_type) identity must result in exactly ONE acquired claim -- the
# loser must get acquired = false and, in the real scheduler/Edge
# Function, therefore make ZERO Resend calls.
#
# Review-fix pass (MEDIUM 2): the prior version of this script raced a
# DEBUG COPY of the acquire function with an injected pg_sleep, which only
# proved the atomic-insert PATTERN, not the exact deployed function. This
# version races public.acquire_autopilot_execution_claim itself, completely
# unmodified. The deterministic-overlap sleep that makes the race reliable
# instead of a timing coin-flip is issued as a SEPARATE, ordinary
# session-level `select pg_sleep(...)` statement BEFORE the real function
# call, from the client script -- never baked into the function's own
# definition. Both connections sleep independently and then call the real
# function immediately upon waking, which reproduces a tight overlap
# window without touching the artifact being proven.
#
# Usage: ./autopilot_execution_claims_concurrency_proof.sh <database_name>
# Must be run against a local, disposable Postgres instance that already
# has schema.sql and 20260813161329_autopilot_execution_claims.sql
# applied. Never run this against hosted staging or production.
set -euo pipefail

DB="${1:?usage: autopilot_execution_claims_concurrency_proof.sh <database_name>}"

echo "=== Concurrency proof: two callers racing the REAL acquire_autopilot_execution_claim ==="

cleanup() {
  if [ -n "${USER_ID:-}" ]; then
    psql -d "$DB" -v ON_ERROR_STOP=1 -c "delete from auth.users where id = '$USER_ID';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

USER_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select gen_random_uuid();")
USER_ID=$(echo "$USER_ID" | tr -d '[:space:]')
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into auth.users(id, email) values ('$USER_ID', 'claim-concurrency-proof@example.test');" >/dev/null

INVOICE_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), '$USER_ID'::uuid, 100, '2026-08-01', false)
  returning id;
")
INVOICE_ID=$(echo "$INVOICE_ID" | tr -d '[:space:]')
RULE_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select gen_random_uuid();")
RULE_ID=$(echo "$RULE_ID" | tr -d '[:space:]')

CALLER_A_FILE=$(mktemp)
CALLER_B_FILE=$(mktemp)
trap 'rm -f "$CALLER_A_FILE" "$CALLER_B_FILE"; cleanup' EXIT

# Both callers sleep independently (a plain session-level statement, not
# part of the function under test), then immediately call the real,
# unmodified function. Launched together via `&` from the same bash
# process, so both sleeps start within microseconds of each other and both
# wake and fire their INSERT within a tight, genuinely overlapping window.
(
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    select pg_sleep(0.5);
    select acquired from public.acquire_autopilot_execution_claim(
      '$USER_ID'::uuid, '$INVOICE_ID'::uuid, '$RULE_ID'::uuid, 'send_reminder', 'race-key-a'
    );
  " > "$CALLER_A_FILE"
) &
PID_A=$!

(
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    select pg_sleep(0.5);
    select acquired from public.acquire_autopilot_execution_claim(
      '$USER_ID'::uuid, '$INVOICE_ID'::uuid, '$RULE_ID'::uuid, 'send_reminder', 'race-key-b'
    );
  " > "$CALLER_B_FILE"
) &
PID_B=$!

wait "$PID_A"
wait "$PID_B"

# -qtA against a multi-statement -c prints one output line per statement;
# pg_sleep(...) itself prints an empty result row, so the LAST non-empty
# line is the acquired result.
RESULT_A=$(grep -v '^$' "$CALLER_A_FILE" | tail -n 1 | tr -d '[:space:]')
RESULT_B=$(grep -v '^$' "$CALLER_B_FILE" | tail -n 1 | tr -d '[:space:]')
echo "caller A acquired=$RESULT_A"
echo "caller B acquired=$RESULT_B"

FAIL=0
if [ -z "$RESULT_A" ] || [ -z "$RESULT_B" ]; then
  echo "FAIL: one or both concurrent calls errored instead of resolving acquired=t/f"
  FAIL=1
fi
if [ "$RESULT_A" = "$RESULT_B" ]; then
  echo "FAIL: both concurrent callers resolved to the SAME acquired value ($RESULT_A) -- expected exactly one winner"
  FAIL=1
fi
if [ "$RESULT_A" != "t" ] && [ "$RESULT_B" != "t" ]; then
  echo "FAIL: neither concurrent caller won the claim"
  FAIL=1
fi

CLAIM_COUNT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.autopilot_execution_claims
  where user_id = '$USER_ID' and invoice_id = '$INVOICE_ID' and rule_id = '$RULE_ID' and action_type = 'send_reminder';
")
CLAIM_COUNT=$(echo "$CLAIM_COUNT" | tr -d '[:space:]')
if [ "$CLAIM_COUNT" -ne 1 ]; then
  echo "FAIL: expected exactly 1 claim row for the contested identity, got $CLAIM_COUNT"
  FAIL=1
fi

# The persisted idempotency_key must belong to whichever caller actually
# won -- proves the row really came from one real INSERT, not a fluke.
WINNER_KEY=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select idempotency_key from public.autopilot_execution_claims
  where user_id = '$USER_ID' and invoice_id = '$INVOICE_ID' and rule_id = '$RULE_ID' and action_type = 'send_reminder';
")
WINNER_KEY=$(echo "$WINNER_KEY" | tr -d '[:space:]')
if [ "$WINNER_KEY" != "race-key-a" ] && [ "$WINNER_KEY" != "race-key-b" ]; then
  echo "FAIL: persisted idempotency_key ($WINNER_KEY) does not match either real caller"
  FAIL=1
fi

# In the real scheduler and manual-approval Edge Function,
# runClaimedSend() (autopilotExecutionCore.js) only ever calls
# io.sendEmail() after checking claim.acquired === true. Exactly one row +
# exactly one acquired=true caller, proven above -- against the real,
# unmodified acquire_autopilot_execution_claim -- is therefore also a
# proof that at most one of the two callers could ever have reached the
# Resend call.

psql -d "$DB" -v ON_ERROR_STOP=1 -c "delete from auth.users where id = '$USER_ID';" > /dev/null
REMAINING=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.autopilot_execution_claims where user_id = '$USER_ID';
")
REMAINING=$(echo "$REMAINING" | tr -d '[:space:]')
if [ "$REMAINING" -ne 0 ]; then
  echo "FAIL: fixture cleanup left $REMAINING claim row(s) behind"
  FAIL=1
fi
USER_ID="" # already deleted; skip double-delete in the EXIT trap

if [ "$FAIL" -ne 0 ]; then
  echo "=== AUTOPILOT EXECUTION CLAIM CONCURRENCY PROOF FAILED ==="
  exit 1
fi
echo "=== AUTOPILOT EXECUTION CLAIM CONCURRENCY PROOF PASSED (real function, exactly one winner, 1 row, fixture cleaned up) ==="
