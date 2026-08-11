-- Phase 1.5B hosted-default privilege correction.
--
-- The original Phase 1.5B migration is corrected for fresh installations,
-- while this append-only migration normalizes databases where those tables
-- were already created under broad Supabase public-table default ACLs.
-- Every statement is idempotent: revoke the complete table and column ACL,
-- then restore only the contractually required privileges.

revoke all privileges
  on public.import_runs, public.import_batches, public.import_rows, public.import_events
  from PUBLIC, anon, authenticated, service_role;
revoke all privileges (
  id, user_id, idempotency_key, request_payload_hash,
  warnings_acknowledged, status, total_rows, eligible_rows, blocked_rows,
  next_batch_index, cancel_requested_at, created_at, started_at, completed_at
) on public.import_runs from PUBLIC, anon, authenticated, service_role;
revoke all privileges (
  id, run_id, user_id, batch_index, status, row_count,
  failure_reason, internal_diagnostic, created_at
) on public.import_batches from PUBLIC, anon, authenticated, service_role;
revoke all privileges (
  id, run_id, batch_id, user_id, row_number, row_idempotency_key,
  material_payload, material_payload_hash, server_status, block_reason_code,
  block_reason_detail, client_id, client_result, invoice_id, invoice_result,
  committed_at, created_at
) on public.import_rows from PUBLIC, anon, authenticated, service_role;
revoke all privileges (
  id, run_id, user_id, batch_id, row_id, event_type, detail, created_at
) on public.import_events from PUBLIC, anon, authenticated, service_role;

grant select on public.import_runs, public.import_rows, public.import_events
  to authenticated;
grant select (id, run_id, user_id, batch_index, status, row_count, failure_reason, created_at)
  on public.import_batches to authenticated;
grant select, insert, update, delete
  on public.import_runs, public.import_batches, public.import_rows, public.import_events
  to service_role;

do $privilege_postconditions$
declare
  v_table text;
  v_privilege text;
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
    raise exception 'PUBLIC or anon retained an import-table privilege';
  end if;

  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('import_runs', 'import_batches', 'import_rows', 'import_events')
      and grantee = 'authenticated'
      and not (privilege_type = 'SELECT' and table_name in ('import_runs', 'import_rows', 'import_events'))
  ) then
    raise exception 'authenticated retained an unintended import-table privilege';
  end if;

  foreach v_table in array array['import_runs', 'import_rows', 'import_events'] loop
    if not has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT') then
      raise exception 'authenticated is missing SELECT on public.%', v_table;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.import_batches', 'SELECT')
     or has_column_privilege('authenticated', 'public.import_batches', 'internal_diagnostic', 'SELECT') then
    raise exception 'authenticated can read all import_batches columns or internal_diagnostic';
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
    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', format('public.%I', v_table), v_privilege) then
        raise exception 'service_role is missing % on public.%', v_privilege, v_table;
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
        raise exception 'MAINTAIN survived the Phase 1.5B privilege baseline on public.%', v_table;
      end if;
    end loop;
  end if;
end
$privilege_postconditions$;
