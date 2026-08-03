-- Disposable Supabase/PostgreSQL integration test for Phase 1.5B
-- Checkpoint 1 (import persistence core). Apply schema.sql, then
-- 20260726000000_canonical_clients.sql, then
-- 20260803021842_enforce_invoice_client_tenant_ownership.sql, then
-- 20260803150000_import_persistence_core.sql before running this file.
-- Everything here runs inside one transaction that always rolls back.
--
-- This file exists to produce the "minimum recovery proof" required
-- before Checkpoint 1 can be reported verified:
--   1. lost response after a committed batch -> retry returns existing
--      results, no duplicates
--   2. stop/cancel between batches -> committed batches remain,
--      unprocessed rows stay pending, run status is truthful
--   3. a failed batch commits none of its rows/clients/invoices/events
--   4. progress is reconstructable from server state alone (refresh)
--   5. same idempotency key + a conflicting payload fails closed
--   7. cross-tenant attempts are rejected on every entry point, for an
--      authenticated caller AND for a caller with no simulated identity
--      at all (the service-role-safe path)
--   8. an unknown issue/outcome code blocks, never silently allowed
-- Proof 6 (two concurrent workers cannot claim the same row/batch) is
-- NOT in this file: it requires two genuinely concurrent connections,
-- which a single transactional script cannot exercise. See
-- import_persistence_concurrency_proof.sh for that proof; it commits
-- and then deletes its own fixture, since it cannot run inside one
-- transaction shared across two sessions.
begin;

\echo 'TEST GROUP START: eligibility_deny_by_default'
do $eligibility$
declare
  r record;
begin
  select * into r from duewatch_ops.evaluate_row_eligibility(
    'somehow_fine', array[]::text[], '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00"}'::jsonb
  );
  if r.eligible or r.reason_code <> 'UNKNOWN_OUTCOME' then
    raise exception 'Unknown outcome was not blocked as UNKNOWN_OUTCOME, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array['SOME_FUTURE_CODE_NOT_YET_TAUGHT'], '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00"}'::jsonb
  );
  if r.eligible or r.reason_code <> 'UNKNOWN_ISSUE_CODE' then
    raise exception 'Unknown issue code was not blocked as UNKNOWN_ISSUE_CODE, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array['DUPLICATE_IN_UPLOAD'], '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00"}'::jsonb
  );
  if r.eligible or r.reason_code <> 'BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME' then
    raise exception 'A real blocking code on a ready row was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready_with_warnings', array['ROW_COLUMN_COUNT_MISMATCH'], '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00"}'::jsonb
  );
  if not r.eligible then
    raise exception 'An approved warning code was blocked, expected eligible';
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00","status":"void"}'::jsonb
  );
  if r.eligible or r.reason_code <> 'UNSUPPORTED_STATUS_VALUE' then
    raise exception 'status=void was not blocked explicitly, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], '{"invoice_number":"X","invoice_date":"2026-01-01"}'::jsonb
  );
  if r.eligible or r.reason_code <> 'MISSING_MATERIAL_FIELD' then
    raise exception 'A missing material field (amount) was not blocked';
  end if;
end
$eligibility$;
\echo 'TEST GROUP PASS: eligibility_deny_by_default'

\echo 'TEST GROUP START: run_idempotency'
do $run_idempotency$
declare
  u uuid := gen_random_uuid();
  payload jsonb;
  conflicting_payload jsonb;
  run_1 uuid;
  run_2 uuid;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-idem@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  payload := $j$[{"row_number": 1, "outcome": "ready", "issue_codes": [],
    "normalized": {"client_name": "Idem Co", "invoice_number": "IDEM-1",
      "invoice_date": "2026-01-01", "amount": "10.00"}}]$j$::jsonb;
  conflicting_payload := $j$[{"row_number": 1, "outcome": "ready", "issue_codes": [],
    "normalized": {"client_name": "Idem Co", "invoice_number": "IDEM-1",
      "invoice_date": "2026-01-01", "amount": "99.00"}}]$j$::jsonb;

  run_1 := public.start_import_run(u, 'idem-key', payload);
  run_2 := public.start_import_run(u, 'idem-key', payload);
  if run_1 <> run_2 then
    raise exception 'Same key + same payload did not return the same run';
  end if;
  if (select count(*) from public.import_runs where user_id = u) <> 1 then
    raise exception 'Same key + same payload created a second run';
  end if;

  begin
    perform public.start_import_run(u, 'idem-key', conflicting_payload);
    raise exception 'Expected same-key-different-payload rejection';
  exception when others then
    if sqlerrm not like '%already been used%' and sqlerrm not like '%already used%' then
      raise;
    end if;
  end;

  if (select count(*) from public.import_runs where user_id = u) <> 1 then
    raise exception 'A rejected conflicting-payload retry still created or altered a run';
  end if;
  if (select total_rows from public.import_runs where id = run_1) <> 1 then
    raise exception 'A rejected conflicting-payload retry mutated the original run row count';
  end if;
end
$run_idempotency$;
\echo 'TEST GROUP PASS: run_idempotency'

\echo 'TEST GROUP START: lost_response_retry'
do $lost_response$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  result jsonb;
  invoice_id_before uuid;
  client_id_before uuid;
  committed_at_before timestamptz;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-lost-response@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_run_id := public.start_import_run(u, 'lost-response-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Lost Response Co", "invoice_number": "LR-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}}
  ]$j$::jsonb);

  result := public.process_import_batch(v_run_id);
  if result->>'status' <> 'in_progress' then
    raise exception 'Expected in_progress after first batch, got %', result->>'status';
  end if;

  select invoice_id, client_id, committed_at into invoice_id_before, client_id_before, committed_at_before
  from public.import_rows where run_id = v_run_id and row_number = 1;
  if invoice_id_before is null or client_id_before is null or committed_at_before is null then
    raise exception 'Row was not durably committed after the first batch call';
  end if;

  -- Simulate the browser losing the HTTP response for that call (it never
  -- saw the JSON above) and retrying by calling process_import_batch
  -- again for the same run, exactly as the real client would on a
  -- network failure.
  result := public.process_import_batch(v_run_id);
  if result->>'status' <> 'completed' then
    raise exception 'Expected completed on retry after a lost response, got %', result->>'status';
  end if;

  if (select count(*) from public.invoices where user_id = u) <> 1 then
    raise exception 'Lost-response retry duplicated the invoice';
  end if;
  if (select count(*) from public.clients where user_id = u) <> 1 then
    raise exception 'Lost-response retry duplicated the client';
  end if;
  if (
    select invoice_id <> invoice_id_before or client_id <> client_id_before
      or committed_at <> committed_at_before
    from public.import_rows where run_id = v_run_id and row_number = 1
  ) then
    raise exception 'Lost-response retry altered the already-committed row''s durable result';
  end if;
end
$lost_response$;
\echo 'TEST GROUP PASS: lost_response_retry'

\echo 'TEST GROUP START: cancellation_between_batches'
do $cancellation$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  result jsonb;
  committed_count integer;
  pending_count integer;
  run_status text;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-cancel@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_run_id := public.start_import_run(u, 'cancel-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Cancel Co A", "invoice_number": "CANCEL-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Cancel Co B", "invoice_number": "CANCEL-2",
       "invoice_date": "2026-01-01", "amount": "20.00"}},
    {"row_number": 3, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Cancel Co C", "invoice_number": "CANCEL-3",
       "invoice_date": "2026-01-01", "amount": "30.00"}},
    {"row_number": 4, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Cancel Co D", "invoice_number": "CANCEL-4",
       "invoice_date": "2026-01-01", "amount": "40.00"}}
  ]$j$::jsonb);

  -- Bound the batch to 2 rows so this 4-row run takes two calls, giving a
  -- real "between batches" boundary to cancel at.
  result := public.process_import_batch(v_run_id, 2);
  if result->>'status' <> 'in_progress' then
    raise exception 'Expected in_progress after first bounded batch, got %', result->>'status';
  end if;

  perform public.request_import_cancellation(v_run_id);

  -- Cancellation must be observed BETWEEN batches, never mid-batch: the
  -- next call must cancel outright, not claim and process rows 3-4.
  result := public.process_import_batch(v_run_id, 2);
  if result->>'status' <> 'cancelled' then
    raise exception 'Expected cancelled on the call after cancellation was requested, got %', result->>'status';
  end if;

  select count(*) into committed_count from public.import_rows
  where run_id = v_run_id and server_status = 'committed';
  if committed_count <> 2 then
    raise exception 'Expected the first committed batch (2 rows) to remain committed, got %', committed_count;
  end if;

  select count(*) into pending_count from public.import_rows
  where run_id = v_run_id and server_status = 'pending';
  if pending_count <> 2 then
    raise exception 'Expected the unprocessed rows to remain pending, got %', pending_count;
  end if;

  select status into run_status from public.import_runs where id = v_run_id;
  if run_status <> 'cancelled' then
    raise exception 'Expected run status cancelled, got %', run_status;
  end if;

  if (select count(*) from public.invoices where user_id = u) <> 2 then
    raise exception 'Cancellation must not touch already-committed invoices';
  end if;
end
$cancellation$;
\echo 'TEST GROUP PASS: cancellation_between_batches'

\echo 'TEST GROUP START: failed_batch_rollback'
do $failed_batch$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  result jsonb;
  batch_status text;
  v_failure_reason text;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-failed-batch@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- Row 2's amount is not a valid numeric literal. Eligibility only
  -- checks presence, not format (format is the importer's job before
  -- outcome=ready is even possible in real usage) - this deliberately
  -- exercises the server's own defense when that assumption is violated,
  -- forcing an exception inside the per-row loop that the row-level
  -- CLIENT_RESOLUTION_FAILED handler does NOT catch (it only wraps
  -- client resolution), so it must reach the outer batch-level handler.
  v_run_id := public.start_import_run(u, 'failed-batch-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Failed Batch Good Co", "invoice_number": "FAIL-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Failed Batch Bad Co", "invoice_number": "FAIL-2",
       "invoice_date": "2026-01-01", "amount": "not-a-number"}}
  ]$j$::jsonb);

  result := public.process_import_batch(v_run_id, 2);
  if result->>'status' <> 'batch_failed' then
    raise exception 'Expected batch_failed for a batch containing a malformed row, got %', result->>'status';
  end if;

  if exists(select 1 from public.clients where user_id = u) then
    raise exception 'A failed batch left a client behind (savepoint rollback did not undo it)';
  end if;
  if exists(select 1 from public.invoices where user_id = u) then
    raise exception 'A failed batch left an invoice behind';
  end if;
  if exists(
    select 1 from public.import_rows
    where run_id = v_run_id and server_status <> 'pending'
  ) then
    raise exception 'A failed batch left a row in a non-pending state';
  end if;
  if exists(
    select 1 from public.import_rows where run_id = v_run_id and batch_id is not null
  ) then
    raise exception 'A failed batch left rows still pointing at the failed batch_id';
  end if;

  select status, failure_reason into batch_status, v_failure_reason
  from public.import_batches where run_id = v_run_id;
  if batch_status <> 'failed' then
    raise exception 'Expected the batch record itself to be truthfully marked failed, got %', batch_status;
  end if;
  if v_failure_reason is null then
    raise exception 'A failed batch must record a failure_reason';
  end if;

  if not exists(
    select 1 from public.import_events
    where run_id = v_run_id and event_type = 'batch_failed'
  ) then
    raise exception 'No batch_failed audit event was recorded';
  end if;
  if exists(
    select 1 from public.import_events
    where run_id = v_run_id and event_type in ('client_created', 'client_matched', 'invoice_inserted', 'batch_committed')
  ) then
    raise exception 'A failed batch produced an event describing a fact that never committed';
  end if;
end
$failed_batch$;
\echo 'TEST GROUP PASS: failed_batch_rollback'

\echo 'TEST GROUP START: refresh_reconstruction'
do $refresh$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  reconstructed_total integer;
  reconstructed_committed integer;
  reconstructed_blocked integer;
  reconstructed_pending integer;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-refresh@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_run_id := public.start_import_run(u, 'refresh-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Refresh Co", "invoice_number": "REFRESH-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "review_required", "issue_codes": [],
     "normalized": {"client_name": "Refresh Co Blocked", "invoice_number": "REFRESH-2",
       "invoice_date": "2026-01-01", "amount": "20.00"}}
  ]$j$::jsonb);
  -- Two calls: the first commits row 1 (the only pending row) and
  -- returns in_progress; the second finds nothing left pending and
  -- settles the run into its terminal state.
  perform public.process_import_batch(v_run_id);
  perform public.process_import_batch(v_run_id);

  -- Everything a "resume after refresh" screen needs comes from a plain
  -- read of server state - no client-side memory of what happened.
  select total_rows into reconstructed_total from public.import_runs where id = v_run_id;
  select count(*) into reconstructed_committed from public.import_rows
    where run_id = v_run_id and server_status = 'committed';
  select count(*) into reconstructed_blocked from public.import_rows
    where run_id = v_run_id and server_status = 'blocked';
  select count(*) into reconstructed_pending from public.import_rows
    where run_id = v_run_id and server_status = 'pending';

  if reconstructed_total <> 2 or reconstructed_committed <> 1
    or reconstructed_blocked <> 1 or reconstructed_pending <> 0 then
    raise exception
      'Server-state reconstruction mismatch: total=% committed=% blocked=% pending=%',
      reconstructed_total, reconstructed_committed, reconstructed_blocked, reconstructed_pending;
  end if;
  -- One row committed, one blocked (never persisted) -> the run is fully
  -- processed but truthfully partial, not a clean "completed".
  if (select status from public.import_runs where id = v_run_id) <> 'partially_completed' then
    raise exception 'Expected a fully-processed run with a blocked row to read back as partially_completed, got %',
      (select status from public.import_runs where id = v_run_id);
  end if;
end
$refresh$;
\echo 'TEST GROUP PASS: refresh_reconstruction'

\echo 'TEST GROUP START: cross_tenant_rejection'
do $cross_tenant$
declare
  tenant_a constant uuid := 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  tenant_b constant uuid := 'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  v_run_id uuid;
begin
  insert into auth.users(id, email) values
    (tenant_a, 'ckpt1-tenant-a@example.test'),
    (tenant_b, 'ckpt1-tenant-b@example.test');

  perform set_config('request.jwt.claim.sub', tenant_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v_run_id := public.start_import_run(tenant_a, 'cross-tenant-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Tenant A Co", "invoice_number": "TENANT-A-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}}
  ]$j$::jsonb);

  -- Authenticated path: tenant B's own session must never touch tenant A's run.
  perform set_config('request.jwt.claim.sub', tenant_b::text, true);
  begin
    perform public.start_import_run(tenant_b, 'cross-tenant-key-b', $j$[]$j$::jsonb);
    -- allowed for tenant B's own key; not itself a cross-tenant attempt.
  exception when others then
    null; -- empty-array total_rows=0 is fine either way for this probe
  end;
  begin
    perform public.process_import_batch(v_run_id);
    raise exception 'Expected cross-tenant process_import_batch rejection';
  exception when others then
    if sqlerrm not like '%another user%' then raise; end if;
  end;
  begin
    perform public.request_import_cancellation(v_run_id);
    raise exception 'Expected cross-tenant request_import_cancellation rejection';
  exception when others then
    if sqlerrm not like '%another user%' then raise; end if;
  end;
  begin
    perform public.start_import_run(tenant_a, 'cross-tenant-key-2', $j$[]$j$::jsonb);
    raise exception 'Expected cross-tenant start_import_run rejection (acting as tenant B, targeting tenant A)';
  exception when others then
    if sqlerrm not like '%another user%' then raise; end if;
  end;

  -- Owner/service-style path: no simulated identity at all (auth.uid()
  -- null) must be rejected too, exactly like an unrelated tenant - a
  -- service-role connection with no JWT context is not an implicit
  -- owner of anything.
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.process_import_batch(v_run_id);
    raise exception 'Expected rejection with no simulated identity (auth.uid() null)';
  exception when others then
    if sqlerrm not like '%another user%' then raise; end if;
  end;
  begin
    perform public.request_import_cancellation(v_run_id);
    raise exception 'Expected rejection with no simulated identity (auth.uid() null)';
  exception when others then
    if sqlerrm not like '%another user%' then raise; end if;
  end;
end
$cross_tenant$;
\echo 'TEST GROUP PASS: cross_tenant_rejection'

rollback;
