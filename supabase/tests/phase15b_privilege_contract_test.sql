-- Phase 1.5B exact privilege, RLS, and tenant-boundary contract.
-- The caller must already have started the test transaction, run
-- phase15b_broad_privilege_setup.sql, and applied the append-only correction.

\echo 'TEST GROUP START: privilege_baseline'
do $privilege_contract$
declare
  v_actual text[];
  v_expected text[];
  v_table text;
  v_privilege text;
  v_fk record;
begin
  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('import_runs', 'import_batches', 'import_rows', 'import_events')
      and grantee in ('PUBLIC', 'anon')
  ) or exists (
    select 1
    from information_schema.role_column_grants
    where table_schema = 'public'
      and table_name in ('import_runs', 'import_batches', 'import_rows', 'import_events')
      and grantee in ('PUBLIC', 'anon')
  ) then
    raise exception 'PUBLIC or anon retained an import-table or column privilege';
  end if;

  select coalesce(array_agg(table_name || ':' || privilege_type order by table_name, privilege_type), array[]::text[])
  into v_actual
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('import_runs', 'import_batches', 'import_rows', 'import_events')
    and grantee = 'authenticated';
  v_expected := array[
    'import_events:SELECT',
    'import_rows:SELECT',
    'import_runs:SELECT'
  ];
  if v_actual <> v_expected then
    raise exception 'authenticated table ACL mismatch: expected %, got %', v_expected, v_actual;
  end if;

  select coalesce(array_agg(column_name || ':' || privilege_type order by column_name, privilege_type), array[]::text[])
  into v_actual
  from information_schema.role_column_grants
  where table_schema = 'public'
    and table_name = 'import_batches'
    and grantee = 'authenticated';
  v_expected := array[
    'batch_index:SELECT',
    'created_at:SELECT',
    'failure_reason:SELECT',
    'id:SELECT',
    'row_count:SELECT',
    'run_id:SELECT',
    'status:SELECT',
    'user_id:SELECT'
  ];
  if v_actual <> v_expected then
    raise exception 'authenticated import_batches column ACL mismatch: expected %, got %', v_expected, v_actual;
  end if;
  if has_table_privilege('authenticated', 'public.import_batches', 'SELECT')
     or has_column_privilege('authenticated', 'public.import_batches', 'internal_diagnostic', 'SELECT') then
    raise exception 'authenticated can read all import_batches columns or internal_diagnostic';
  end if;

  select coalesce(array_agg(table_name || ':' || privilege_type order by table_name, privilege_type), array[]::text[])
  into v_actual
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('import_runs', 'import_batches', 'import_rows', 'import_events')
    and grantee = 'service_role';
  select array_agg(t.table_name || ':' || p.privilege order by t.table_name, p.privilege)
  into v_expected
  from unnest(array['import_runs', 'import_batches', 'import_rows', 'import_events']) t(table_name)
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p(privilege);
  if v_actual <> v_expected then
    raise exception 'service_role table ACL mismatch: expected %, got %', v_expected, v_actual;
  end if;

  foreach v_table in array array['import_runs', 'import_batches', 'import_rows', 'import_events'] loop
    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', format('public.%I', v_table), v_privilege) then
        raise exception 'anon retained % on public.%', v_privilege, v_table;
      end if;
    end loop;
    foreach v_privilege in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('authenticated', format('public.%I', v_table), v_privilege) then
        raise exception 'authenticated retained % on public.%', v_privilege, v_table;
      end if;
    end loop;
    foreach v_privilege in array array['TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('service_role', format('public.%I', v_table), v_privilege) then
        raise exception 'service_role retained % on public.%', v_privilege, v_table;
      end if;
    end loop;
  end loop;
  if current_setting('server_version_num')::integer >= 170000 then
    foreach v_table in array array['import_runs', 'import_batches', 'import_rows', 'import_events'] loop
      if has_table_privilege('anon', format('public.%I', v_table), 'MAINTAIN')
         or has_table_privilege('authenticated', format('public.%I', v_table), 'MAINTAIN')
         or has_table_privilege('service_role', format('public.%I', v_table), 'MAINTAIN') then
        raise exception 'MAINTAIN survived on public.%', v_table;
      end if;
    end loop;
  end if;

  if (
    select count(*)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('import_runs', 'import_batches', 'import_rows', 'import_events')
      and c.relrowsecurity
  ) <> 4 then
    raise exception 'RLS is not enabled on every import table';
  end if;
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename in ('import_runs', 'import_batches', 'import_rows', 'import_events')
      and (cmd <> 'SELECT' or roles <> array['authenticated']::name[]
        or qual not like '%auth.uid()%user_id%')
  ) or (
    select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('import_runs', 'import_batches', 'import_rows', 'import_events')
  ) <> 4 then
    raise exception 'The own-tenant import SELECT policies changed';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.client_source_identities'::regclass
      and conname = 'client_source_identities_user_id_client_id_fkey'
      and convalidated and not condeferrable and not condeferred
      and pg_get_constraintdef(oid) =
        'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id) ON DELETE CASCADE'
  ) then
    raise exception 'Gate 1 source-identity tenant FK changed';
  end if;

  for v_fk in
    select * from (values
      ('public.import_batches'::regclass, 'import_batches_user_id_run_id_fkey',
       'FOREIGN KEY (user_id, run_id) REFERENCES import_runs(user_id, id) ON DELETE CASCADE'),
      ('public.import_rows'::regclass, 'import_rows_user_id_run_id_fkey',
       'FOREIGN KEY (user_id, run_id) REFERENCES import_runs(user_id, id) ON DELETE CASCADE'),
      ('public.import_rows'::regclass, 'import_rows_user_id_batch_id_fkey',
       'FOREIGN KEY (user_id, batch_id) REFERENCES import_batches(user_id, id) ON DELETE SET NULL'),
      ('public.import_rows'::regclass, 'import_rows_user_id_client_id_fkey',
       'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id) ON DELETE SET NULL (client_id)'),
      ('public.import_rows'::regclass, 'import_rows_user_id_invoice_id_fkey',
       'FOREIGN KEY (user_id, invoice_id) REFERENCES invoices(user_id, id) ON DELETE SET NULL (invoice_id)'),
      ('public.import_events'::regclass, 'import_events_user_id_run_id_fkey',
       'FOREIGN KEY (user_id, run_id) REFERENCES import_runs(user_id, id) ON DELETE CASCADE'),
      ('public.import_events'::regclass, 'import_events_user_id_batch_id_fkey',
       'FOREIGN KEY (user_id, batch_id) REFERENCES import_batches(user_id, id) ON DELETE SET NULL'),
      ('public.import_events'::regclass, 'import_events_user_id_row_id_fkey',
       'FOREIGN KEY (user_id, row_id) REFERENCES import_rows(user_id, id) ON DELETE SET NULL')
    ) expected(relid, constraint_name, definition)
  loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = v_fk.relid
        and conname = v_fk.constraint_name
        and contype = 'f' and convalidated
        and pg_get_constraintdef(oid) = v_fk.definition
    ) then
      raise exception 'Import tenant FK % changed or disappeared', v_fk.constraint_name;
    end if;
  end loop;

  if (select execution_enabled from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$privilege_contract$;

-- A genuine role switch verifies direct authenticated writes remain
-- unavailable in addition to the catalog assertions above. Each attempted
-- write is wrapped in a subtransaction and must raise insufficient_privilege.
set local role authenticated;
do $direct_authenticated_write$
begin
  begin
    insert into public.import_runs(user_id, idempotency_key, request_payload_hash)
    values ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'forbidden', 'forbidden');
    raise exception 'authenticated unexpectedly inserted an import run';
  exception when insufficient_privilege then
    null;
  end;
end
$direct_authenticated_write$;
reset role;

\echo 'TEST GROUP PASS: privilege_baseline'
rollback;
