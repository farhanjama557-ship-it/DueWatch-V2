-- Disposable Supabase/PostgreSQL integration test for Phase 1.5B
-- Checkpoint 1 (import persistence core). Apply schema.sql, then
-- 20260726000000_canonical_clients.sql, then
-- 20260803021842_enforce_invoice_client_tenant_ownership.sql, then
-- 20260803150000_import_persistence_core.sql before running this file.
-- Everything here runs inside one transaction that always rolls back.
--
-- This file exists to produce the "minimum recovery proof" required
-- before Checkpoint 1 can be reported verified, PLUS the independent-
-- review corrections layered on top:
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
--   Review Blocker 1: row-vs-batch exception classification
--   Review Blocker 3/4: server-authoritative eligibility, strong identity
--   Review Blocker 5: matched-vs-created truth on a source-identity retry
--   Review Blocker 6/7: invoice-source-identity, conflicts, material
--      field preservation
--   Review Blocker 9: progress counts include runtime-blocked rows
--   Review Blocker 10: tenant-safe FKs across the import graph
-- Proof 6 (two concurrent workers cannot claim the same row/batch) and
-- Review Blocker 8 (atomic run idempotency under real concurrency) are
-- NOT in this file: both require two genuinely concurrent connections,
-- which a single transactional script cannot exercise. See
-- import_persistence_concurrency_proof.sh and
-- import_persistence_run_idempotency_concurrency_proof.sh for those
-- proofs; both commit and then delete their own fixtures, since neither
-- can run inside one transaction shared across two sessions.
begin;

\echo 'TEST GROUP START: eligibility_deny_by_default'
do $eligibility$
declare
  r record;
  base_row constant jsonb := '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00","client_email":"x@example.test"}'::jsonb;
begin
  select * into r from duewatch_ops.evaluate_row_eligibility('somehow_fine', array[]::text[], base_row, false);
  if r.eligible or r.reason_code <> 'UNKNOWN_OUTCOME' then
    raise exception 'Unknown outcome was not blocked as UNKNOWN_OUTCOME, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility('ready_with_warnings', array['SOME_FUTURE_CODE_NOT_YET_TAUGHT'], base_row, true);
  if r.eligible or r.reason_code <> 'UNKNOWN_ISSUE_CODE' then
    raise exception 'Unknown issue code was not blocked as UNKNOWN_ISSUE_CODE, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility('ready', array['DUPLICATE_IN_UPLOAD'], base_row, false);
  if r.eligible or r.reason_code <> 'OUTCOME_ISSUE_MISMATCH' then
    raise exception 'A ready row carrying any issue code should be OUTCOME_ISSUE_MISMATCH, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility('ready_with_warnings', array['DUPLICATE_IN_UPLOAD'], base_row, true);
  if r.eligible or r.reason_code <> 'BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME' then
    raise exception 'A real blocking code on ready_with_warnings was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility('ready_with_warnings', array['ROW_COLUMN_COUNT_MISMATCH'], base_row, false);
  if r.eligible or r.reason_code <> 'WARNINGS_NOT_ACKNOWLEDGED' then
    raise exception 'An approved warning code without acknowledgement should block, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility('ready_with_warnings', array['ROW_COLUMN_COUNT_MISMATCH'], base_row, true);
  if not r.eligible then
    raise exception 'An approved, acknowledged warning code was blocked, expected eligible';
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"status":"void"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'UNSUPPORTED_STATUS_VALUE' then
    raise exception 'status=void was not blocked explicitly, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"status":"cancelled"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'UNKNOWN_STATUS_VALUE' then
    raise exception 'An unknown status value was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], '{"invoice_number":"X","invoice_date":"2026-01-01","client_email":"x@example.test"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'MISSING_MATERIAL_FIELD' then
    raise exception 'A missing material field (amount) was not blocked';
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"invoice_date":"2026-13-40"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'INVALID_DATE_VALUE' then
    raise exception 'An invalid invoice_date was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"amount":"not-a-number"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'INVALID_AMOUNT_VALUE' then
    raise exception 'An invalid amount was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"amount":"0.00"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'NON_POSITIVE_AMOUNT' then
    raise exception 'A zero amount was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"currency":"XYZ"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'UNSUPPORTED_CURRENCY' then
    raise exception 'An unsupported currency was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"amount_paid":"5.00"}'::jsonb || jsonb_build_object('amount', '1.00'), false
  );
  if r.eligible or r.reason_code <> 'AMOUNT_PAID_OUT_OF_RANGE' then
    raise exception 'amount_paid exceeding amount was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[], base_row || '{"status":"paid","amount_paid":"0.50"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'PAID_STATUS_AMOUNT_MISMATCH' then
    raise exception 'paid status with a partial amount_paid was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[],
    '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00","client_name":"Name Only"}'::jsonb, false
  );
  if r.eligible or r.reason_code <> 'WEAK_CLIENT_IDENTITY' then
    raise exception 'Name-only identity was not blocked, got eligible=% reason=%', r.eligible, r.reason_code;
  end if;

  select * into r from duewatch_ops.evaluate_row_eligibility(
    'ready', array[]::text[],
    '{"invoice_number":"X","invoice_date":"2026-01-01","amount":"1.00","source_system":"stripe","source_client_id":"cus_1"}'::jsonb,
    false
  );
  if not r.eligible then
    raise exception 'Strong source identity without an email was blocked, expected eligible';
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
    "normalized": {"client_name": "Idem Co", "client_email": "idem@example.test", "invoice_number": "IDEM-1",
      "invoice_date": "2026-01-01", "amount": "10.00"}}]$j$::jsonb;
  conflicting_payload := $j$[{"row_number": 1, "outcome": "ready", "issue_codes": [],
    "normalized": {"client_name": "Idem Co", "client_email": "idem@example.test", "invoice_number": "IDEM-1",
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

  -- Bounds (Review Blocker 2): non-array p_rows, over-limit rows, and
  -- invalid/duplicate row_number values all fail closed.
  begin
    perform public.start_import_run(u, 'bounds-key-1', '{}'::jsonb);
    raise exception 'Expected rejection of a non-array p_rows';
  exception when others then
    if sqlerrm not like '%must be a JSON array%' then raise; end if;
  end;
  begin
    perform public.start_import_run(u, 'bounds-key-2', $j$[
      {"row_number": 0, "outcome": "ready", "issue_codes": [],
       "normalized": {"client_email": "x@example.test", "invoice_number": "X", "invoice_date": "2026-01-01", "amount": "1.00"}}
    ]$j$::jsonb);
    raise exception 'Expected rejection of a non-positive row_number';
  exception when others then
    if sqlerrm not like '%positive integer row_number%' then raise; end if;
  end;
  begin
    perform public.start_import_run(u, 'bounds-key-3', $j$[
      {"row_number": 1, "outcome": "ready", "issue_codes": [],
       "normalized": {"client_email": "x@example.test", "invoice_number": "X", "invoice_date": "2026-01-01", "amount": "1.00"}},
      {"row_number": 1, "outcome": "ready", "issue_codes": [],
       "normalized": {"client_email": "y@example.test", "invoice_number": "Y", "invoice_date": "2026-01-01", "amount": "1.00"}}
    ]$j$::jsonb);
    raise exception 'Expected rejection of duplicate row_number values';
  exception when others then
    if sqlerrm not like '%row_number values must be unique%' then raise; end if;
  end;
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
     "normalized": {"client_name": "Lost Response Co", "client_email": "lr@example.test", "invoice_number": "LR-1",
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
     "normalized": {"client_name": "Cancel Co A", "client_email": "cancel-a@example.test", "invoice_number": "CANCEL-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Cancel Co B", "client_email": "cancel-b@example.test", "invoice_number": "CANCEL-2",
       "invoice_date": "2026-01-01", "amount": "20.00"}},
    {"row_number": 3, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Cancel Co C", "client_email": "cancel-c@example.test", "invoice_number": "CANCEL-3",
       "invoice_date": "2026-01-01", "amount": "30.00"}},
    {"row_number": 4, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Cancel Co D", "client_email": "cancel-d@example.test", "invoice_number": "CANCEL-4",
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
  v_internal_diagnostic text;
  v_corrupted_row_id uuid;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-failed-batch@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_run_id := public.start_import_run(u, 'failed-batch-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Failed Batch Good Co", "client_email": "fb-good@example.test", "invoice_number": "FAIL-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Failed Batch Bad Co", "client_email": "fb-bad@example.test", "invoice_number": "FAIL-2",
       "invoice_date": "2026-01-01", "amount": "20.00"}}
  ]$j$::jsonb);

  -- Server-authoritative eligibility (Review Blocker 3) now validates
  -- amount format/positivity itself, so a malformed amount can no longer
  -- reach process_import_batch at all — it's blocked upstream, which is
  -- the correct, stronger behavior, but means this test needs a different
  -- way to force a genuinely UNEXPECTED (not a named business outcome)
  -- error deep in persistence. Simulating "something else corrupted
  -- already-validated pending row data after eligibility ran" — a
  -- legitimate scenario since import_rows.material_payload is a durable
  -- server-side ARTIFACT, not something process_import_batch re-validates
  -- on every call — by directly stripping the amount from row 2's stored
  -- material_payload. invoices.amount is NOT NULL, so this forces a real
  -- not_null_violation Postgres error when process_import_batch tries to
  -- insert, hitting no named business-outcome branch in the row-level
  -- handler and correctly propagating to the outer batch-level rollback.
  update public.import_rows
  set material_payload = material_payload - 'amount'
  where run_id = v_run_id and row_number = 2
  returning id into v_corrupted_row_id;

  result := public.process_import_batch(v_run_id, 2);
  if result->>'status' <> 'batch_failed' then
    raise exception 'Expected batch_failed for a batch containing a corrupted row, got %', result->>'status';
  end if;
  if result->>'reason' like '%not-null%' or result->>'reason' like '%null value%' then
    raise exception 'Raw SQLERRM leaked to the caller instead of a sanitized reason: %', result->>'reason';
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
    raise exception 'A failed batch left a row in a non-pending state (this must include row 1, the otherwise-good row)';
  end if;
  if exists(
    select 1 from public.import_rows where run_id = v_run_id and batch_id is not null
  ) then
    raise exception 'A failed batch left rows still pointing at the failed batch_id';
  end if;

  select status, failure_reason, internal_diagnostic into batch_status, v_failure_reason, v_internal_diagnostic
  from public.import_batches where run_id = v_run_id;
  if batch_status <> 'failed' then
    raise exception 'Expected the batch record itself to be truthfully marked failed, got %', batch_status;
  end if;
  if v_failure_reason is null or v_failure_reason like '%not-null%' or v_failure_reason like '%null value%' then
    raise exception 'failure_reason must be a sanitized message, not raw SQLERRM: %', v_failure_reason;
  end if;
  -- internal_diagnostic (operator-only) is allowed to hold the real detail.
  if v_internal_diagnostic is null then
    raise exception 'internal_diagnostic must retain the real error for operator/service_role visibility';
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
  if exists(
    select 1 from public.import_events
    where run_id = v_run_id and (detail->>'message' like '%not-null%' or detail->>'message' like '%null value%')
  ) then
    raise exception 'Raw SQLERRM leaked into an authenticated-visible import_events row';
  end if;

  -- authenticated must never be able to read internal_diagnostic at all —
  -- column-level grant proof, not just "the API happens not to return it."
  if has_column_privilege('authenticated', 'public.import_batches', 'internal_diagnostic', 'SELECT') then
    raise exception 'authenticated must not have SELECT on import_batches.internal_diagnostic';
  end if;
end
$failed_batch$;
\echo 'TEST GROUP PASS: failed_batch_rollback'

\echo 'TEST GROUP START: row_vs_batch_exception_classification'
do $row_vs_batch$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  result jsonb;
  row1_status text;
  row1_reason text;
  row2_status text;
  batch_status text;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-row-vs-batch@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- Pre-seed two existing clients that are genuinely ambiguous matches for
  -- the same email+company pairing a new row will submit — a real,
  -- expected, data-dependent outcome of resolve_or_create_client's own
  -- ambiguity check (v_count > 1), reachable even with a strong (email)
  -- identity present.
  insert into public.clients(user_id, name, email, company)
  values (u, 'Ambiguous Existing One', 'ambiguous@example.test', 'Shared Corp');
  insert into public.clients(user_id, name, email, company)
  values (u, 'Ambiguous Existing Two', 'ambiguous@example.test', 'Shared Corp');

  v_run_id := public.start_import_run(u, 'row-vs-batch-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "New Attempt", "client_company": "Shared Corp", "client_email": "ambiguous@example.test",
       "invoice_number": "AMBIG-1", "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Clean Co", "client_email": "clean@example.test",
       "invoice_number": "CLEAN-1", "invoice_date": "2026-01-01", "amount": "20.00"}}
  ]$j$::jsonb);

  result := public.process_import_batch(v_run_id, 2);
  if result->>'status' <> 'in_progress' then
    raise exception 'Expected a known business outcome to block one row without failing the batch, got %', result->>'status';
  end if;

  select server_status, block_reason_code into row1_status, row1_reason
  from public.import_rows where run_id = v_run_id and row_number = 1;
  if row1_status <> 'blocked' or row1_reason <> 'AMBIGUOUS_CLIENT_IDENTITY' then
    raise exception 'Expected row 1 blocked as AMBIGUOUS_CLIENT_IDENTITY, got status=% reason=%', row1_status, row1_reason;
  end if;

  select server_status into row2_status from public.import_rows where run_id = v_run_id and row_number = 2;
  if row2_status <> 'committed' then
    raise exception 'Expected the neighboring valid row to still commit, got %', row2_status;
  end if;

  select status into batch_status from public.import_batches where run_id = v_run_id;
  if batch_status <> 'committed' then
    raise exception 'Expected the batch itself to succeed (one blocked row is not a batch failure), got %', batch_status;
  end if;

  if (select count(*) from public.invoices where user_id = u) <> 1 then
    raise exception 'Expected exactly 1 invoice (only the clean row), got %',
      (select count(*) from public.invoices where user_id = u);
  end if;
end
$row_vs_batch$;
\echo 'TEST GROUP PASS: row_vs_batch_exception_classification'

\echo 'TEST GROUP START: weak_identity_never_auto_persists'
do $weak_identity$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  row_status text;
  row_reason text;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-weak-identity@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_run_id := public.start_import_run(u, 'weak-identity-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Name Only Co", "invoice_number": "WEAK-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_company": "Company Only Co", "invoice_number": "WEAK-2",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 3, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Phone Co", "client_phone": "555-1234", "invoice_number": "WEAK-3",
       "invoice_date": "2026-01-01", "amount": "10.00"}}
  ]$j$::jsonb);

  for row_status, row_reason in
    select server_status, block_reason_code from public.import_rows where run_id = v_run_id order by row_number
  loop
    if row_status <> 'blocked' or row_reason <> 'WEAK_CLIENT_IDENTITY' then
      raise exception 'Expected every weak-identity row blocked as WEAK_CLIENT_IDENTITY, got status=% reason=%', row_status, row_reason;
    end if;
  end loop;

  -- None of these should ever reach process_import_batch's persistence at
  -- all — confirm no clients/invoices exist even after attempting to run it.
  perform public.process_import_batch(v_run_id);
  if exists(select 1 from public.clients where user_id = u) then
    raise exception 'Weak-identity rows must never auto-create a client';
  end if;
end
$weak_identity$;
\echo 'TEST GROUP PASS: weak_identity_never_auto_persists'

\echo 'TEST GROUP START: matched_vs_created_on_source_identity_retry'
do $source_identity_truth$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  v_client_result text;
  the_client_id uuid;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-source-identity@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- First import: creates a client via source identity.
  v_run_id := public.start_import_run(u, 'source-identity-key-1', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Original Name", "client_email": "original@example.test",
       "source_system": "stripe", "source_client_id": "cus_regression",
       "invoice_number": "SRC-1", "invoice_date": "2026-01-01", "amount": "10.00"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);

  select client_id into the_client_id from public.import_rows where run_id = v_run_id and row_number = 1;
  if the_client_id is null then
    raise exception 'First import did not resolve a client';
  end if;
  if not exists(
    select 1 from public.client_source_identities
    where user_id = u and source = 'stripe' and external_id = 'cus_regression' and client_id = the_client_id
  ) then
    raise exception 'Expected a client_source_identities row for the first import';
  end if;

  -- Second import: SAME source/external ID, but a DIFFERENT name/email —
  -- the exact regression scenario an independent review specified. The
  -- resolver's own source-identity fast path returns the SAME existing
  -- client_id regardless of the new name/email; this must be reported as
  -- matched, never created.
  v_run_id := public.start_import_run(u, 'source-identity-key-2', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Totally Different Name", "client_email": "different@example.test",
       "source_system": "STRIPE", "source_client_id": "cus_regression",
       "invoice_number": "SRC-2", "invoice_date": "2026-01-02", "amount": "20.00"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);

  select client_id, client_result into the_client_id, v_client_result
  from public.import_rows where run_id = v_run_id and row_number = 1;
  if v_client_result <> 'matched' then
    raise exception 'Expected matched (not created) on a source-identity retry with a different name/email, got %', v_client_result;
  end if;
  if (select count(*) from public.clients where user_id = u) <> 1 then
    raise exception 'Source-identity retry with a different name/email created a second client';
  end if;
end
$source_identity_truth$;
\echo 'TEST GROUP PASS: matched_vs_created_on_source_identity_retry'

\echo 'TEST GROUP START: invoice_source_identity_and_conflicts'
do $invoice_identity$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  invoice_count integer;
  row_status text;
  row_reason text;
  the_invoice public.invoices%rowtype;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-invoice-identity@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- Exact retry: same source_system/source_invoice_id, same material
  -- facts -> already_existed, idempotent, no duplicate.
  v_run_id := public.start_import_run(u, 'invoice-identity-key-1', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Invoice Identity Co", "client_email": "ii@example.test",
       "source_system": " Stripe ", "source_invoice_id": " inv_ABC ",
       "invoice_number": "II-1", "invoice_date": "2026-01-01", "amount": "100.00", "currency": "USD"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);

  v_run_id := public.start_import_run(u, 'invoice-identity-key-2', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Invoice Identity Co", "client_email": "ii@example.test",
       "source_system": "STRIPE", "source_invoice_id": " inv_ABC ",
       "invoice_number": "II-1", "invoice_date": "2026-01-01", "amount": "100.00", "currency": "USD"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);

  select count(*) into invoice_count from public.invoices where user_id = u;
  if invoice_count <> 1 then
    raise exception 'Exact source-ID retry (case-insensitive source_system) should not duplicate, got % invoices', invoice_count;
  end if;
  select server_status into row_status from public.import_rows where run_id = v_run_id and row_number = 1;
  if row_status <> 'committed' then
    raise exception 'Expected the exact retry row to commit as already_existed, got %', row_status;
  end if;

  -- Source-invoice-ID is case-SENSITIVE (only outer-trimmed): "inv_ABC"
  -- and "inv_abc" are different identities entirely, so this is a brand
  -- new invoice, not a conflict.
  v_run_id := public.start_import_run(u, 'invoice-identity-key-3', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Invoice Identity Co", "client_email": "ii@example.test",
       "source_system": "stripe", "source_invoice_id": "inv_abc",
       "invoice_number": "II-1", "invoice_date": "2026-01-01", "amount": "100.00", "currency": "USD"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);
  select count(*) into invoice_count from public.invoices where user_id = u;
  if invoice_count <> 2 then
    raise exception 'Case-different source_invoice_id should be a distinct identity, got % invoices', invoice_count;
  end if;

  -- Same identity, different amount -> conflict, not committed/overwritten.
  v_run_id := public.start_import_run(u, 'invoice-identity-key-4', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Invoice Identity Co", "client_email": "ii@example.test",
       "source_system": "stripe", "source_invoice_id": " inv_ABC ",
       "invoice_number": "II-1", "invoice_date": "2026-01-01", "amount": "999.00", "currency": "USD"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);
  select server_status, block_reason_code into row_status, row_reason
  from public.import_rows where run_id = v_run_id and row_number = 1;
  if row_status <> 'blocked' or row_reason <> 'INVOICE_MATERIAL_CONFLICT' then
    raise exception 'Same identity + different amount should conflict, got status=% reason=%', row_status, row_reason;
  end if;
  select amount into the_invoice.amount from public.invoices
  where user_id = u and source_system = 'stripe' and source_invoice_id = 'inv_ABC';
  if the_invoice.amount <> 100.00 then
    raise exception 'A conflicting retry must never overwrite the existing invoice, got amount=%', the_invoice.amount;
  end if;

  -- Same identity, different invoice_date -> also a conflict.
  v_run_id := public.start_import_run(u, 'invoice-identity-key-5', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Invoice Identity Co", "client_email": "ii@example.test",
       "source_system": "stripe", "source_invoice_id": " inv_ABC ",
       "invoice_number": "II-1", "invoice_date": "2026-02-02", "amount": "100.00", "currency": "USD"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);
  select server_status, block_reason_code into row_status, row_reason
  from public.import_rows where run_id = v_run_id and row_number = 1;
  if row_status <> 'blocked' or row_reason <> 'INVOICE_MATERIAL_CONFLICT' then
    raise exception 'Same identity + different invoice_date should conflict, got status=% reason=%', row_status, row_reason;
  end if;

  -- Same invoice_number under a DIFFERENT source_invoice_id is a distinct
  -- invoice, not a collision — invoice number alone is never sufficient.
  v_run_id := public.start_import_run(u, 'invoice-identity-key-6', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Invoice Identity Co", "client_email": "ii@example.test",
       "source_system": "stripe", "source_invoice_id": "inv_XYZ",
       "invoice_number": "II-1", "invoice_date": "2026-01-01", "amount": "100.00", "currency": "USD"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);
  select count(*) into invoice_count from public.invoices where user_id = u;
  if invoice_count <> 3 then
    raise exception 'Same invoice_number under a distinct source_invoice_id should be its own invoice, got % invoices', invoice_count;
  end if;
end
$invoice_identity$;
\echo 'TEST GROUP PASS: invoice_source_identity_and_conflicts'

\echo 'TEST GROUP START: material_field_preservation'
do $material_fields$
declare
  u uuid := gen_random_uuid();
  v_run_id uuid;
  the_invoice public.invoices%rowtype;
begin
  insert into auth.users(id, email) values(u, 'ckpt1-material-fields@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_run_id := public.start_import_run(u, 'material-fields-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "Material Co", "client_email": "material@example.test",
       "source_system": "quickbooks", "source_invoice_id": "qb-001",
       "invoice_number": "MAT-1", "invoice_date": "2026-01-01", "amount": "150.00",
       "currency": "EUR", "status": "paid", "payment_date": "2026-01-05"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);

  select * into the_invoice from public.invoices where user_id = u and inv_num = 'MAT-1';
  if the_invoice.currency <> 'EUR' then
    raise exception 'currency was silently dropped, got %', the_invoice.currency;
  end if;
  if the_invoice.payment_date <> '2026-01-05'::date then
    raise exception 'payment_date was silently dropped, got %', the_invoice.payment_date;
  end if;
  if the_invoice.source_system <> 'quickbooks' then
    raise exception 'source_system was silently dropped, got %', the_invoice.source_system;
  end if;
  if the_invoice.source_invoice_id <> 'qb-001' then
    raise exception 'source_invoice_id was silently dropped, got %', the_invoice.source_invoice_id;
  end if;

  -- Blank currency must stay null, never silently default to USD.
  v_run_id := public.start_import_run(u, 'material-fields-key-2', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "No Currency Co", "client_email": "nocurrency@example.test",
       "invoice_number": "MAT-2", "invoice_date": "2026-01-01", "amount": "50.00"}}
  ]$j$::jsonb);
  perform public.process_import_batch(v_run_id);
  select * into the_invoice from public.invoices where user_id = u and inv_num = 'MAT-2';
  if the_invoice.currency is not null then
    raise exception 'A blank currency must stay null, was silently defaulted to %', the_invoice.currency;
  end if;
end
$material_fields$;
\echo 'TEST GROUP PASS: material_field_preservation'

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
     "normalized": {"client_name": "Refresh Co", "client_email": "refresh@example.test", "invoice_number": "REFRESH-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}},
    {"row_number": 2, "outcome": "review_required", "issue_codes": [],
     "normalized": {"client_name": "Refresh Co Blocked", "client_email": "refresh-blocked@example.test", "invoice_number": "REFRESH-2",
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
     "normalized": {"client_name": "Tenant A Co", "client_email": "tenant-a@example.test", "invoice_number": "TENANT-A-1",
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

\echo 'TEST GROUP START: tenant_safe_fk_constraints'
do $tenant_fk_constraints$
declare
  tenant_a constant uuid := 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  tenant_b constant uuid := 'ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  run_a uuid;
begin
  insert into auth.users(id, email) values
    (tenant_a, 'ckpt1-fk-tenant-a@example.test'),
    (tenant_b, 'ckpt1-fk-tenant-b@example.test');

  perform set_config('request.jwt.claim.sub', tenant_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  run_a := public.start_import_run(tenant_a, 'fk-tenant-key', $j$[
    {"row_number": 1, "outcome": "ready", "issue_codes": [],
     "normalized": {"client_name": "FK Tenant A Co", "client_email": "fk-a@example.test", "invoice_number": "FK-A-1",
       "invoice_date": "2026-01-01", "amount": "10.00"}}
  ]$j$::jsonb);

  -- Even a fully-privileged, service_role-style direct write (bypassing
  -- every SECURITY DEFINER function) must be structurally impossible to
  -- misattribute across tenants — this is a database-level guarantee, not
  -- an application-logic one, exactly per Review Blocker 10.
  begin
    insert into public.import_batches(id, run_id, user_id, batch_index, status, row_count)
    values (gen_random_uuid(), run_a, tenant_b, 0, 'in_progress', 0);
    raise exception 'Expected FK rejection: import_batches.user_id=tenant_b referencing tenant_a''s run';
  exception when foreign_key_violation then
    null;
  end;

  begin
    insert into public.import_rows(
      run_id, user_id, row_number, row_idempotency_key, material_payload, material_payload_hash, server_status
    ) values (
      run_a, tenant_b, 99, 'forged-key', '{}'::jsonb, 'deadbeef', 'pending'
    );
    raise exception 'Expected FK rejection: import_rows.user_id=tenant_b referencing tenant_a''s run';
  exception when foreign_key_violation then
    null;
  end;

  begin
    insert into public.import_events(run_id, user_id, event_type)
    values (run_a, tenant_b, 'run_created');
    raise exception 'Expected FK rejection: import_events.user_id=tenant_b referencing tenant_a''s run';
  exception when foreign_key_violation then
    null;
  end;
end
$tenant_fk_constraints$;
\echo 'TEST GROUP PASS: tenant_safe_fk_constraints'

rollback;
