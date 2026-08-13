#!/usr/bin/env bash
# Two-connection concurrency proof for acquire_autopilot_execution_claim's
# atomic claim acquisition (post-2A.1 execution safety checkpoint).
#
# This is the load-bearing guarantee behind Autopilot's at-most-once
# automatic reminder-send: two concurrent scheduler runs (or a genuine
# overlap between a manual dispatch and a cron run) racing the SAME
# (user_id, invoice_id, rule_id, action_type) identity must result in
# exactly ONE acquired claim -- the loser must get acquired = false and,
# in the real scheduler, therefore make ZERO Resend calls.
#
# This script proves the acquisition race with two REAL concurrent
# connections (a single transactional script cannot exercise genuine
# concurrency -- see autopilot_execution_claims_test.sql for the
# single-connection behavioral proofs). It creates a minimal DEBUG copy of
# just the atomic-insert core (with an injected pg_sleep to make the race
# window deterministic rather than a timing coin-flip) -- the real
# public.acquire_autopilot_execution_claim is never modified. The debug
# function and its fixture are dropped/deleted before this script exits,
# whether it passes or fails. Mirrors
# import_persistence_run_idempotency_concurrency_proof.sh exactly.
#
# Usage: ./autopilot_execution_claims_concurrency_proof.sh <database_name>
# Must be run against a local, disposable Postgres instance that already
# has schema.sql and 20260813161329_autopilot_execution_claims.sql
# applied. Never run this against hosted staging or production.
set -euo pipefail

DB="${1:?usage: autopilot_execution_claims_concurrency_proof.sh <database_name>}"

echo "=== Concurrency proof: two schedulers racing to claim the same (user, invoice, rule, action) ==="

cleanup() {
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "drop function if exists public.acquire_autopilot_execution_claim_debug(uuid, uuid, uuid, text, text, numeric);" >/dev/null 2>&1 || true
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

# Debug copy of exactly the atomic insert-or-find core of
# acquire_autopilot_execution_claim, with a deterministic sleep before the
# INSERT so two concurrent sessions reliably overlap on it instead of
# racing on unpredictable real-world timing. Tenant/malformed-input
# validation is intentionally omitted from the debug copy -- that logic is
# already proven separately in autopilot_execution_claims_test.sql; this
# script exists only to prove the concurrency property.
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
create or replace function public.acquire_autopilot_execution_claim_debug(
  p_user_id uuid, p_invoice_id uuid, p_rule_id uuid, p_action_type text,
  p_idempotency_key text, p_sleep_seconds numeric default 0
) returns table(claim_id uuid, acquired boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim_id uuid;
begin
  perform pg_sleep(p_sleep_seconds);
  insert into public.autopilot_execution_claims(
    id, user_id, invoice_id, rule_id, action_type, idempotency_key, status, claimed_at
  ) values (
    gen_random_uuid(), p_user_id, p_invoice_id, p_rule_id, p_action_type, p_idempotency_key, 'in_flight', now()
  )
  on conflict (user_id, invoice_id, rule_id, action_type) do nothing
  returning id into v_claim_id;

  if v_claim_id is not null then
    return query select v_claim_id, true;
    return;
  end if;

  select id into v_claim_id from public.autopilot_execution_claims
  where user_id = p_user_id and invoice_id = p_invoice_id and rule_id = p_rule_id and action_type = p_action_type;
  return query select v_claim_id, false;
end;
$$;
SQL

CALLER_A_FILE=$(mktemp)
CALLER_B_FILE=$(mktemp)
trap 'rm -f "$CALLER_A_FILE" "$CALLER_B_FILE"; cleanup' EXIT

(
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    select acquired from public.acquire_autopilot_execution_claim_debug(
      '$USER_ID'::uuid, '$INVOICE_ID'::uuid, '$RULE_ID'::uuid, 'send_reminder', 'race-key-a', 0.5
    );
  " > "$CALLER_A_FILE"
) &
PID_A=$!

(
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    select acquired from public.acquire_autopilot_execution_claim_debug(
      '$USER_ID'::uuid, '$INVOICE_ID'::uuid, '$RULE_ID'::uuid, 'send_reminder', 'race-key-b', 0.5
    );
  " > "$CALLER_B_FILE"
) &
PID_B=$!

wait "$PID_A"
wait "$PID_B"

RESULT_A=$(tr -d '[:space:]' < "$CALLER_A_FILE")
RESULT_B=$(tr -d '[:space:]' < "$CALLER_B_FILE")
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

# In the real scheduler, sendEmail() is only ever called after checking
# claim.acquired === true (see actOnMatch in autopilot-scheduler/index.ts).
# Exactly one row + exactly one acquired=true caller, proven above, is
# therefore also a proof that at most one of the two callers could ever
# have reached the Resend call -- the loser's code path returns before
# sendEmail is referenced at all.

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
echo "=== AUTOPILOT EXECUTION CLAIM CONCURRENCY PROOF PASSED (exactly one winner, 1 row, fixture cleaned up) ==="
