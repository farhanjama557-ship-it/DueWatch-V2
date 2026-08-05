#!/usr/bin/env bash
# Two-connection concurrency proof for start_import_run's atomic
# idempotent-run-creation fix (independent review Blocker 8).
#
# The original implementation did a plain SELECT to check for an existing
# run, then INSERT if none was found — a classic TOCTOU race: two
# concurrent calls with the SAME idempotency key and SAME payload could
# both pass the SELECT, then one INSERT would win and the other would fail
# outright on the (user_id, idempotency_key) unique constraint instead of
# gracefully resolving to the same run. The fix replaces this with
# `INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING
# id`, which is atomic at the index level: Postgres serializes concurrent
# inserts against the same key, so the loser blocks until the winner's
# transaction resolves, then falls through to a SELECT that reliably finds
# the winner's committed row.
#
# This script proves it with two REAL concurrent connections (a single
# transactional script cannot exercise genuine concurrency). It creates a
# minimal DEBUG copy of just the atomic-insert core (with an injected
# pg_sleep to make the race window deterministic rather than a timing
# coin-flip) — the real public.start_import_run is never modified. The
# debug function and its fixture are dropped/deleted before this script
# exits, whether it passes or fails.
#
# Usage: ./import_persistence_run_idempotency_concurrency_proof.sh <database_name>
# Must be run against a local, disposable Postgres instance that already
# has schema.sql and all three prior migrations applied. Never run this
# against hosted staging or production.
set -euo pipefail

DB="${1:?usage: import_persistence_run_idempotency_concurrency_proof.sh <database_name>}"

echo "=== Concurrency proof: two callers racing to create the same run ==="

cleanup() {
  psql -d "$DB" -v ON_ERROR_STOP=1 -c "drop function if exists public.start_import_run_debug(uuid, text, jsonb, numeric);" >/dev/null 2>&1 || true
  if [ -n "${USER_ID:-}" ]; then
    psql -d "$DB" -v ON_ERROR_STOP=1 -c "delete from auth.users where id = '$USER_ID';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

USER_ID=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "select gen_random_uuid();")
USER_ID=$(echo "$USER_ID" | tr -d '[:space:]')
psql -d "$DB" -v ON_ERROR_STOP=1 -c "insert into auth.users(id, email) values ('$USER_ID', 'run-idem-concurrency-proof@example.test');" >/dev/null

# Debug copy of exactly the atomic insert-or-find core of start_import_run
# (Blocker 8's fix), with a deterministic sleep before the INSERT so two
# concurrent sessions reliably overlap on it instead of racing on
# unpredictable real-world timing.
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
create or replace function public.start_import_run_debug(
  p_user_id uuid, p_idempotency_key text, p_rows jsonb, p_sleep_seconds numeric default 0
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run_id uuid;
  v_existing_run_id uuid;
  v_request_hash text;
  v_existing_hash text;
begin
  v_request_hash := encode(sha256(convert_to(p_rows::text, 'UTF8')), 'hex');
  perform pg_sleep(p_sleep_seconds);
  insert into public.import_runs(
    id, user_id, idempotency_key, request_payload_hash, status, total_rows, started_at
  ) values (
    gen_random_uuid(), p_user_id, p_idempotency_key, v_request_hash, 'in_progress', 0, now()
  )
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_run_id;

  if v_run_id is not null then
    return v_run_id;
  end if;

  select id, request_payload_hash into v_existing_run_id, v_existing_hash
  from public.import_runs where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if v_existing_hash <> v_request_hash then
    raise exception 'conflicting payload';
  end if;
  return v_existing_run_id;
end
$$;
SQL

RUN_A_FILE=$(mktemp)
RUN_B_FILE=$(mktemp)
trap 'rm -f "$RUN_A_FILE" "$RUN_B_FILE"; cleanup' EXIT

(
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    select public.start_import_run_debug('$USER_ID'::uuid, 'race-key', '[]'::jsonb, 0.5);
  " > "$RUN_A_FILE"
) &
PID_A=$!

(
  psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
    select public.start_import_run_debug('$USER_ID'::uuid, 'race-key', '[]'::jsonb, 0.5);
  " > "$RUN_B_FILE"
) &
PID_B=$!

wait "$PID_A"
wait "$PID_B"

RUN_A=$(tr -d '[:space:]' < "$RUN_A_FILE")
RUN_B=$(tr -d '[:space:]' < "$RUN_B_FILE")
echo "session A resolved run_id=$RUN_A"
echo "session B resolved run_id=$RUN_B"

FAIL=0
if [ -z "$RUN_A" ] || [ -z "$RUN_B" ]; then
  echo "FAIL: one or both concurrent calls errored instead of resolving a run_id"
  FAIL=1
fi
if [ "$RUN_A" != "$RUN_B" ]; then
  echo "FAIL: concurrent same-key/same-payload calls resolved to DIFFERENT runs ($RUN_A vs $RUN_B)"
  FAIL=1
fi

RUN_COUNT=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.import_runs where user_id = '$USER_ID' and idempotency_key = 'race-key';
")
RUN_COUNT=$(echo "$RUN_COUNT" | tr -d '[:space:]')
if [ "$RUN_COUNT" -ne 1 ]; then
  echo "FAIL: expected exactly 1 run row for the contested key, got $RUN_COUNT"
  FAIL=1
fi

# Cleanup (also runs via the EXIT trap, but do it here too so we can assert
# on the residue explicitly as part of the proof).
psql -d "$DB" -v ON_ERROR_STOP=1 -c "delete from auth.users where id = '$USER_ID';" > /dev/null
REMAINING=$(psql -d "$DB" -v ON_ERROR_STOP=1 -qtA -c "
  select count(*) from public.import_runs where user_id = '$USER_ID';
")
REMAINING=$(echo "$REMAINING" | tr -d '[:space:]')
if [ "$REMAINING" -ne 0 ]; then
  echo "FAIL: fixture cleanup left $REMAINING run row(s) behind"
  FAIL=1
fi
USER_ID="" # already deleted; skip double-delete in the EXIT trap

if [ "$FAIL" -ne 0 ]; then
  echo "=== RUN IDEMPOTENCY CONCURRENCY PROOF FAILED ==="
  exit 1
fi
echo "=== RUN IDEMPOTENCY CONCURRENCY PROOF PASSED (both callers resolved run_id=$RUN_A, 1 row, fixture cleaned up) ==="
