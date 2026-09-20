begin;

insert into auth.users(id, email) values
  ('a9000000-0000-4000-8000-000000000001', 'security-a@example.test'),
  ('b9000000-0000-4000-8000-000000000002', 'security-b@example.test');

insert into public.clients(id, user_id, name) values
  ('a9100000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'Tenant A'),
  ('b9100000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-000000000002', 'Tenant B');

insert into public.invoices(
  id, user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid
) values
  (
    'a9200000-0000-4000-8000-000000000001',
    'a9000000-0000-4000-8000-000000000001',
    'a9100000-0000-4000-8000-000000000001',
    'SEC-A', 100, 0, current_date, current_date + 30, false
  ),
  (
    'b9200000-0000-4000-8000-000000000002',
    'b9000000-0000-4000-8000-000000000002',
    'b9100000-0000-4000-8000-000000000002',
    'SEC-B', 100, 0, current_date, current_date + 30, false
  );

do $privileges$
begin
  if has_table_privilege('anon', 'public.invoices', 'SELECT')
     or has_table_privilege('anon', 'public.clients', 'SELECT')
     or has_table_privilege('anon', 'public.events', 'INSERT') then
    raise exception 'anon retained application table privileges';
  end if;

  if has_table_privilege('authenticated', 'public.invoices', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.clients', 'REFERENCES')
     or has_table_privilege('authenticated', 'public.events', 'TRIGGER') then
    raise exception 'authenticated retained dangerous table privileges';
  end if;

  if has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE') then
    raise exception 'handle_new_user remained directly executable';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.consume_request_rate_limit(uuid,text,integer,integer,timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'browser can call server-only rate limiter';
  end if;
end
$privileges$;

do $search_path$
declare
  v_config text[];
begin
  select proconfig into v_config
  from pg_proc
  where oid = 'public.normalize_client_text(text)'::regprocedure;

  if v_config is null or not ('search_path=pg_catalog, public, pg_temp' = any(v_config)) then
    raise exception 'normalize_client_text search_path is not fixed';
  end if;
end
$search_path$;

do $policy_cleanup$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and policyname in ('profiles_select','profiles_insert','profiles_update','clients_all','invoices_all','line_items_all')
  ) then
    raise exception 'duplicate legacy RLS policy remained';
  end if;
end
$policy_cleanup$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a9000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $tenant_rls$
declare
  v_count integer;
begin
  select count(*) into v_count from public.invoices;
  if v_count <> 1 then raise exception 'invoice RLS leaked tenant rows: %', v_count; end if;

  update public.invoices set notes = 'forged'
  where id = 'b9200000-0000-4000-8000-000000000002';
  if found then raise exception 'cross-tenant invoice update succeeded'; end if;

  begin
    perform * from public.consume_request_rate_limit(
      'a9000000-0000-4000-8000-000000000001', 'attack', 1, 60, now()
    );
    raise exception 'authenticated executed server-only rate limit RPC';
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from public.acquire_external_action_claim(
      'a9000000-0000-4000-8000-000000000001',
      'a9200000-0000-4000-8000-000000000001',
      'manual_reminder_email',
      'k1',
      repeat('a', 64),
      '{}'::jsonb
    );
    raise exception 'authenticated acquired server-only external claim';
  exception when insufficient_privilege then null;
  end;
end
$tenant_rls$;

reset role;

create temporary table first_rate as
select * from public.consume_request_rate_limit(
  'a9000000-0000-4000-8000-000000000001', 'test-minute', 2, 60,
  '2026-09-20 20:00:00+00'
);
create temporary table second_rate as
select * from public.consume_request_rate_limit(
  'a9000000-0000-4000-8000-000000000001', 'test-minute', 2, 60,
  '2026-09-20 20:00:01+00'
);
create temporary table third_rate as
select * from public.consume_request_rate_limit(
  'a9000000-0000-4000-8000-000000000001', 'test-minute', 2, 60,
  '2026-09-20 20:00:02+00'
);

do $rate$
begin
  if not (select allowed from first_rate) then raise exception 'first rate-limit call blocked'; end if;
  if not (select allowed from second_rate) then raise exception 'second rate-limit call blocked'; end if;
  if (select allowed from third_rate) then raise exception 'rate-limit overflow was allowed'; end if;
end
$rate$;

create temporary table first_claim as
select * from public.acquire_external_action_claim(
  'a9000000-0000-4000-8000-000000000001',
  'a9200000-0000-4000-8000-000000000001',
  'manual_reminder_email',
  'dedupe-key',
  repeat('b', 64),
  '{"proof":"before-send"}'::jsonb
);

create temporary table second_claim as
select * from public.acquire_external_action_claim(
  'a9000000-0000-4000-8000-000000000001',
  'a9200000-0000-4000-8000-000000000001',
  'manual_reminder_email',
  'dedupe-key',
  repeat('b', 64),
  '{"proof":"before-send"}'::jsonb
);

do $claim$
begin
  if not (select acquired from first_claim) then raise exception 'first claim was not acquired'; end if;
  if (select acquired from second_claim) then raise exception 'duplicate external action claim was acquired'; end if;
  if (select existing_status from second_claim) <> 'in_flight' then
    raise exception 'duplicate claim did not report the real existing status';
  end if;

  begin
    perform * from public.acquire_external_action_claim(
      'a9000000-0000-4000-8000-000000000001',
      'b9200000-0000-4000-8000-000000000002',
      'manual_reminder_email',
      'cross-tenant',
      repeat('c', 64),
      '{}'::jsonb
    );
    raise exception 'cross-tenant external claim unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'cross-tenant external claim unexpectedly succeeded' then raise; end if;
  end;
end
$claim$;

select public.resolve_external_action_claim(
  (select claim_id from first_claim),
  'uncertain',
  'resend',
  null,
  '{"error":"network"}'::jsonb
);

create temporary table uncertain_claim as
select * from public.acquire_external_action_claim(
  'a9000000-0000-4000-8000-000000000001',
  'a9200000-0000-4000-8000-000000000001',
  'manual_reminder_email',
  'different-key',
  repeat('b', 64),
  '{}'::jsonb
);

do $uncertain$
begin
  if (select acquired from uncertain_claim) then
    raise exception 'same-message uncertain outcome was allowed to retry';
  end if;
  if (select existing_status from uncertain_claim) <> 'uncertain' then
    raise exception 'uncertain guard did not expose real status';
  end if;
end
$uncertain$;

rollback;
