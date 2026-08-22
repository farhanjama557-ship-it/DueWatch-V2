-- Disposable PostgreSQL integration test. The caller applies schema.sql,
-- every earlier migration (or the targeted checkpoint subset plus
-- promise_to_pay_pre_migration_schema.sql), and finally
-- 20260822130000_promise_to_pay_foundation.sql before this file.

begin;

-- Test-only grants + policy let this transaction exercise the existing
-- invoice RLS/FK-restrict behavior and the promise immutability TRIGGER
-- directly (rather than merely hitting a privilege-denied error, or RLS
-- silently matching zero rows) even in a repository-schema harness whose
-- default Supabase table grants/policies are absent -- mirrors
-- payments_foundation_test.sql's own `grant update(amount_paid) on
-- public.invoices to authenticated;`. invoices' pre-existing "for all"
-- policy already covers UPDATE/DELETE once the table-level grant exists;
-- promises has only a SELECT policy in production, so a permissive UPDATE
-- policy is also needed here for the raw UPDATE in promise_immutability to
-- actually reach the row and therefore the trigger, instead of RLS quietly
-- updating zero rows. All of these are local to this transaction and rolled
-- back at the end; this is not a production grant/policy change. The
-- production migration's own `revoke all ... grant select` on
-- public.promises (no production UPDATE policy or grant at all) is asserted
-- separately in the promise_rls group below (INSERT privilege), which this
-- test-only setup does not affect.
grant select, delete on public.invoices to authenticated;
grant update on public.promises to authenticated;
create policy promises_test_update on public.promises for update using (true) with check (true);

insert into auth.users(id, email) values
  ('e2000000-0000-4000-8000-000000000001', 'ptp-runtime-a@example.test'),
  ('f2000000-0000-4000-8000-000000000002', 'ptp-runtime-b@example.test');
insert into public.clients(id, user_id, name) values
  ('e2100000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'Runtime A'),
  ('f2100000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 'Runtime B');
insert into public.invoices(id, user_id, client_id, inv_num, amount, currency) values
  ('e2200000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'GOV-A', 500, 'USD'),
  ('e2200000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'IMMUTABLE', 500, 'USD'),
  ('e2200000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'CURRENCY-DRIFT', 500, 'USD'),
  ('e2200000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'NO-CURRENCY', 500, null),
  ('f2200000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-000000000002', 'f2100000-0000-4000-8000-000000000002', 'OTHER-TENANT', 500, 'USD');

select set_config('request.jwt.claim.sub', 'e2000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

\echo 'TEST GROUP START: promise_propose_and_confirm'
do $propose_confirm$
declare
  v_propose_result jsonb;
  v_confirm_result jsonb;
  v_promise_id uuid;
begin
  v_propose_result := public.propose_promise(
    'e2200000-0000-4000-8000-000000000001', 200, '2026-09-01', 'phone', 'Said the 1st'
  );
  v_promise_id := (v_propose_result->>'promise_id')::uuid;
  if (v_propose_result->>'status') <> 'proposed' then
    raise exception 'propose_promise did not return status=proposed';
  end if;
  if (select status from public.promises where id = v_promise_id) <> 'proposed' then
    raise exception 'Proposed promise row is not status=proposed';
  end if;
  if (select currency from public.promises where id = v_promise_id) <> 'USD' then
    raise exception 'Proposed promise did not snapshot the invoice currency';
  end if;
  if not exists (
    select 1 from public.promise_events
    where promise_id = v_promise_id and event_type = 'proposed' and actor_id = 'e2000000-0000-4000-8000-000000000001'
  ) then raise exception 'propose_promise did not write a matching proposed event'; end if;

  v_confirm_result := public.confirm_promise(v_promise_id, 250, '2026-09-05');
  if (v_confirm_result->>'status') <> 'confirmed' then
    raise exception 'confirm_promise did not return status=confirmed';
  end if;
  if (select (status, promised_amount, promised_date, confirmed_by)
      from public.promises where id = v_promise_id)
     is distinct from row('confirmed'::text, 250::numeric, '2026-09-05'::date, 'e2000000-0000-4000-8000-000000000001'::uuid) then
    raise exception 'Confirmed promise row does not reflect the confirmed terms';
  end if;
  if (select confirmed_at from public.promises where id = v_promise_id) is null then
    raise exception 'confirmed_at was not set';
  end if;
  if not exists (
    select 1 from public.promise_events
    where promise_id = v_promise_id and event_type = 'confirmed' and actor_id = 'e2000000-0000-4000-8000-000000000001'
  ) then raise exception 'confirm_promise did not atomically write a matching confirmed event'; end if;
  -- No orphaned state change without an event, and vice versa.
  if (select count(*) from public.promise_events where promise_id = v_promise_id) <> 2 then
    raise exception 'Expected exactly one proposed event and one confirmed event';
  end if;
end
$propose_confirm$;
\echo 'TEST GROUP PASS: promise_propose_and_confirm'

\echo 'TEST GROUP START: promise_governance_invariant'
do $governance$
declare
  v_promise_a uuid;
  v_promise_b uuid;
  v_failed boolean := false;
begin
  -- Two independent proposals on the SAME invoice (the review queue) --
  -- both proposed rows are allowed.
  v_promise_a := (public.propose_promise(
    'e2200000-0000-4000-8000-000000000002', 100, '2026-09-10', 'email', 'First conversation'
  )->>'promise_id')::uuid;
  v_promise_b := (public.propose_promise(
    'e2200000-0000-4000-8000-000000000002', 150, '2026-09-12', 'text', 'Second conversation'
  )->>'promise_id')::uuid;
  if (select count(*) from public.promises where invoice_id = 'e2200000-0000-4000-8000-000000000002') <> 2 then
    raise exception 'Multiple proposals on the same invoice were not both persisted';
  end if;

  -- Confirming the first is allowed.
  perform public.confirm_promise(v_promise_a, 100, '2026-09-10');
  if (select count(*) from public.promises
      where invoice_id = 'e2200000-0000-4000-8000-000000000002' and status = 'confirmed') <> 1 then
    raise exception 'Expected exactly one confirmed promise after the first confirm';
  end if;

  -- Confirming the second, while the first still governs, must fail --
  -- this is the governance invariant enforced at the DB level.
  begin
    perform public.confirm_promise(v_promise_b, 150, '2026-09-12');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'A second promise was allowed to govern the same invoice'; end if;
  if (select status from public.promises where id = v_promise_b) <> 'proposed' then
    raise exception 'Rejected confirm attempt changed the losing promise state';
  end if;
end
$governance$;
\echo 'TEST GROUP PASS: promise_governance_invariant'

\echo 'TEST GROUP START: promise_immutability'
do $immutable$
declare
  v_promise_id uuid;
  v_failed boolean;
begin
  v_promise_id := (public.propose_promise(
    'e2200000-0000-4000-8000-000000000003', 300, '2026-09-15', 'reply', null
  )->>'promise_id')::uuid;
  perform public.confirm_promise(v_promise_id, 300, '2026-09-15');

  v_failed := false;
  begin update public.promises set promised_amount = 999 where id = v_promise_id;
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Confirmed promised_amount was mutated'; end if;

  v_failed := false;
  begin update public.promises set promised_date = '2026-12-25' where id = v_promise_id;
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Confirmed promised_date was mutated'; end if;

  v_failed := false;
  begin update public.promises set currency = 'EUR' where id = v_promise_id;
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Confirmed currency was mutated'; end if;

  if (select (promised_amount, promised_date, currency) from public.promises where id = v_promise_id)
     is distinct from row(300::numeric, '2026-09-15'::date, 'USD'::text) then
    raise exception 'Rejected mutation attempts changed confirmed terms';
  end if;
end
$immutable$;
\echo 'TEST GROUP PASS: promise_immutability'

\echo 'TEST GROUP START: promise_currency_snapshot'
do $currency$
declare
  v_failed boolean := false;
begin
  -- An invoice with no currency cannot have a promise proposed against it.
  begin perform public.propose_promise(
    'e2200000-0000-4000-8000-000000000004', 100, '2026-09-01', 'email', null
  );
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Proposing against a currency-less invoice succeeded'; end if;
end
$currency$;
\echo 'TEST GROUP PASS: promise_currency_snapshot'

\echo 'TEST GROUP START: promise_fail_closed'
do $reject$
declare
  v_failed boolean;
begin
  v_failed := false;
  begin perform public.propose_promise('f2200000-0000-4000-8000-000000000005', 100, '2026-09-01', 'email', null);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Cross-tenant proposal succeeded'; end if;

  v_failed := false;
  begin perform public.propose_promise('e2200000-0000-4000-8000-000000000001', 0, '2026-09-01', 'email', null);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Zero-amount proposal succeeded'; end if;

  v_failed := false;
  begin perform public.propose_promise('e2200000-0000-4000-8000-000000000001', -50, '2026-09-01', 'email', null);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Negative-amount proposal succeeded'; end if;

  v_failed := false;
  begin perform public.propose_promise('e2200000-0000-4000-8000-000000000001', 100, '2026-09-01', 'carrier_pigeon', null);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Unrecognized source was accepted'; end if;

  v_failed := false;
  begin perform public.confirm_promise('00000000-0000-4000-8000-000000000000', 100, '2026-09-01');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Confirming a non-existent promise succeeded'; end if;

  v_failed := false;
  begin delete from public.invoices where id = 'e2200000-0000-4000-8000-000000000001';
  exception when others then v_failed := sqlerrm ilike '%violates foreign key constraint%'; end;
  if not v_failed then raise exception 'Deleting an invoice with promises did not RESTRICT'; end if;
end
$reject$;
\echo 'TEST GROUP PASS: promise_fail_closed'

\echo 'TEST GROUP START: promise_rls'
do $rls$
begin
  if exists (
    select 1 from public.promises where user_id = 'f2000000-0000-4000-8000-000000000002'
  ) then raise exception 'Tenant A can read Tenant B promises'; end if;
  if has_table_privilege('authenticated', 'public.promises', 'INSERT')
     or has_table_privilege('authenticated', 'public.promise_events', 'INSERT') then
    raise exception 'Authenticated retained direct promise-table writes';
  end if;
end
$rls$;
\echo 'TEST GROUP PASS: promise_rls'

reset role;

\echo 'TEST GROUP START: promise_bypass_role_tenant_boundary'
do $bypass$
declare
  v_failed boolean := false;
begin
  begin
    insert into public.promises(user_id, invoice_id, promised_amount, promised_date, currency, source)
    values (
      'e2000000-0000-4000-8000-000000000001',
      'f2200000-0000-4000-8000-000000000005',
      1, '2026-09-01', 'USD', 'email'
    );
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'An RLS-bypassing owner created a cross-tenant promise'; end if;
  if has_table_privilege('service_role', 'public.promises', 'INSERT')
     or has_function_privilege('service_role', 'public.confirm_promise(uuid,numeric,date)', 'EXECUTE') then
    raise exception 'service_role can reach a promise write path';
  end if;
end
$bypass$;
\echo 'TEST GROUP PASS: promise_bypass_role_tenant_boundary'

rollback;

\echo 'TEST GROUP START: promise_test_rollback'
do $cleanup$
begin
  if exists (select 1 from auth.users where id in (
    'e2000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000002'
  )) then raise exception 'Runtime promise fixtures survived rollback'; end if;
end
$cleanup$;
\echo 'TEST GROUP PASS: promise_test_rollback'
