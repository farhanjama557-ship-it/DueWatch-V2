-- Runs after client_source_identities_tenant_fk_transition_setup.sql and
-- two applications of 20260811000000_client_source_identities_tenant_fk.sql
-- in the same psql invocation/transaction (see that setup file's header for
-- why this all shares one connection and one open transaction).
--
-- Proves the forward migration performs the exact hosted transition — not
-- just fresh-chain idempotency against a database that was never in the old
-- shape — and that reapplying it a second time (the second -f before this
-- file) was itself a clean no-op that left exactly one correct constraint.

do $postconditions$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_client_id_fkey'
  ) then
    raise exception 'Old exact single-column FK was not removed by the forward migration';
  end if;
  if (
    select count(*) from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and contype = 'f'
      and conname = 'client_source_identities_user_id_client_id_fkey'
  ) <> 1 then
    raise exception 'Expected exactly one composite FK named client_source_identities_user_id_client_id_fkey after the forward migration and its reapply';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_user_id_client_id_fkey'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id) ON DELETE CASCADE'
      and convalidated
      and not condeferrable
  ) then
    raise exception 'New exact composite FK is missing or does not match the required definition after the forward migration';
  end if;
end
$postconditions$;

do $fixture$
begin
  insert into auth.users(id, email) values
    ('fd0a0000-0000-4000-8000-0000fd0a0001', 'transition-tenant-a@example.test'),
    ('fd0b0000-0000-4000-8000-0000fd0b0002', 'transition-tenant-b@example.test');
  insert into public.clients(id, user_id, name) values
    ('fd0a1000-0000-4000-8000-0000fd0a1001',
     'fd0a0000-0000-4000-8000-0000fd0a0001', 'Transition Client A'),
    ('fd0b1000-0000-4000-8000-0000fd0b1002',
     'fd0b0000-0000-4000-8000-0000fd0b0002', 'Transition Client B');
end
$fixture$;

grant select, insert on public.clients to authenticated;
grant select, insert, update on public.client_source_identities to authenticated;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub', 'fd0a0000-0000-4000-8000-0000fd0a0001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $same_tenant$
declare
  tenant_a constant uuid := 'fd0a0000-0000-4000-8000-0000fd0a0001';
  client_a constant uuid := 'fd0a1000-0000-4000-8000-0000fd0a1001';
  resolved_id uuid;
begin
  -- Same-tenant insert succeeds after the transition.
  insert into public.client_source_identities(
    user_id, client_id, source, external_id, provenance
  ) values (
    tenant_a, client_a, 'transition_test', 'ext-same-tenant', '{}'::jsonb
  );
  if not exists(
    select 1 from public.client_source_identities
    where user_id = tenant_a and client_id = client_a
      and source = 'transition_test' and external_id = 'ext-same-tenant'
  ) then
    raise exception 'Same-tenant insert did not succeed after the hosted transition';
  end if;

  -- The resolver path still succeeds after the transition.
  resolved_id := public.resolve_or_create_client(
    p_user_id => tenant_a,
    p_name => 'Transition Client A',
    p_source => 'transition_test',
    p_external_id => 'ext-resolver-transition'
  );
  if resolved_id <> client_a then
    raise exception 'Resolver path did not still succeed after the hosted transition';
  end if;
  if pg_typeof(resolved_id) is distinct from 'uuid'::regtype then
    raise exception 'resolve_or_create_client return type changed from uuid';
  end if;
end
$same_tenant$;

select set_config(
  'request.jwt.claim.sub', 'fd0b0000-0000-4000-8000-0000fd0b0002', true
);
do $cross_tenant$
declare
  tenant_b constant uuid := 'fd0b0000-0000-4000-8000-0000fd0b0002';
  client_a constant uuid := 'fd0a1000-0000-4000-8000-0000fd0a1001';
begin
  -- Cross-tenant insert is rejected after the transition.
  begin
    insert into public.client_source_identities(
      user_id, client_id, source, external_id, provenance
    ) values (
      tenant_b, client_a, 'transition_test', 'ext-cross-tenant', '{}'::jsonb
    );
    raise exception 'Expected cross-tenant insert to be rejected after the hosted transition';
  exception when foreign_key_violation then
    null;
  end;
  if exists(
    select 1 from public.client_source_identities
    where source = 'transition_test' and external_id = 'ext-cross-tenant'
  ) then
    raise exception 'Rejected cross-tenant insert left a row behind after the hosted transition';
  end if;
end
$cross_tenant$;
reset role;

set local role service_role;
do $service_role_mismatch$
declare
  tenant_a constant uuid := 'fd0a0000-0000-4000-8000-0000fd0a0001';
  client_b constant uuid := 'fd0b1000-0000-4000-8000-0000fd0b1002';
begin
  -- service_role's mismatched pair is rejected after the transition too.
  begin
    insert into public.client_source_identities(
      user_id, client_id, source, external_id, provenance
    ) values (
      tenant_a, client_b, 'transition_test', 'ext-service-role-cross', '{}'::jsonb
    );
    raise exception 'Expected service_role mismatched pair to be rejected after the hosted transition';
  exception when foreign_key_violation then
    null;
  end;
end
$service_role_mismatch$;
reset role;

\echo 'TEST GROUP PASS: source_identity_tenant_fk_hosted_transition'

rollback;
