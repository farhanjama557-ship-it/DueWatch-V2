#!/usr/bin/env bash
# Two-connection concurrency proof for the Promise-to-Pay Foundation RPC
# public.confirm_promise -- proving the governance invariant (only one
# promise governs an invoice at a time) holds under real concurrency, not
# just sequential application logic.
#
# A sequential DO block cannot exercise genuine concurrency -- it never
# leaves the transaction long enough for a second, real connection to
# contend for the same locked row. This script races the REAL, unmodified
# confirm_promise function from two independent psql connections launched
# together via `&`, each issuing a deterministic `select pg_sleep(0.5);`
# immediately before the real call (a plain session-level statement, never
# baked into the function under test) so both connections reliably overlap
# instead of racing on unpredictable real-world timing -- the same pattern
# already established by payments_foundation_concurrency_proof.sh and
# autopilot_execution_claims_concurrency_proof.sh.
#
# propose_promise/confirm_promise take no user_id argument by design --
# tenant identity comes only from auth.uid(). Each connection below sets
# the session-level `request.jwt.claim.sub` GUC to the fixture founder's id
# before calling, exactly what auth.uid() reads in a real Supabase Postgres
# instance.
#
# Usage: ./promise_to_pay_concurrency_proof.sh <database_name>
# Must be run against a local, disposable Postgres instance that already
# has schema.sql + invoices.currency/invoices_user_id_id_uidx +
# 20260822130000_promise_to_pay_foundation.sql applied. Never run this
# against hosted staging or production.
set -euo pipefail

DB="${1:?usage: promise_to_pay_concurrency_proof.sh <database_name>}"

FAIL=0

# Fixture rows are intentionally left in place, not deleted, on exit --
# promises.invoice_id and .user_id are ON DELETE RESTRICT, so once a real
# promise exists, deleting its auth.users/invoices row is structurally
# impossible. This script only ever runs against a fully disposable
# database that is destroyed after the CI job.
cleanup() {
  rm -f "${A_FILE:-}" "${B_FILE:-}"
}
trap cleanup EXIT

USER_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select gen_random_uuid();")
USER_ID=$(echo "$USER_ID" | tr -d '[:space:]')
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into auth.users(id, email) values ('$USER_ID', 'ptp-concurrency-proof@example.test');" >/dev/null

run_as_user() {
  # $1 = SQL to run (after setting the session identity)
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    set request.jwt.claim.sub = '$USER_ID';
    $1
  "
}

# ============================================================
# CASE: two confirm_promise calls racing to govern the SAME invoice, each
# confirming a DIFFERENT already-proposed promise on that invoice.
# ============================================================
echo "=== CASE: two concurrent confirm_promise calls, two proposals, same invoice ==="

INVOICE=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  insert into public.invoices(id, user_id, amount, amount_paid, paid, due_date, currency)
  values (gen_random_uuid(), '$USER_ID'::uuid, 500, 0, false, '2026-09-01', 'USD')
  returning id;
")
INVOICE=$(echo "$INVOICE" | tr -d '[:space:]')

PROMISE_A=$(run_as_user "
  select (propose_promise('$INVOICE'::uuid, 200, '2026-09-10'::date, 'phone', 'caller A')->>'promise_id');
")
PROMISE_A=$(echo "$PROMISE_A" | tr -d '[:space:]')

PROMISE_B=$(run_as_user "
  select (propose_promise('$INVOICE'::uuid, 300, '2026-09-12'::date, 'email', 'caller B')->>'promise_id');
")
PROMISE_B=$(echo "$PROMISE_B" | tr -d '[:space:]')

A_FILE=$(mktemp)
B_FILE=$(mktemp)

(
  run_as_user "
    select pg_sleep(0.5);
    select confirm_promise('$PROMISE_A'::uuid, 200, '2026-09-10'::date);
  " > "$A_FILE" 2>&1
) &
PID_A=$!

(
  run_as_user "
    select pg_sleep(0.5);
    select confirm_promise('$PROMISE_B'::uuid, 300, '2026-09-12'::date);
  " > "$B_FILE" 2>&1
) &
PID_B=$!

set +e
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
set -e

echo "caller A exit=$RC_A"
echo "caller B exit=$RC_B"

# Exactly one of the two confirm calls must succeed (RC 0) and the other
# must fail cleanly (RC nonzero) -- never both succeeding (that would mean
# two promises governing the same invoice) and never both failing.
if [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ]; then
  echo "FAIL: BOTH concurrent confirm_promise calls succeeded -- two promises would govern the same invoice"
  FAIL=1
elif [ "$RC_A" -ne 0 ] && [ "$RC_B" -ne 0 ]; then
  echo "FAIL: BOTH concurrent confirm_promise calls failed -- expected exactly one winner"
  cat "$A_FILE"; cat "$B_FILE"
  FAIL=1
else
  echo "OK: exactly one caller succeeded, the other was cleanly rejected"
fi

# The loser's failure must be the real governance-constraint guard, not a
# lock timeout, deadlock, or unrelated error.
LOSER_FILE=""
if [ "$RC_A" -ne 0 ] && [ "$RC_B" -eq 0 ]; then LOSER_FILE="$A_FILE"; fi
if [ "$RC_B" -ne 0 ] && [ "$RC_A" -eq 0 ]; then LOSER_FILE="$B_FILE"; fi
if [ -n "$LOSER_FILE" ] && ! grep -q "Another promise already governs this invoice" "$LOSER_FILE"; then
  echo "FAIL: loser's failure was not the expected governance guard:"
  cat "$LOSER_FILE"
  FAIL=1
fi

CONFIRMED_COUNT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.promises where invoice_id = '$INVOICE' and status = 'confirmed';
" | tr -d '[:space:]')
echo "confirmed promises governing invoice=$CONFIRMED_COUNT"

if [ "$CONFIRMED_COUNT" != "1" ]; then
  echo "FAIL: expected exactly 1 confirmed (governing) promise for the invoice, got $CONFIRMED_COUNT"
  FAIL=1
fi

# The losing promise must remain 'proposed' -- a rejected confirm attempt
# must never leave the promise in a half-transitioned or ambiguous state.
STILL_PROPOSED=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.promises
  where invoice_id = '$INVOICE' and status = 'proposed';
" | tr -d '[:space:]')
if [ "$STILL_PROPOSED" != "1" ]; then
  echo "FAIL: expected exactly 1 promise to remain 'proposed' after the race, got $STILL_PROPOSED"
  FAIL=1
fi

# The confirmed promise must have exactly one matching 'confirmed' event
# (atomicity between the state transition and the evidence log).
CONFIRMED_EVENT_COUNT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.promise_events pe
  join public.promises p on p.id = pe.promise_id
  where p.invoice_id = '$INVOICE' and p.status = 'confirmed' and pe.event_type = 'confirmed';
" | tr -d '[:space:]')
if [ "$CONFIRMED_EVENT_COUNT" != "1" ]; then
  echo "FAIL: expected exactly 1 confirmed event for the governing promise, got $CONFIRMED_EVENT_COUNT"
  FAIL=1
fi

echo ""

# ---- fixture residue note ----
# Fixture rows (auth.users, invoices, promises, promise_events) are
# intentionally left in place -- promises.user_id/.invoice_id are ON DELETE
# RESTRICT, so deleting them is structurally impossible once real promise
# rows exist. This disposable database is destroyed at CI job end; leaving
# fixture rows is correct behavior, not an oversight.

if [ "$FAIL" -ne 0 ]; then
  echo "=== PROMISE-TO-PAY CONCURRENCY PROOF FAILED ==="
  exit 1
fi
echo "=== PROMISE-TO-PAY CONCURRENCY PROOF PASSED (governance invariant holds under real concurrency) ==="
