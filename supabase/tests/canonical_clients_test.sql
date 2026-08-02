-- Disposable Supabase/PostgreSQL integration test.
-- Apply schema.sql and the Phase 0 migration first. This transaction always
-- rolls back, including the temporary execution-enable switch.
begin;

\echo 'TEST GROUP START: integration_relationships'
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
  v_candidate_id uuid;
  v_primary_client_id uuid;
  v_duplicate_client_id uuid;
  v_classification text;
  v_candidate_status text;
  v_affected_invoice_count integer;
  v_intended_candidate_count integer;
  v_candidate_status_after_exec text;
  v_audit_primary_client_id uuid;
  v_audit_duplicate_client_id uuid;
  v_audit_invoice_ids jsonb;
  v_audit_rolled_back_at timestamptz;
  v_run_status text;
begin
  insert into auth.users(id, email)
  values(u, 'phase0-test@example.test');
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- Fixed, distinct created_at values (rather than now()/clock_timestamp())
  -- so candidate ordering is deterministic. Everything in this test runs in
  -- a single transaction, where now() is constant for the whole transaction
  -- - relying on insertion order alone made the oldest-client tie-break
  -- collapse to random UUID comparison every run.
  insert into public.clients(user_id, name, email, company, created_at)
  values(
    u, 'Northbend Studio', 'billing@example.test', 'Northbend Studio',
    '2026-01-01 00:00:00+00'
  )
  returning id into canonical_client;
  insert into public.clients(user_id, name, email, company, created_at)
  values(
    u, ' northbend-studio ', 'BILLING@example.test', 'Northbend Studio',
    '2026-01-01 00:01:00+00'
  )
  returning id into duplicate_client;

  -- The migration's client_source_identities backfill only runs once, at
  -- migration-apply time, over clients that already existed then. Fixture
  -- clients created afterward (as here) have no provenance row unless the
  -- fixture creates one - simulate that duplicate_client already existed
  -- pre-migration, exactly mirroring the migration's own backfill shape,
  -- so the rollback assertions below have real provenance to restore.
  insert into public.client_source_identities(
    user_id, client_id, source, external_id, provenance
  )
  select user_id, id, 'duewatch', id::text,
    jsonb_build_object(
      'kind', 'legacy_client_id', 'backfilled_at', now(), 'canonical_id', canonical_id
    )
  from public.clients where id = duplicate_client;

  insert into public.clients(user_id, name, email, created_at)
  values(
    u, 'Different Company', 'billing@example.test', '2026-01-01 00:02:00+00'
  )
  returning id into ambiguous_email_client;
  insert into public.clients(user_id, name, company, phone, created_at)
  values(
    u, 'Reception', 'Shared Office', '+1 212 555 0100', '2026-01-01 00:03:00+00'
  )
  returning id into phone_client_a;
  insert into public.clients(user_id, name, company, phone, created_at)
  values(
    u, 'Accounts', 'Shared Office', '1 (212) 555-0100', '2026-01-01 00:04:00+00'
  )
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

  -- Pin down the intended exact candidate (canonical_client/duplicate_client)
  -- explicitly, rather than assuming there's only one exact row overall, and
  -- assert candidate selection matches the documented oldest-client rule:
  -- the earliest created_at survives as primary, the later one is the
  -- duplicate.
  select count(*) into v_intended_candidate_count
  from public.client_merge_candidates
  where run_id = v_run_id
    and rule_code = 'email_with_name_or_company'
    and primary_client_id = canonical_client
    and duplicate_client_id = duplicate_client;
  if v_intended_candidate_count <> 1 then
    raise exception
      'Expected exactly one email_with_name_or_company candidate pairing '
      'canonical_client as primary and duplicate_client as duplicate '
      '(oldest-client rule violated or candidate missing), found %',
      v_intended_candidate_count;
  end if;

  select id, primary_client_id, duplicate_client_id, classification, status,
      affected_invoice_count
    into v_candidate_id, v_primary_client_id, v_duplicate_client_id,
      v_classification, v_candidate_status, v_affected_invoice_count
  from public.client_merge_candidates
  where run_id = v_run_id
    and rule_code = 'email_with_name_or_company'
    and primary_client_id = canonical_client
    and duplicate_client_id = duplicate_client;

  if v_primary_client_id <> canonical_client then
    raise exception 'Candidate primary_client_id was not canonical_client';
  end if;
  if v_duplicate_client_id <> duplicate_client then
    raise exception 'Candidate duplicate_client_id was not duplicate_client';
  end if;
  if v_classification <> 'exact' then
    raise exception 'Candidate classification was % instead of exact',
      v_classification;
  end if;
  if v_candidate_status <> 'ready' then
    raise exception 'Candidate status was % instead of ready', v_candidate_status;
  end if;
  if v_affected_invoice_count <> 1 then
    raise exception 'Candidate affected_invoice_count was % instead of 1',
      v_affected_invoice_count;
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
    select 1 from public.clients where id = canonical_client
  ) then
    raise exception 'canonical_client no longer exists after execution';
  end if;
  if exists(
    select 1 from public.clients where id = duplicate_client
  ) then
    raise exception 'duplicate_client still exists after execution';
  end if;
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

  select status into v_candidate_status_after_exec
  from public.client_merge_candidates where id = v_candidate_id;
  if v_candidate_status_after_exec <> 'executed' then
    raise exception 'Candidate status was % instead of executed after execution',
      v_candidate_status_after_exec;
  end if;

  select primary_client_id, duplicate_client_id, relationship_snapshot->'invoice_ids'
    into v_audit_primary_client_id, v_audit_duplicate_client_id, v_audit_invoice_ids
  from public.client_merge_audit
  where run_id = v_run_id and candidate_id = v_candidate_id;
  if v_audit_primary_client_id <> canonical_client then
    raise exception 'Merge audit primary_client_id was not canonical_client';
  end if;
  if v_audit_duplicate_client_id <> duplicate_client then
    raise exception 'Merge audit duplicate_client_id was not duplicate_client';
  end if;
  if not (v_audit_invoice_ids @> to_jsonb(inv::text)) then
    raise exception
      'Merge audit relationship_snapshot did not record the original invoice UUID';
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
  if not exists(
    select 1 from public.clients where id = canonical_client
  ) then
    raise exception 'canonical_client no longer exists after rollback';
  end if;
  select rolled_back_at into v_audit_rolled_back_at
  from public.client_merge_audit where id = (
    select id from public.client_merge_audit
    where run_id = v_run_id and candidate_id = v_candidate_id
  );
  if v_audit_rolled_back_at is null then
    raise exception 'Merge audit row does not record rollback completion';
  end if;
  select status into v_run_status
  from public.client_dedup_runs where id = v_run_id;
  if v_run_status <> 'rolled_back' then
    raise exception 'Run status was % instead of rolled_back', v_run_status;
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

\echo 'TEST GROUP PASS: integration_relationships'
\echo 'TEST GROUP START: tenant_isolation'

do $tenant_isolation$
declare
  tenant_a constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  tenant_b constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  client_a uuid;
  client_b uuid;
  duplicate_a uuid;
  duplicate_b uuid;
  run_a uuid;
  run_b uuid;
begin
  insert into auth.users(id, email) values
    (tenant_a, 'phase0-tenant-a@example.test'),
    (tenant_b, 'phase0-tenant-b@example.test');

  perform set_config('request.jwt.claim.sub', tenant_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  client_a := public.resolve_or_create_client(
    p_user_id => tenant_a,
    p_name => 'Shared Client',
    p_email => 'SHARED@TENANTS.EXAMPLE.TEST',
    p_phone => '+1 (212) 555-0199',
    p_company => 'Shared Company',
    p_source => ' Stripe ',
    p_external_id => '  cus_Shared  ',
    p_provenance => '{"tenant":"a"}'::jsonb
  );

  perform set_config('request.jwt.claim.sub', tenant_b::text, true);
  client_b := public.resolve_or_create_client(
    p_user_id => tenant_b,
    p_name => ' shared-client ',
    p_email => 'shared@tenants.example.test',
    p_phone => '1 212 555 0199',
    p_company => ' shared-company ',
    p_source => 'STRIPE',
    p_external_id => 'cus_Shared',
    p_provenance => '{"tenant":"b"}'::jsonb
  );

  if client_a = client_b then
    raise exception 'Cross-tenant resolution returned one shared client UUID';
  end if;
  if not exists(select 1 from public.clients where id = client_a and user_id = tenant_a)
    or not exists(select 1 from public.clients where id = client_b and user_id = tenant_b) then
    raise exception 'Resolved client ownership was not tenant-scoped';
  end if;
  if (select count(*) from public.client_source_identities
      where source = 'stripe' and external_id = 'cus_Shared') <> 2
    or not exists(select 1 from public.client_source_identities
      where user_id = tenant_a and client_id = client_a
        and source = 'stripe' and external_id = 'cus_Shared')
    or not exists(select 1 from public.client_source_identities
      where user_id = tenant_b and client_id = client_b
        and source = 'stripe' and external_id = 'cus_Shared') then
    raise exception 'Identical source identities did not remain tenant-scoped';
  end if;

  perform set_config('request.jwt.claim.sub', tenant_a::text, true);
  begin
    perform public.resolve_or_create_client(tenant_b, 'Forbidden Client');
    raise exception 'Expected cross-tenant resolver rejection';
  exception when others then
    if sqlerrm not like '%another user%' then raise; end if;
  end;

  insert into public.clients(user_id, name, email, phone, company, created_at)
  values(
    tenant_a, 'SHARED CLIENT', 'shared@tenants.example.test',
    '12125550199', 'SHARED COMPANY', '2099-01-01 00:00:00+00'
  ) returning id into duplicate_a;
  insert into public.clients(user_id, name, email, phone, company, created_at)
  values(
    tenant_b, 'Shared Client', 'SHARED@TENANTS.EXAMPLE.TEST',
    '+1 212 555 0199', 'Shared Company', '2099-01-01 00:00:01+00'
  ) returning id into duplicate_b;

  run_a := duewatch_ops.prepare_client_dedup(tenant_a);
  run_b := duewatch_ops.prepare_client_dedup(tenant_b);

  if not exists(select 1 from public.client_merge_candidates
      where run_id = run_a and user_id = tenant_a
        and primary_client_id = client_a and duplicate_client_id = duplicate_a)
    or not exists(select 1 from public.client_merge_candidates
      where run_id = run_b and user_id = tenant_b
        and primary_client_id = client_b and duplicate_client_id = duplicate_b) then
    raise exception 'Expected tenant-local candidates were not generated';
  end if;
  if exists(
    select 1
    from public.client_merge_candidates mc
    join public.clients primary_client on primary_client.id = mc.primary_client_id
    join public.clients duplicate_client on duplicate_client.id = mc.duplicate_client_id
    where (mc.run_id = run_a and (
      mc.user_id <> tenant_a
      or primary_client.user_id <> tenant_a
      or duplicate_client.user_id <> tenant_a
    )) or (mc.run_id = run_b and (
      mc.user_id <> tenant_b
      or primary_client.user_id <> tenant_b
      or duplicate_client.user_id <> tenant_b
    ))
  ) then
    raise exception 'Candidate generation crossed tenant ownership';
  end if;
end
$tenant_isolation$;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  true
);
do $tenant_rls$
begin
  if exists(select 1 from public.clients
      where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid)
    or exists(select 1 from public.client_source_identities
      where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid)
    or exists(select 1 from public.client_dedup_runs
      where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid)
    or exists(select 1 from public.client_merge_candidates
      where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'::uuid) then
    raise exception 'Tenant A could read Tenant B client identity data';
  end if;
  if not exists(select 1 from public.clients
      where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid)
    or not exists(select 1 from public.client_source_identities
      where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid)
    or not exists(select 1 from public.client_merge_candidates
      where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid) then
    raise exception 'Tenant A could not read its own identity data';
  end if;
end
$tenant_rls$;
reset role;

\echo 'TEST GROUP PASS: tenant_isolation'
\echo 'TEST GROUP START: resolver_idempotency'

do $resolver_idempotency$
declare
  tenant_id constant uuid := 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
  source_first uuid;
  source_second uuid;
  source_case_variant uuid;
  source_space_variant uuid;
  email_first uuid;
  email_second uuid;
  request_first uuid;
  request_second uuid;
  unrelated_client uuid;
  unrelated_snapshot jsonb;
  candidate_run uuid;
begin
  insert into auth.users(id, email)
  values(tenant_id, 'phase0-idempotency@example.test');
  perform set_config('request.jwt.claim.sub', tenant_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  insert into public.clients(user_id, name, email, created_at)
  values(
    tenant_id, 'Unrelated Client', 'unrelated@unrelated.example.test',
    '2026-02-01 00:00:00+00'
  ) returning id into unrelated_client;
  select to_jsonb(c) into unrelated_snapshot
  from public.clients c where c.id = unrelated_client;

  source_first := public.resolve_or_create_client(
    p_user_id => tenant_id,
    p_name => 'Source Client',
    p_email => 'source@source-idempotency.example.test',
    p_company => 'Source Company',
    p_source => ' Stripe ',
    p_external_id => '  customer  ABC  ',
    p_provenance => '{"attempt":1}'::jsonb
  );
  source_second := public.resolve_or_create_client(
    p_user_id => tenant_id,
    p_name => 'Ignored Retry Name',
    p_email => 'ignored@retry.example.test',
    p_company => 'Ignored Retry Company',
    p_source => 'STRIPE',
    p_external_id => 'customer  ABC',
    p_provenance => '{"attempt":2}'::jsonb
  );
  if source_first <> source_second then
    raise exception 'Source identity retry returned a different canonical UUID';
  end if;
  if (select count(*) from public.clients
      where user_id = tenant_id
        and normalized_email = 'source@source-idempotency.example.test') <> 1
    or (select count(*) from public.client_source_identities
      where user_id = tenant_id and source = 'stripe'
        and external_id = 'customer  ABC') <> 1 then
    raise exception 'Source identity retry created duplicate client/provenance rows';
  end if;

  source_case_variant := public.resolve_or_create_client(
    tenant_id, 'Source Client', 'source@source-idempotency.example.test', null,
    'Source Company', 'stripe', 'customer  abc', '{"variant":"case"}'::jsonb
  );
  source_space_variant := public.resolve_or_create_client(
    tenant_id, 'Source Client', 'source@source-idempotency.example.test', null,
    'Source Company', 'stripe', 'customer ABC', '{"variant":"space"}'::jsonb
  );
  if source_case_variant <> source_first or source_space_variant <> source_first then
    raise exception 'Distinct source-ID spellings did not attach to the same exact email identity';
  end if;
  if (select count(*) from public.client_source_identities
      where user_id = tenant_id and source = 'stripe'
        and client_id = source_first) <> 3 then
    raise exception 'Case/internal-whitespace source IDs were not preserved distinctly';
  end if;

  email_first := public.resolve_or_create_client(
    tenant_id, 'Email Client', ' BILLING@EMAIL-IDEMPOTENCY.EXAMPLE.TEST ', null,
    'Email Company'
  );
  email_second := public.resolve_or_create_client(
    tenant_id, ' email-client ', 'billing@email-idempotency.example.test', null,
    'email company'
  );
  if email_first <> email_second then
    raise exception 'Normalized email retry returned a different canonical UUID';
  end if;
  if (select count(*) from public.clients
      where user_id = tenant_id
        and normalized_email = 'billing@email-idempotency.example.test') <> 1 then
    raise exception 'Normalized email retry created a duplicate client';
  end if;

  request_first := public.resolve_or_create_client(
    tenant_id, 'Request Client', 'requests@request-idempotency.example.test', null,
    'Request Company', 'csv', 'request-001', '{"request":1}'::jsonb
  );
  request_second := public.resolve_or_create_client(
    tenant_id, 'Request Client', 'REQUESTS@REQUEST-IDEMPOTENCY.EXAMPLE.TEST', null,
    'Request Company', 'CSV', 'request-002', '{"request":2}'::jsonb
  );
  if request_first <> request_second then
    raise exception 'Separate request identifiers did not resolve the same exact email identity';
  end if;
  if (select count(*) from public.client_source_identities
      where user_id = tenant_id and source = 'csv'
        and external_id in ('request-001', 'request-002')
        and client_id = request_first) <> 2 then
    raise exception 'Separate request provenance did not attach once to the canonical client';
  end if;

  begin
    insert into public.client_source_identities(
      user_id, client_id, source, external_id, provenance
    ) values (
      tenant_id, email_first, 'stripe', 'customer  ABC', '{}'::jsonb
    );
    raise exception 'Expected duplicate provenance uniqueness violation';
  exception when unique_violation then
    null;
  end;

  candidate_run := duewatch_ops.prepare_client_dedup(tenant_id);
  if exists(select 1 from public.client_merge_candidates
      where run_id = candidate_run) then
    raise exception 'Idempotent resolution created duplicate merge candidates';
  end if;
  if (select to_jsonb(c) from public.clients c where c.id = unrelated_client)
      <> unrelated_snapshot then
    raise exception 'Resolver retries mutated an unrelated client';
  end if;
end
$resolver_idempotency$;

\echo 'TEST GROUP PASS: resolver_idempotency'

rollback;
