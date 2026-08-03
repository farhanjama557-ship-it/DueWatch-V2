-- Hosted-staging verification for the invoice/client tenant invariant.
-- Run only after the correction migration is applied. Every fixture and
-- test-only grant is inside this transaction and is removed by rollback.
begin;

do $schema_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_user_id_client_id_fkey'
      and contype = 'f'
      and convalidated
      and pg_get_constraintdef(oid)
        like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%ON DELETE SET NULL (client_id)%'
  ) then
    raise exception 'Validated invoice/client tenant constraint is missing or unsafe';
  end if;
end
$schema_check$;

insert into auth.users(id, email) values
  ('daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'staging-invariant-a@example.test'),
  ('dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'staging-invariant-b@example.test');

insert into public.clients(id, user_id, name) values
  ('d1000000-0000-4000-8000-000000000001',
   'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Staging Tenant A Client'),
  ('d2000000-0000-4000-8000-000000000002',
   'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Staging Tenant B Client');

-- No test-only table grant is added here: hosted privilege compatibility is
-- part of this verification. Failure to use invoices as authenticated is a
-- named staging blocker rather than something this script masks.
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  true
);
do $authenticated_checks$
declare
  tenant_a constant uuid := 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  tenant_b constant uuid := 'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  client_a constant uuid := 'd1000000-0000-4000-8000-000000000001';
  client_b constant uuid := 'd2000000-0000-4000-8000-000000000002';
  invoice_a uuid;
begin
  insert into public.invoices(user_id, client_id, inv_num, amount)
  values(tenant_a, client_a, 'STAGING-SAME-TENANT', 10)
  returning id into invoice_a;

  begin
    insert into public.invoices(user_id, client_id, inv_num, amount)
    values(tenant_a, client_b, 'STAGING-CROSS-INSERT', 10);
    raise exception 'Expected authenticated cross-tenant insert rejection';
  exception when foreign_key_violation then null;
  end;

  begin
    update public.invoices set client_id = client_b where id = invoice_a;
    raise exception 'Expected authenticated cross-tenant update rejection';
  exception when foreign_key_violation then null;
  end;

  insert into public.invoices(user_id, client_id, inv_num, amount)
  values(tenant_a, null, 'STAGING-NULL-CLIENT', 10);
end
$authenticated_checks$;
reset role;

do $owner_checks$
declare
  tenant_a constant uuid := 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  client_a constant uuid := 'd1000000-0000-4000-8000-000000000001';
  client_b constant uuid := 'd2000000-0000-4000-8000-000000000002';
  delete_invoice uuid;
begin
  begin
    insert into public.invoices(user_id, client_id, inv_num, amount)
    values(tenant_a, client_b, 'STAGING-OWNER-CROSS', 10);
    raise exception 'Expected owner cross-tenant insert rejection';
  exception when foreign_key_violation then null;
  end;

  insert into public.invoices(user_id, client_id, inv_num, amount)
  values(tenant_a, client_a, 'STAGING-DELETE-NULL', 10)
  returning id into delete_invoice;
  delete from public.clients where id = client_a;
  if not exists(
    select 1 from public.invoices where id = delete_invoice and client_id is null
  ) then
    raise exception 'Client deletion did not preserve invoice with null client_id';
  end if;
end
$owner_checks$;

do $execution_check$
begin
  if (select execution_enabled
      from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution was enabled';
  end if;
end
$execution_check$;

select jsonb_build_object(
  'same_tenant_insert', 'passed',
  'authenticated_cross_tenant_insert', 'rejected',
  'authenticated_cross_tenant_update', 'rejected',
  'owner_cross_tenant_insert', 'rejected',
  'null_client_id', 'passed',
  'client_delete_sets_client_id_null', 'passed',
  'fixtures_rolled_back', true,
  'execution_enabled', false
) as invoice_client_tenant_verification;

rollback;
