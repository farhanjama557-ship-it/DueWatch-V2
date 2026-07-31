-- Disposable Supabase/PostgreSQL integration test.
-- Apply schema.sql and the Phase 0 migration first. This transaction always
-- rolls back, including the temporary execution-enable switch.
begin;

do $test$
declare
  u uuid := gen_random_uuid();
  canonical_client uuid;
  duplicate_client uuid;
  ambiguous_email_client uuid;
  phone_client_a uuid;
  phone_client_b uuid;
  resolved_a uuid;
  resolved_b uuid;
  inv uuid;
  line uuid;
  rem uuid;
  evt uuid;
  approval uuid;
  v_run_id uuid;
  v_second_run_id uuid;
  exact_count integer;
  review_count integer;
begin
  insert into auth.users(id, email)
  values(u, 'phase0-test@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  insert into public.clients(user_id, name, email, company)
  values(u, 'Northbend Studio', 'billing@example.test', 'Northbend Studio')
  returning id into canonical_client;
  insert into public.clients(user_id, name, email, company)
  values(u, ' northbend-studio ', 'BILLING@example.test', 'Northbend Studio')
  returning id into duplicate_client;
  insert into public.clients(user_id, name, email)
  values(u, 'Different Company', 'billing@example.test')
  returning id into ambiguous_email_client;
  insert into public.clients(user_id, name, company, phone)
  values(u, 'Reception', 'Shared Office', '+1 212 555 0100')
  returning id into phone_client_a;
  insert into public.clients(user_id, name, company, phone)
  values(u, 'Accounts', 'Shared Office', '1 (212) 555-0100')
  returning id into phone_client_b;

  insert into public.invoices(user_id, client_id, inv_num, amount)
  values(u, duplicate_client, 'PHASE0-1', 100) returning id into inv;
  insert into public.line_items(user_id, invoice_id, description)
  values(u, inv, 'Preserved work') returning id into line;
  insert into public.reminders(user_id, invoice_id, title, detail)
  values(u, inv, 'Reminder sent', 'Preserved reminder') returning id into rem;
  insert into public.events(user_id, invoice_id, event_type, evidence)
  values(u, inv, 'reminder_sent', '{"provider":"test","message_id":"msg_1"}')
  returning id into evt;
  insert into public.awaiting_signature(
    user_id, invoice_id, recommended_tone, draft_content, ai_reason
  ) values(u, inv, 'warm', 'Test draft', 'Test reason')
  returning id into approval;

  -- Current invoice path: repeated name-only resolution returns one client.
  resolved_a := public.resolve_or_create_client(u, 'New Client');
  resolved_b := public.resolve_or_create_client(u, ' new-client ');
  if resolved_a <> resolved_b then
    raise exception 'resolve_or_create_client created a repeat duplicate';
  end if;

  v_run_id := duewatch_ops.prepare_client_dedup(u);
  select count(*) into exact_count from public.client_merge_candidates
  where run_id = v_run_id and classification = 'exact';
  select count(*) into review_count from public.client_merge_candidates
  where run_id = v_run_id and classification = 'review_required';
  if exact_count < 1 then raise exception 'Expected an exact email+name match'; end if;
  if review_count < 2 then
    raise exception 'Expected email-only and phone review candidates';
  end if;
  if exists(
    select 1 from public.client_merge_candidates
    where run_id = v_run_id
      and rule_code = 'phone_with_name_or_company'
      and classification <> 'review_required'
  ) then
    raise exception 'Phone match was incorrectly eligible for exact execution';
  end if;

  -- Gate 1: execution switch defaults off.
  begin
    perform duewatch_ops.execute_client_dedup(
      v_run_id, 'EXECUTE ' || v_run_id::text
    );
    raise exception 'Expected disabled-execution failure';
  exception when others then
    if sqlerrm not like '%execution is disabled%' then raise; end if;
  end;

  -- Enable only inside this transaction. Production migration stays disabled.
  update duewatch_ops.client_dedup_config
  set execution_enabled = true, change_note = 'transactional integration test'
  where singleton;

  -- Gate 2: staging FK attestation is mandatory.
  begin
    perform duewatch_ops.execute_client_dedup(
      v_run_id, 'EXECUTE ' || v_run_id::text
    );
    raise exception 'Expected missing-FK-verification failure';
  exception when others then
    if sqlerrm not like '%foreign-key verification has not passed%' then raise; end if;
  end;

  if exists(select 1 from duewatch_ops.unknown_client_foreign_keys()) then
    raise exception 'Fixture schema contains an unknown client/invoice FK';
  end if;
  perform duewatch_ops.attest_client_dedup_gate(
    v_run_id,
    'foreign_keys',
    '{"environment":"staging","unknown_foreign_keys":[],"missing_foreign_keys":[]}'::jsonb,
    'VERIFY FOREIGN KEYS ' || v_run_id::text
  );

  -- Gate 3: integration-test attestation is mandatory.
  begin
    perform duewatch_ops.execute_client_dedup(
      v_run_id, 'EXECUTE ' || v_run_id::text
    );
    raise exception 'Expected missing-integration-test failure';
  exception when others then
    if sqlerrm not like '%Integration tests have not passed%' then raise; end if;
  end;
  perform duewatch_ops.attest_client_dedup_gate(
    v_run_id,
    'integration_tests',
    '{"passed":true,"transaction_rolled_back":true,"suite":"canonical_clients_test.sql"}'::jsonb,
    'VERIFY INTEGRATION TESTS ' || v_run_id::text
  );

  -- Gate 4: the exact run-specific phrase is mandatory.
  begin
    perform duewatch_ops.execute_client_dedup(v_run_id, 'EXECUTE wrong-run');
    raise exception 'Expected exact-confirmation failure';
  exception when others then
    if sqlerrm not like '%Confirmation must be exactly%' then raise; end if;
  end;

  perform duewatch_ops.execute_client_dedup(
    v_run_id, 'EXECUTE ' || v_run_id::text
  );

  if not exists(
    select 1 from public.invoices
    where id = inv and client_id = canonical_client
  ) then
    raise exception 'Invoice UUID/client relationship was not preserved';
  end if;
  if not exists(
    select 1 from public.line_items
    where id = line and invoice_id = inv and description = 'Preserved work'
  ) then
    raise exception 'Line item relationship was not preserved';
  end if;
  if not exists(
    select 1 from public.reminders
    where id = rem and invoice_id = inv
      and title = 'Reminder sent' and detail = 'Preserved reminder'
  ) then
    raise exception 'Reminder relationship/content was not preserved';
  end if;
  if not exists(
    select 1 from public.events
    where id = evt and invoice_id = inv
      and evidence = '{"provider":"test","message_id":"msg_1"}'::jsonb
  ) then
    raise exception 'Activity/evidence was not preserved';
  end if;
  if not exists(
    select 1 from public.awaiting_signature
    where id = approval and invoice_id = inv
      and draft_content = 'Test draft' and ai_reason = 'Test reason'
  ) then
    raise exception 'Approval relationship/content was not preserved';
  end if;

  v_second_run_id := duewatch_ops.prepare_client_dedup(u);
  if exists(
    select 1 from public.client_merge_candidates
    where run_id = v_second_run_id and classification = 'exact'
  ) then
    raise exception 'Repeated preparation found an already-executed exact match';
  end if;

  perform duewatch_ops.rollback_client_dedup(
    v_run_id, 'ROLLBACK ' || v_run_id::text
  );
  if not exists(select 1 from public.clients where id = duplicate_client)
    or not exists(
      select 1 from public.invoices
      where id = inv and client_id = duplicate_client
    ) then
    raise exception 'Rollback did not restore the client and invoice pointer';
  end if;
  if not exists(
    select 1 from public.client_source_identities
    where source = 'duewatch'
      and external_id = duplicate_client::text
      and client_id = duplicate_client
  ) then
    raise exception 'Rollback did not restore source provenance';
  end if;
  if not exists(select 1 from public.reminders where id = rem and invoice_id = inv)
    or not exists(select 1 from public.awaiting_signature
      where id = approval and invoice_id = inv)
    or not exists(select 1 from public.events
      where id = evt and invoice_id = inv
        and evidence = '{"provider":"test","message_id":"msg_1"}'::jsonb) then
    raise exception 'Rollback changed preserved history/evidence';
  end if;
end
$test$;

rollback;
