-- Disposable PostgreSQL integration test. The caller applies schema.sql,
-- every earlier migration, payments_foundation_pre_migration_setup.sql, and
-- finally 20260816120000_payments_foundation.sql before this file.

\echo 'TEST GROUP START: payments_legacy_preservation'
do $legacy$
declare
  v_audit duewatch_ops.payment_migration_audit%rowtype;
  v_amount numeric;
begin
  select * into v_audit from duewatch_ops.payment_migration_audit where id = 1;
  if v_audit.invoices_with_preexisting_amount_paid <> 5
     or v_audit.reconstructed_invoices <> 1
     or v_audit.reconstructed_payment_rows <> 1
     or v_audit.carry_forward_invoices <> 5
     or v_audit.carry_forward_payment_rows <> 5
     or v_audit.amount_paid_mismatches <> 0
     or v_audit.inconsistent_paid_flags <> 1 then
    raise exception 'Unexpected payment migration audit: %', row_to_json(v_audit);
  end if;

  select sum(a.amount) into v_amount
  from public.payment_allocations a
  where a.invoice_id = 'a2200000-0000-4000-8000-000000000001';
  if v_amount <> 100 then raise exception 'Reconstructed + carry-forward double-counted or lost value: %', v_amount; end if;
  if (select count(*) from public.payments where source_event_id in (
    'a2300000-0000-4000-8000-000000000002', 'a2300000-0000-4000-8000-000000000003'
  )) <> 0 then raise exception 'Ambiguous event total was reconstructed'; end if;
  if exists (
    select 1 from public.payments
    where origin = 'legacy_carry_forward' and recorded_by is not null
  ) then raise exception 'Legacy migration invented an actor'; end if;
  if (select payment_date from public.payments where legacy_invoice_id = 'a2200000-0000-4000-8000-000000000003') <> '2026-01-05' then
    raise exception 'Supported legacy payment date was not preserved';
  end if;
  if exists (
    select 1 from public.payments
    where source_event_id is not null and payment_date is not null
  ) then raise exception 'Event reconstruction invented a real-world payment date'; end if;
  if (select currency from public.payments where legacy_invoice_id = 'a2200000-0000-4000-8000-000000000004') is not null then
    raise exception 'Legacy migration invented a currency';
  end if;
  if exists (
    select 1
    from duewatch_ops.payment_migration_invoice_snapshot s
    join public.invoices i on i.id = s.invoice_id
    where (s.original_amount_paid, s.original_paid) is distinct from (i.amount_paid, i.paid)
  ) then raise exception 'Legacy aggregate or paid flag changed'; end if;

  if exists (
    with expected(invoice_id, original_amount_paid, reconstructed_amount, carry_forward_amount, reconstruction) as (
      values
        ('a2200000-0000-4000-8000-000000000001'::uuid, 100::numeric, 40::numeric, 60::numeric, 'partial'),
        ('a2200000-0000-4000-8000-000000000002'::uuid,  50::numeric,  0::numeric, 50::numeric, 'none'),
        ('a2200000-0000-4000-8000-000000000003'::uuid,  80::numeric,  0::numeric, 80::numeric, 'none'),
        ('a2200000-0000-4000-8000-000000000004'::uuid,  25::numeric,  0::numeric, 25::numeric, 'none'),
        ('b2200000-0000-4000-8000-000000000005'::uuid,  50::numeric,  0::numeric, 50::numeric, 'none')
    ), actual as (
      select
        s.invoice_id,
        s.original_amount_paid,
        coalesce(sum(a.amount) filter (where p.source_event_id is not null), 0) as reconstructed_amount,
        coalesce(sum(a.amount) filter (where p.legacy_invoice_id is not null), 0) as carry_forward_amount,
        coalesce(sum(a.amount), 0) as final_ledger_allocation_total,
        i.amount_paid as final_invoice_amount_paid
      from duewatch_ops.payment_migration_invoice_snapshot s
      join public.invoices i on i.id = s.invoice_id
      left join public.payment_allocations a on a.invoice_id = s.invoice_id
      left join public.payments p on p.id = a.payment_id
      where s.original_amount_paid > 0
      group by s.invoice_id, s.original_amount_paid, i.amount_paid
    )
    select 1
    from expected e
    full join actual a using (invoice_id)
    where e.invoice_id is null or a.invoice_id is null
       or (a.original_amount_paid, a.reconstructed_amount, a.carry_forward_amount,
           a.final_ledger_allocation_total, a.final_invoice_amount_paid)
          is distinct from
          (e.original_amount_paid, e.reconstructed_amount, e.carry_forward_amount,
           e.original_amount_paid, e.original_amount_paid)
  ) then raise exception 'Invoice-level legacy reconciliation differs from the expected lossless split'; end if;
end
$legacy$;

-- Printed into the CI artifact as the invoice-level migration proof. An
-- invoice may appear in both reconstructed and carry-forward counts only when
-- the supported event value is partial; the two amounts must sum exactly to
-- the preserved aggregate.
select
  s.invoice_id,
  s.original_amount_paid,
  coalesce(sum(a.amount) filter (where p.source_event_id is not null), 0) as reconstructed_amount,
  coalesce(sum(a.amount) filter (where p.legacy_invoice_id is not null), 0) as carry_forward_amount,
  coalesce(sum(a.amount), 0) as final_ledger_allocation_total,
  i.amount_paid as final_invoice_amount_paid,
  case
    when coalesce(sum(a.amount) filter (where p.source_event_id is not null), 0) = s.original_amount_paid then 'full'
    when coalesce(sum(a.amount) filter (where p.source_event_id is not null), 0) > 0 then 'partial'
    else 'none'
  end as reconstruction
from duewatch_ops.payment_migration_invoice_snapshot s
join public.invoices i on i.id = s.invoice_id
left join public.payment_allocations a on a.invoice_id = s.invoice_id
left join public.payments p on p.id = a.payment_id
where s.original_amount_paid > 0
group by s.invoice_id, s.original_amount_paid, i.amount_paid
order by s.invoice_id;
\echo 'TEST GROUP PASS: payments_legacy_preservation'

begin;

-- Test-only grants let this transaction exercise the existing invoice RLS
-- and aggregate guard directly even in a repository-schema harness whose
-- default Supabase table grants are absent. The final rollback removes only
-- grants that were not already present; this is not a production grant change.
grant select on public.invoices, public.events to authenticated;
grant update(amount_paid) on public.invoices to authenticated;

create temporary table payments_test_ids(name text primary key, id uuid not null) on commit drop;
insert into payments_test_ids(name, id)
select 'tenant_b_legacy_payment', id
from public.payments
where legacy_invoice_id = 'b2200000-0000-4000-8000-000000000005';
grant select on payments_test_ids to authenticated;

insert into auth.users(id, email) values
  ('c2000000-0000-4000-8000-000000000003', 'payments-runtime-a@example.test'),
  ('d2000000-0000-4000-8000-000000000004', 'payments-runtime-b@example.test');
insert into public.clients(id, user_id, name) values
  ('c2100000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000003', 'Runtime A'),
  ('d2100000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000004', 'Runtime B');
insert into public.invoices(id, user_id, client_id, inv_num, amount, currency) values
  ('c2200000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000003', 'c2100000-0000-4000-8000-000000000003', 'FULL', 100, 'USD'),
  ('c2200000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000003', 'c2100000-0000-4000-8000-000000000003', 'PARTIAL', 100, 'USD'),
  ('c2200000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000003', 'c2100000-0000-4000-8000-000000000003', 'MULTI-A', 100, 'USD'),
  ('c2200000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000003', 'c2100000-0000-4000-8000-000000000003', 'MULTI-B', 100, 'USD'),
  ('c2200000-0000-4000-8000-000000000005', 'c2000000-0000-4000-8000-000000000003', 'c2100000-0000-4000-8000-000000000003', 'EUR', 100, 'EUR'),
  ('c2200000-0000-4000-8000-000000000007', 'c2000000-0000-4000-8000-000000000003', 'c2100000-0000-4000-8000-000000000003', 'EXPLICIT-CURRENCY', 100, null),
  ('c2200000-0000-4000-8000-000000000009', 'c2000000-0000-4000-8000-000000000003', 'c2100000-0000-4000-8000-000000000003', 'MULTI-REVERSAL', 100, 'USD'),
  ('d2200000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000004', 'd2100000-0000-4000-8000-000000000004', 'OTHER-TENANT', 100, 'USD');
insert into public.invoices(
  id, user_id, client_id, inv_num, amount, amount_paid, paid, currency
) values (
  'c2200000-0000-4000-8000-000000000008',
  'c2000000-0000-4000-8000-000000000003',
  'c2100000-0000-4000-8000-000000000003',
  'UNKNOWN-HISTORY-CURRENCY', 100, 10, false, null
);

select set_config('request.jwt.claim.sub', 'c2000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

\echo 'TEST GROUP START: payments_record_and_allocate'
do $record$
declare
  v_result jsonb;
  v_payment uuid;
begin
  v_result := public.record_payment(
    current_date, 100, 'USD',
    '[{"invoice_id":"c2200000-0000-4000-8000-000000000001","amount":"100.00"}]',
    'bank transfer', null
  );
  v_payment := (v_result->>'payment_id')::uuid;
  if (select (amount_paid, paid) from public.invoices where id = 'c2200000-0000-4000-8000-000000000001')
     is distinct from row(100::numeric, true) then raise exception 'Full payment did not close invoice'; end if;
  if (v_result#>>'{allocations,0,allocation_id}') is null then raise exception 'Stable allocation ID missing'; end if;
  if (select recorded_by from public.payments where id = v_payment) <> 'c2000000-0000-4000-8000-000000000003' then
    raise exception 'Founder actor was not recorded';
  end if;
  if not exists (
    select 1 from public.events
    where event_type = 'payment_recorded'
      and evidence->>'payment_id' = v_payment::text
      and evidence->>'allocation_id' is not null
  ) then raise exception 'Stable payment/allocation IDs missing from event evidence'; end if;

  perform public.record_payment(
    current_date, 40, 'USD',
    '[{"invoice_id":"c2200000-0000-4000-8000-000000000002","amount":"40.00"}]'
  );
  if (select (amount_paid, paid) from public.invoices where id = 'c2200000-0000-4000-8000-000000000002')
     is distinct from row(40::numeric, false) then raise exception 'Partial payment aggregate is wrong'; end if;

  perform public.record_payment(
    current_date, 30, 'USD',
    '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"10.00"},
      {"invoice_id":"c2200000-0000-4000-8000-000000000004","amount":"20.00"}]'
  );
  if (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000003') <> 10
     or (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000004') <> 20 then
    raise exception 'Multi-invoice allocation is wrong';
  end if;

  perform public.record_payment(
    current_date, 5, 'CAD',
    '[{"invoice_id":"c2200000-0000-4000-8000-000000000007","amount":"5.00"}]'
  );
  if (select currency from public.invoices where id = 'c2200000-0000-4000-8000-000000000007') <> 'CAD' then
    raise exception 'Explicit founder currency did not initialize an unpaid legacy invoice';
  end if;
end
$record$;
\echo 'TEST GROUP PASS: payments_record_and_allocate'

\echo 'TEST GROUP START: payments_fail_closed'
do $reject$
declare
  v_failed boolean;
  v_other_tenant_payment uuid;
begin
  begin perform public.record_payment(current_date, 1, 'USD', '[{"invoice_id":"d2200000-0000-4000-8000-000000000006","amount":"1.00"}]');
  exception when others then v_failed := true; end;
  if not coalesce(v_failed, false) then raise exception 'Cross-tenant allocation succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 1, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000005","amount":"1.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Currency mismatch succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 10, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"11.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Allocation greater than total succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 10, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"9.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Unallocated payment remainder succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 10, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"5.00"},{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"5.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Duplicate invoice allocation succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 91, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"91.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Invoice over-allocation succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 0, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"0"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Zero payment succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, -1, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"-1"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Negative payment succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date + 1, 1, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"1.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Future-dated payment succeeded'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 1, 'USD', '[{"invoice_id":"c2200000-0000-4000-8000-000000000008","amount":"1.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Unknown-currency legacy history was silently assigned a currency'; end if;

  v_failed := false;
  begin perform public.record_payment(current_date, 1, null, '[{"invoice_id":"c2200000-0000-4000-8000-000000000003","amount":"1.00"}]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Founder payment without an explicit currency succeeded'; end if;

  select id into v_other_tenant_payment
  from payments_test_ids where name = 'tenant_b_legacy_payment';
  v_failed := false;
  begin perform public.reverse_payment(v_other_tenant_payment, 'Cross-tenant attempt');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Cross-tenant reversal succeeded'; end if;

  v_failed := false;
  begin update public.invoices set amount_paid = 99 where id = 'c2200000-0000-4000-8000-000000000003';
  exception when others then v_failed := sqlerrm = 'Invoice payment aggregates may only be changed by payment RPCs'; end;
  if not v_failed then raise exception 'Direct aggregate mutation succeeded'; end if;

  if (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000003') <> 10 then
    raise exception 'Rejected writes changed invoice state';
  end if;
end
$reject$;
\echo 'TEST GROUP PASS: payments_fail_closed'

\echo 'TEST GROUP START: payments_reversal'
do $reverse$
declare
  v_payment uuid;
  v_failed boolean := false;
begin
  select id into v_payment
  from public.payments
  where user_id = 'c2000000-0000-4000-8000-000000000003'
    and total_amount = 100 and origin = 'founder_manual';
  perform public.reverse_payment(v_payment, 'Duplicate bank entry');
  if (select (amount_paid, paid) from public.invoices where id = 'c2200000-0000-4000-8000-000000000001')
     is distinct from row(0::numeric, false) then raise exception 'Reversal did not restore aggregate'; end if;
  begin perform public.reverse_payment(v_payment, 'Second attempt');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Duplicate reversal succeeded'; end if;
  if not exists (
    select 1 from public.events
    where event_type = 'payment_reversed' and evidence->>'payment_id' = v_payment::text
  ) then raise exception 'Reversal event missing stable payment ID'; end if;
end
$reverse$;
\echo 'TEST GROUP PASS: payments_reversal'

\echo 'TEST GROUP START: payments_multi_reversal'
do $multi_rev$
declare
  v_result_a jsonb;
  v_result_b jsonb;
  v_payment_a uuid;
  v_payment_b uuid;
begin
  -- Record payment A=40, payment B=60 against a fresh 100-USD invoice.
  v_result_a := public.record_payment(
    current_date, 40, 'USD',
    '[{"invoice_id":"c2200000-0000-4000-8000-000000000009","amount":"40.00"}]'
  );
  v_payment_a := (v_result_a->>'payment_id')::uuid;

  v_result_b := public.record_payment(
    current_date, 60, 'USD',
    '[{"invoice_id":"c2200000-0000-4000-8000-000000000009","amount":"60.00"}]'
  );
  v_payment_b := (v_result_b->>'payment_id')::uuid;

  -- After A+B the invoice must show fully paid.
  if (select (amount_paid, paid) from public.invoices where id = 'c2200000-0000-4000-8000-000000000009')
     is distinct from row(100::numeric, true) then
    raise exception 'Expected amount_paid=100 paid=true after A+B; got amount_paid=%, paid=%',
      (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009'),
      (select paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009');
  end if;

  -- Reverse payment A only.
  perform public.reverse_payment(v_payment_a, 'test: reverse payment A only');

  -- amount_paid must drop to 60 (B remains), paid must become false.
  if (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009') <> 60 then
    raise exception 'Expected amount_paid=60 after reversing A; got %',
      (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009');
  end if;
  if (select paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009') then
    raise exception 'Expected paid=false after reversing A only';
  end if;

  -- Payment A must be marked reversed; payment B must still be active.
  if not exists (select 1 from public.payments where id = v_payment_a and reversed_at is not null) then
    raise exception 'Payment A should be reversed';
  end if;
  if exists (select 1 from public.payments where id = v_payment_b and reversed_at is not null) then
    raise exception 'Payment B should still be active after reversing only A';
  end if;

  -- Ledger derivability: amount_paid equals sum of active (non-reversed) allocations.
  if (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009') <>
     (select coalesce(sum(a.amount), 0)
      from public.payment_allocations a
      join public.payments p on p.id = a.payment_id
      where a.invoice_id = 'c2200000-0000-4000-8000-000000000009' and p.reversed_at is null) then
    raise exception 'After reversing A: invoice.amount_paid is not derivable from active allocations';
  end if;

  -- Payment B's allocation must be intact at exactly 60.
  if (select coalesce(sum(a.amount), 0)
      from public.payment_allocations a
      join public.payments p on p.id = a.payment_id
      where a.invoice_id = 'c2200000-0000-4000-8000-000000000009'
        and p.id = v_payment_b and p.reversed_at is null) <> 60 then
    raise exception 'Payment B allocation should still be 60 after reversing only A';
  end if;

  -- Optionally reverse B too: invoice must reach amount_paid=0, paid=false.
  perform public.reverse_payment(v_payment_b, 'test: reverse payment B');
  if (select (amount_paid, paid) from public.invoices where id = 'c2200000-0000-4000-8000-000000000009')
     is distinct from row(0::numeric, false) then
    raise exception 'Expected amount_paid=0 paid=false after reversing both A and B; got amount_paid=%, paid=%',
      (select amount_paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009'),
      (select paid from public.invoices where id = 'c2200000-0000-4000-8000-000000000009');
  end if;
end
$multi_rev$;
\echo 'TEST GROUP PASS: payments_multi_reversal'

\echo 'TEST GROUP START: payments_rls'
do $rls$
begin
  if exists (
    select 1 from public.payments where user_id = 'd2000000-0000-4000-8000-000000000004'
  ) then raise exception 'Tenant A can read Tenant B payments'; end if;
  if has_table_privilege('authenticated', 'public.payments', 'INSERT')
     or has_table_privilege('authenticated', 'public.payment_allocations', 'INSERT') then
    raise exception 'Authenticated retained direct financial-table writes';
  end if;
end
$rls$;
\echo 'TEST GROUP PASS: payments_rls'

reset role;

\echo 'TEST GROUP START: payments_bypass_role_tenant_boundary'
do $bypass$
declare
  v_failed boolean := false;
  v_payment uuid;
begin
  begin
    insert into public.payments(
      user_id, recorded_by, payment_date, total_amount, currency, origin
    ) values (
      'c2000000-0000-4000-8000-000000000003',
      'c2000000-0000-4000-8000-000000000003',
      current_date, 1, 'USD', 'founder_manual'
    ) returning id into v_payment;
    insert into public.payment_allocations(payment_id, invoice_id, amount)
    values (v_payment, 'd2200000-0000-4000-8000-000000000006', 1);
  exception when others then
    v_failed := true;
  end;
  if not v_failed then raise exception 'An RLS-bypassing owner created a cross-tenant allocation'; end if;
  if has_table_privilege('service_role', 'public.payments', 'INSERT')
     or has_table_privilege('service_role', 'public.payment_allocations', 'INSERT')
     or has_function_privilege('service_role', 'public.record_payment(date,numeric,text,jsonb,text,text)', 'EXECUTE') then
    raise exception 'service_role can reach a financial write path';
  end if;
end
$bypass$;
\echo 'TEST GROUP PASS: payments_bypass_role_tenant_boundary'

rollback;

\echo 'TEST GROUP START: payments_test_rollback'
do $cleanup$
begin
  if exists (select 1 from auth.users where id in (
    'c2000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000004'
  )) then raise exception 'Runtime payment fixtures survived rollback'; end if;
end
$cleanup$;
\echo 'TEST GROUP PASS: payments_test_rollback'
