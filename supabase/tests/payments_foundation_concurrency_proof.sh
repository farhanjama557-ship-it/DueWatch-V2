#!/usr/bin/env bash
# Two-connection concurrency proof for the Payments Foundation RPCs
# (public.record_payment / public.reverse_payment), adversarial review
# MEDIUM 2.
#
# A sequential DO block cannot exercise genuine concurrency -- it never
# leaves the transaction long enough for a second, real connection to
# contend for the same locked row. This script races the REAL, unmodified
# record_payment/reverse_payment functions from two independent psql
# connections launched together via `&`, each issuing a deterministic
# `select pg_sleep(0.5);` immediately before the real call (a plain
# session-level statement, never baked into the functions under test) so
# both connections reliably overlap on the same locked invoice/payment row
# instead of racing on unpredictable real-world timing -- the same pattern
# already established by autopilot_execution_claims_concurrency_proof.sh.
#
# record_payment/reverse_payment take no user_id argument by design --
# tenant identity comes only from auth.uid() (see the migration's own
# comment). Each connection below sets the session-level
# `request.jwt.claim.sub` GUC to the fixture founder's id before calling,
# which is exactly what auth.uid() reads in a real Supabase Postgres
# instance -- this is not a stand-in for the RPC, it is how a real
# authenticated connection's identity is actually established.
#
# Usage: ./payments_foundation_concurrency_proof.sh <database_name>
# Must be run against a local, disposable Postgres instance that already
# has schema.sql + the invoices.currency/payment_date columns +
# 20260816120000_payments_foundation.sql applied. Never run this against
# hosted staging or production.
set -euo pipefail

DB="${1:?usage: payments_foundation_concurrency_proof.sh <database_name>}"

FAIL=0

# Unlike the sibling autopilot/import concurrency proofs, this script does
# NOT delete its auth.users fixture row on exit. payment_allocations rows
# are trigger-enforced immutable (no update or delete, ever -- see
# duewatch_ops.reject_payment_allocation_mutation() in the migration) and
# both payment_allocations.payment_id and .invoice_id are ON DELETE
# RESTRICT. Once a real allocation exists, deleting the owning auth.users
# row (even via cascade) is structurally impossible -- Postgres rejects it
# with a foreign key violation, by design: this is the same append-only
# ledger guarantee the rest of this proof exists to verify, and working
# around it here (e.g. by disabling the trigger) would undermine the very
# guarantee under test. This script only ever runs against a fully
# disposable database that is destroyed after the CI job -- leaving its
# fixture rows in place is the correct, honest behavior, not an oversight.
cleanup() {
  rm -f "${A_FILE:-}" "${B_FILE:-}" "${C1_FILE:-}" "${C2_FILE:-}"
}
trap cleanup EXIT

USER_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select gen_random_uuid();")
USER_ID=$(echo "$USER_ID" | tr -d '[:space:]')
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into auth.users(id, email) values ('$USER_ID', 'payments-concurrency-proof@example.test');" >/dev/null

run_as_user() {
  # $1 = SQL to run (after setting the session identity)
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    set request.jwt.claim.sub = '$USER_ID';
    $1
  "
}

# ============================================================
# CASE A -- two record_payment calls racing full allocations
# against the SAME invoice.
# ============================================================
echo "=== CASE A: two concurrent record_payment calls, same invoice, both attempting the full amount ==="

INVOICE_A=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  insert into public.invoices(id, user_id, amount, amount_paid, paid, due_date, currency)
  values (gen_random_uuid(), '$USER_ID'::uuid, 100, 0, false, '2026-08-01', 'USD')
  returning id;
")
INVOICE_A=$(echo "$INVOICE_A" | tr -d '[:space:]')

A_FILE=$(mktemp)
B_FILE=$(mktemp)

(
  run_as_user "
    select pg_sleep(0.5);
    select record_payment('2026-08-15'::date, 100, 'USD',
      jsonb_build_array(jsonb_build_object('invoice_id', '$INVOICE_A', 'amount', 100)),
      null, 'concurrency proof caller A');
  " > "$A_FILE" 2>&1
) &
PID_A=$!

(
  run_as_user "
    select pg_sleep(0.5);
    select record_payment('2026-08-15'::date, 100, 'USD',
      jsonb_build_array(jsonb_build_object('invoice_id', '$INVOICE_A', 'amount', 100)),
      null, 'concurrency proof caller B');
  " > "$B_FILE" 2>&1
) &
PID_B=$!

set +e
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
set -e

echo "caller A exit=$RC_A"
echo "caller B exit=$RC_B"

# Exactly one of the two full-amount calls must succeed (RC 0) and the
# other must fail cleanly (RC nonzero, psql -v ON_ERROR_STOP=1 exits
# nonzero on a raised exception) -- never both succeeding (that would
# double the invoice's balance) and never both failing.
if [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ]; then
  echo "FAIL A: BOTH concurrent full-amount record_payment calls succeeded -- invoice would be double-allocated"
  FAIL=1
elif [ "$RC_A" -ne 0 ] && [ "$RC_B" -ne 0 ]; then
  echo "FAIL A: BOTH concurrent record_payment calls failed -- expected exactly one winner"
  cat "$A_FILE"; cat "$B_FILE"
  FAIL=1
else
  echo "OK A: exactly one caller succeeded, the other was cleanly rejected"
fi

# The loser's failure must be the real overpay guard, not a lock timeout,
# deadlock, or unrelated error -- proves this was a real, understood
# rejection, not a fluke.
LOSER_FILE="$A_FILE"
if [ "$RC_A" -eq 0 ]; then LOSER_FILE="$B_FILE"; fi
if [ "$RC_A" -ne 0 ] && [ "$RC_B" -ne 0 ]; then
  LOSER_FILE=""
fi
if [ -n "$LOSER_FILE" ] && ! grep -q "Allocation would overpay invoice" "$LOSER_FILE"; then
  echo "FAIL A: loser's failure was not the expected overpay guard:"
  cat "$LOSER_FILE"
  FAIL=1
fi

AMOUNT_PAID_A=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select amount_paid from public.invoices where id = '$INVOICE_A';" | tr -d '[:space:]')
PAID_FLAG_A=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select paid from public.invoices where id = '$INVOICE_A';" | tr -d '[:space:]')
ACTIVE_ALLOC_SUM_A=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select coalesce(sum(a.amount), 0)::numeric(12,2) from public.payment_allocations a
  join public.payments p on p.id = a.payment_id
  where a.invoice_id = '$INVOICE_A' and p.reversed_at is null;
" | tr -d '[:space:]')
echo "invoice amount_paid=$AMOUNT_PAID_A paid=$PAID_FLAG_A active_allocation_sum=$ACTIVE_ALLOC_SUM_A"

if [ "$AMOUNT_PAID_A" != "100.00" ]; then
  echo "FAIL A: expected amount_paid=100.00 (exactly one 100 allocation), got $AMOUNT_PAID_A"
  FAIL=1
fi
if [ "$PAID_FLAG_A" != "t" ]; then
  echo "FAIL A: expected paid=true"
  FAIL=1
fi
if [ "$AMOUNT_PAID_A" != "$ACTIVE_ALLOC_SUM_A" ]; then
  echo "FAIL A: invoice.amount_paid ($AMOUNT_PAID_A) does not equal the sum of active allocations ($ACTIVE_ALLOC_SUM_A) -- aggregate is not derivable from ledger state"
  FAIL=1
fi

PAYMENT_ROWS_A=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.payments
  where id in (select payment_id from public.payment_allocations where invoice_id = '$INVOICE_A')
    and reversed_at is null;
" | tr -d '[:space:]')
if [ "$PAYMENT_ROWS_A" != "1" ]; then
  echo "FAIL A: expected exactly 1 active payment row allocated to the invoice, got $PAYMENT_ROWS_A"
  FAIL=1
fi

echo ""

# ============================================================
# CASE B -- two reverse_payment calls racing the SAME payment.
# ============================================================
echo "=== CASE B: two concurrent reverse_payment calls, same payment ==="

INVOICE_B=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  insert into public.invoices(id, user_id, amount, amount_paid, paid, due_date, currency)
  values (gen_random_uuid(), '$USER_ID'::uuid, 100, 0, false, '2026-08-01', 'USD')
  returning id;
")
INVOICE_B=$(echo "$INVOICE_B" | tr -d '[:space:]')

PAYMENT_B=$(run_as_user "
  select (record_payment('2026-08-15'::date, 100, 'USD',
    jsonb_build_array(jsonb_build_object('invoice_id', '$INVOICE_B', 'amount', 100)),
    null, 'case B setup')->>'payment_id');
")
PAYMENT_B=$(echo "$PAYMENT_B" | tr -d '[:space:]')

C1_FILE=$(mktemp)
C2_FILE=$(mktemp)
# Reuse the same mktemp-name variables the EXIT trap already knows about
# (A_FILE/B_FILE) is wrong here -- name these distinctly so cleanup covers
# them too.
A2_FILE="$C1_FILE"
B2_FILE="$C2_FILE"

(
  run_as_user "
    select pg_sleep(0.5);
    select reverse_payment('$PAYMENT_B'::uuid, 'concurrency proof reversal attempt 1');
  " > "$A2_FILE" 2>&1
) &
PID_A2=$!

(
  run_as_user "
    select pg_sleep(0.5);
    select reverse_payment('$PAYMENT_B'::uuid, 'concurrency proof reversal attempt 2');
  " > "$B2_FILE" 2>&1
) &
PID_B2=$!

set +e
wait "$PID_A2"; RC_A2=$?
wait "$PID_B2"; RC_B2=$?
set -e

echo "reversal attempt 1 exit=$RC_A2"
echo "reversal attempt 2 exit=$RC_B2"

if [ "$RC_A2" -eq 0 ] && [ "$RC_B2" -eq 0 ]; then
  echo "FAIL B: BOTH concurrent reversal attempts succeeded -- the invoice aggregate would be double-subtracted"
  FAIL=1
elif [ "$RC_A2" -ne 0 ] && [ "$RC_B2" -ne 0 ]; then
  echo "FAIL B: BOTH concurrent reversal attempts failed -- expected exactly one winner"
  cat "$A2_FILE"; cat "$B2_FILE"
  FAIL=1
else
  echo "OK B: exactly one reversal succeeded, the other was cleanly rejected"
fi

LOSER2_FILE=""
if [ "$RC_A2" -ne 0 ] && [ "$RC_B2" -eq 0 ]; then LOSER2_FILE="$A2_FILE"; fi
if [ "$RC_B2" -ne 0 ] && [ "$RC_A2" -eq 0 ]; then LOSER2_FILE="$B2_FILE"; fi
if [ -n "$LOSER2_FILE" ] && ! grep -q "Payment has already been reversed" "$LOSER2_FILE"; then
  echo "FAIL B: loser's failure was not the expected already-reversed guard:"
  cat "$LOSER2_FILE"
  FAIL=1
fi

AMOUNT_PAID_B=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select amount_paid from public.invoices where id = '$INVOICE_B';" | tr -d '[:space:]')
PAID_FLAG_B=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select paid from public.invoices where id = '$INVOICE_B';" | tr -d '[:space:]')
REVERSED_COUNT_B=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select count(*) from public.payments where id = '$PAYMENT_B' and reversed_at is not null;" | tr -d '[:space:]')
echo "invoice amount_paid=$AMOUNT_PAID_B paid=$PAID_FLAG_B reversed_payment_rows=$REVERSED_COUNT_B"

if [ "$AMOUNT_PAID_B" != "0.00" ]; then
  echo "FAIL B: expected amount_paid=0.00 after exactly one reversal, got $AMOUNT_PAID_B (double-subtraction or lost update)"
  FAIL=1
fi
if [ "$PAID_FLAG_B" != "f" ]; then
  echo "FAIL B: expected paid=false after reversal"
  FAIL=1
fi
if [ "$REVERSED_COUNT_B" != "1" ]; then
  echo "FAIL B: expected exactly 1 reversed payment row, got $REVERSED_COUNT_B"
  FAIL=1
fi

echo ""

# ============================================================
# CASE C -- record_payment vs reverse_payment race on the SAME
# invoice (a NEW payment attempt racing the reversal of an
# EXISTING payment already covering that invoice).
# ============================================================
echo "=== CASE C: record_payment vs reverse_payment racing on the same invoice ==="

INVOICE_C=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  insert into public.invoices(id, user_id, amount, amount_paid, paid, due_date, currency)
  values (gen_random_uuid(), '$USER_ID'::uuid, 100, 0, false, '2026-08-01', 'USD')
  returning id;
")
INVOICE_C=$(echo "$INVOICE_C" | tr -d '[:space:]')

PAYMENT_C=$(run_as_user "
  select (record_payment('2026-08-10'::date, 100, 'USD',
    jsonb_build_array(jsonb_build_object('invoice_id', '$INVOICE_C', 'amount', 100)),
    null, 'case C setup -- full original payment')->>'payment_id');
")
PAYMENT_C=$(echo "$PAYMENT_C" | tr -d '[:space:]')

REV_FILE=$(mktemp)
NEW_FILE=$(mktemp)

(
  run_as_user "
    select pg_sleep(0.5);
    select reverse_payment('$PAYMENT_C'::uuid, 'concurrency proof: reversing original payment');
  " > "$REV_FILE" 2>&1
) &
PID_REV=$!

(
  run_as_user "
    select pg_sleep(0.5);
    select record_payment('2026-08-16'::date, 50, 'USD',
      jsonb_build_array(jsonb_build_object('invoice_id', '$INVOICE_C', 'amount', 50)),
      null, 'concurrency proof: new payment racing the reversal');
  " > "$NEW_FILE" 2>&1
) &
PID_NEW=$!

set +e
wait "$PID_REV"; RC_REV=$?
wait "$PID_NEW"; RC_NEW=$?
set -e

echo "reversal exit=$RC_REV, new-payment exit=$RC_NEW"

# Only one shared resource (the single invoice row) is ever locked by
# either transaction here -- record_payment locks it directly, and
# reverse_payment locks it only after already holding the payment row
# (which the new-payment transaction never touches), so there is no
# possible lock-ordering cycle between these two specific calls, and
# therefore no deadlock is possible in this exact scenario. Both
# processes completing (neither hangs) is itself part of the proof --
# `wait` above would block forever on a real deadlock.
if [ "$RC_REV" -ne 0 ]; then
  echo "FAIL C: the reversal itself failed -- nothing should structurally block it here"
  cat "$REV_FILE"
  FAIL=1
else
  echo "OK C: reversal succeeded (expected unconditionally)"
fi

# The new payment may legitimately succeed (if the reversal's freed
# capacity committed before the new allocation was validated) or fail
# with the overpay guard (if it was validated while the invoice still
# showed the pre-reversal balance) -- BOTH are valid, deterministic
# outcomes of a real lock-ordered race. What must hold regardless is the
# derivability invariant checked below.
if [ "$RC_NEW" -eq 0 ]; then
  echo "OK C: new payment succeeded (reversal committed first) -- valid outcome"
elif grep -q "Allocation would overpay invoice" "$NEW_FILE"; then
  echo "OK C: new payment was cleanly rejected as overpay (new payment's lock attempt landed before the reversal committed) -- valid outcome"
else
  echo "FAIL C: new payment failed for an unexpected reason:"
  cat "$NEW_FILE"
  FAIL=1
fi

AMOUNT_PAID_C=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select amount_paid from public.invoices where id = '$INVOICE_C';" | tr -d '[:space:]')
ACTIVE_ALLOC_SUM_C=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select coalesce(sum(a.amount), 0)::numeric(12,2) from public.payment_allocations a
  join public.payments p on p.id = a.payment_id
  where a.invoice_id = '$INVOICE_C' and p.reversed_at is null;
" | tr -d '[:space:]')
echo "invoice amount_paid=$AMOUNT_PAID_C active_allocation_sum=$ACTIVE_ALLOC_SUM_C"

# The load-bearing invariant: the invoice aggregate must equal the sum of
# currently-active (non-reversed) allocations, in EITHER valid outcome.
if [ "$AMOUNT_PAID_C" != "$ACTIVE_ALLOC_SUM_C" ]; then
  echo "FAIL C: invoice.amount_paid ($AMOUNT_PAID_C) does not equal the sum of active allocations ($ACTIVE_ALLOC_SUM_C) -- aggregate is not derivable from ledger state after the race"
  FAIL=1
fi
if [ "$RC_NEW" -eq 0 ] && [ "$AMOUNT_PAID_C" != "50.00" ]; then
  echo "FAIL C: new payment succeeded but amount_paid ($AMOUNT_PAID_C) is not the expected 50.00"
  FAIL=1
fi
if [ "$RC_NEW" -ne 0 ] && [ "$AMOUNT_PAID_C" != "0.00" ]; then
  echo "FAIL C: new payment was rejected but amount_paid ($AMOUNT_PAID_C) is not the expected 0.00"
  FAIL=1
fi

echo ""

# ---- fixture residue note ----
# Fixture rows (auth.users, invoices, payments, payment_allocations) are
# intentionally left in place. payment_allocations rows are immutable by
# trigger, and both payment_allocations.payment_id and .invoice_id are ON
# DELETE RESTRICT -- deleting auth.users (and cascading to invoices, which
# would require removing allocations first) is structurally impossible once
# real allocation rows exist. This disposable database is destroyed at CI
# job end; leaving fixture rows is correct behavior, not an oversight.

if [ "$FAIL" -ne 0 ]; then
  echo "=== PAYMENTS FOUNDATION CONCURRENCY PROOF FAILED ==="
  exit 1
fi
echo "=== PAYMENTS FOUNDATION CONCURRENCY PROOF PASSED (Cases A, B, C -- real functions, two real sessions) ==="
