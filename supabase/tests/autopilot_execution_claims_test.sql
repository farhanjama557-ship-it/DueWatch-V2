-- Disposable Supabase/PostgreSQL integration test for the post-2A.1
-- execution safety checkpoint (Autopilot at-most-once auto-send).
-- Apply schema.sql and supabase/migrations/20260813161329_autopilot_execution_claims.sql
-- first. Everything here runs inside one transaction that always rolls
-- back. Real concurrency (two genuinely simultaneous callers racing the
-- same identity) cannot be exercised inside one transaction — see
-- autopilot_execution_claims_concurrency_proof.sh for that proof.
begin;

\echo 'TEST GROUP START: claim_acquire_and_repeat_blocked'
do $acquire$
declare
  u uuid := gen_random_uuid();
  inv uuid;
  rule_a uuid := gen_random_uuid();
  claim1_id uuid;
  claim1_acquired boolean;
  claim2_id uuid;
  claim2_acquired boolean;
  row_count integer;
  persisted_key text;
begin
  insert into auth.users(id, email) values (u, 'claim-acquire@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 100, '2026-08-01', false)
  returning id into inv;

  -- first caller: must acquire
  select claim_id, acquired into claim1_id, claim1_acquired
  from public.acquire_autopilot_execution_claim(u, inv, rule_a, 'send_reminder', 'idem-key-1');
  if claim1_id is null or claim1_acquired is distinct from true then
    raise exception 'expected the first caller to acquire the claim, got id=% acquired=%', claim1_id, claim1_acquired;
  end if;

  -- a later caller (or scheduler run) for the SAME identity, even with a
  -- DIFFERENT idempotency key string, must be blocked and must resolve to
  -- the SAME already-claimed row -- the first writer's identity wins.
  select claim_id, acquired into claim2_id, claim2_acquired
  from public.acquire_autopilot_execution_claim(u, inv, rule_a, 'send_reminder', 'idem-key-2-different');
  if claim2_acquired is distinct from false then
    raise exception 'expected the second caller to be blocked, got acquired=%', claim2_acquired;
  end if;
  if claim2_id is distinct from claim1_id then
    raise exception 'expected the blocked caller to resolve to the SAME claim id, got % vs %', claim2_id, claim1_id;
  end if;

  select count(*) into row_count
  from public.autopilot_execution_claims
  where user_id = u and invoice_id = inv and rule_id = rule_a and action_type = 'send_reminder';
  if row_count <> 1 then
    raise exception 'expected exactly 1 claim row for the contested identity, got %', row_count;
  end if;

  select idempotency_key into persisted_key from public.autopilot_execution_claims where id = claim1_id;
  if persisted_key <> 'idem-key-1' then
    raise exception 'expected the persisted idempotency_key to be the FIRST caller''s value, got %', persisted_key;
  end if;
end
$acquire$;
\echo 'TEST GROUP PASS: claim_acquire_and_repeat_blocked'

\echo 'TEST GROUP START: claim_blocks_regardless_of_status'
do $status$
declare
  u uuid := gen_random_uuid();
  inv uuid;
  rule_a uuid := gen_random_uuid();
  v_claim_id uuid;
  retry_id uuid;
  retry_acquired boolean;
begin
  insert into auth.users(id, email) values (u, 'claim-status@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 100, '2026-08-01', false)
  returning id into inv;

  select ac.claim_id into v_claim_id
  from public.acquire_autopilot_execution_claim(u, inv, rule_a, 'send_reminder', 'idem-key-uncertain') ac;

  -- simulate a crash/exception between claim acquisition and provider
  -- resolution -- the row is left as 'uncertain', never 'sent'.
  update public.autopilot_execution_claims set status = 'uncertain', resolved_at = now() where id = v_claim_id;

  select ac.claim_id, ac.acquired into retry_id, retry_acquired
  from public.acquire_autopilot_execution_claim(u, inv, rule_a, 'send_reminder', 'idem-key-retry') ac;
  if retry_acquired is distinct from false then
    raise exception 'an uncertain prior claim must still block reacquisition, got acquired=%', retry_acquired;
  end if;

  -- same for a definite 'send_failed' outcome -- also never auto-retried.
  update public.autopilot_execution_claims set status = 'send_failed' where id = v_claim_id;
  select ac.acquired into retry_acquired
  from public.acquire_autopilot_execution_claim(u, inv, rule_a, 'send_reminder', 'idem-key-retry-2') ac;
  if retry_acquired is distinct from false then
    raise exception 'a send_failed prior claim must still block reacquisition, got acquired=%', retry_acquired;
  end if;
end
$status$;
\echo 'TEST GROUP PASS: claim_blocks_regardless_of_status'

\echo 'TEST GROUP START: claim_identity_independence'
do $independence$
declare
  u uuid := gen_random_uuid();
  inv_x uuid;
  inv_y uuid;
  rule_a uuid := gen_random_uuid();
  rule_b uuid := gen_random_uuid();
  acquired boolean;
begin
  insert into auth.users(id, email) values (u, 'claim-independence@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 50, '2026-08-01', false) returning id into inv_x;
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 75, '2026-08-05', false) returning id into inv_y;

  select ac.acquired into acquired from public.acquire_autopilot_execution_claim(u, inv_x, rule_a, 'send_reminder', 'k1') ac;
  if acquired is distinct from true then raise exception 'baseline claim (rule A, invoice X) should acquire'; end if;

  -- same rule, different invoice: independent
  select ac.acquired into acquired from public.acquire_autopilot_execution_claim(u, inv_y, rule_a, 'send_reminder', 'k2') ac;
  if acquired is distinct from true then
    raise exception 'same rule + different invoice must be an independent claim, got acquired=%', acquired;
  end if;

  -- different rule, same invoice: independent
  select ac.acquired into acquired from public.acquire_autopilot_execution_claim(u, inv_x, rule_b, 'send_reminder', 'k3') ac;
  if acquired is distinct from true then
    raise exception 'different rule + same invoice must be an independent claim, got acquired=%', acquired;
  end if;
end
$independence$;
\echo 'TEST GROUP PASS: claim_identity_independence'

\echo 'TEST GROUP START: claim_malformed_and_missing_identity_fails_closed'
do $malformed$
declare
  u uuid := gen_random_uuid();
  other_u uuid := gen_random_uuid();
  inv uuid;
  rule_a uuid := gen_random_uuid();
  raised boolean;
begin
  insert into auth.users(id, email) values (u, 'claim-malformed-owner@example.test');
  insert into auth.users(id, email) values (other_u, 'claim-malformed-other@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), u, 100, '2026-08-01', false)
  returning id into inv;

  -- p_user_id does not actually own p_invoice_id -- must fail closed, not
  -- silently create a cross-tenant claim.
  raised := false;
  begin
    perform public.acquire_autopilot_execution_claim(other_u, inv, rule_a, 'send_reminder', 'k-cross-tenant');
  exception when others then
    raised := true;
  end;
  if not raised then
    raise exception 'expected acquire_autopilot_execution_claim to reject a user/invoice ownership mismatch';
  end if;

  raised := false;
  begin
    perform public.acquire_autopilot_execution_claim(null, inv, rule_a, 'send_reminder', 'k-null-user');
  exception when others then
    raised := true;
  end;
  if not raised then
    raise exception 'expected acquire_autopilot_execution_claim to reject a null user_id';
  end if;

  raised := false;
  begin
    perform public.acquire_autopilot_execution_claim(u, inv, rule_a, '   ', 'k-blank-action');
  exception when others then
    raised := true;
  end;
  if not raised then
    raise exception 'expected acquire_autopilot_execution_claim to reject a blank action_type';
  end if;

  raised := false;
  begin
    perform public.acquire_autopilot_execution_claim(u, inv, rule_a, 'send_reminder', '');
  exception when others then
    raised := true;
  end;
  if not raised then
    raise exception 'expected acquire_autopilot_execution_claim to reject a blank idempotency_key';
  end if;

  if exists (
    select 1 from public.autopilot_execution_claims
    where invoice_id = inv and (rule_id = rule_a) and user_id in (other_u)
  ) then
    raise exception 'a rejected malformed acquisition must never leave a claim row behind';
  end if;
end
$malformed$;
\echo 'TEST GROUP PASS: claim_malformed_and_missing_identity_fails_closed'

\echo 'TEST GROUP START: claim_tenant_boundary_rls'
do $rls_fixture$
declare
  tenant_a constant uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  tenant_b constant uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  rule_a constant uuid := 'cccccccc-0000-4000-8000-00000000000c';
  inv_a uuid;
begin
  insert into auth.users(id, email) values (tenant_a, 'claim-rls-a@example.test');
  insert into auth.users(id, email) values (tenant_b, 'claim-rls-b@example.test');
  insert into public.invoices(id, user_id, amount, due_date, paid)
  values (gen_random_uuid(), tenant_a, 100, '2026-08-01', false)
  returning id into inv_a;

  perform public.acquire_autopilot_execution_claim(tenant_a, inv_a, rule_a, 'send_reminder', 'k-rls');
end
$rls_fixture$;

-- Tenant B must not be able to see tenant A's claim via RLS, even though
-- both are "authenticated" callers. Table-owner sessions (e.g. plain
-- postgres superuser) bypass RLS entirely, so this must genuinely switch
-- role -- matching the exact pattern canonical_clients_test.sql already
-- uses to exercise RLS for real.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-00000000000b', true);
do $tenant_b_view$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from public.autopilot_execution_claims
  where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
  if visible_count <> 0 then
    raise exception 'tenant B must not see tenant A''s execution claims, saw %', visible_count;
  end if;
end
$tenant_b_view$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-00000000000a', true);
do $tenant_a_view$
declare
  visible_count integer;
begin
  select count(*) into visible_count
  from public.autopilot_execution_claims
  where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a';
  if visible_count <> 1 then
    raise exception 'tenant A must see their own execution claim, saw %', visible_count;
  end if;
end
$tenant_a_view$;
reset role;
\echo 'TEST GROUP PASS: claim_tenant_boundary_rls'

rollback;
