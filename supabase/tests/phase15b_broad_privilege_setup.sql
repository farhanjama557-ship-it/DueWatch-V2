-- TEST ONLY: reproduce hosted Supabase-style broad public-table defaults,
-- including a legacy per-column grant that a table-only revoke would miss.
-- The caller owns the surrounding transaction, applies the append-only
-- privilege correction, runs the contract assertions, and rolls back.
-- Never run against hosted data.

grant all privileges
  on public.import_runs, public.import_batches, public.import_rows, public.import_events
  to PUBLIC, anon, authenticated, service_role;
grant select (internal_diagnostic), insert (internal_diagnostic),
      update (internal_diagnostic), references (internal_diagnostic)
  on public.import_batches to PUBLIC, anon, authenticated, service_role;

do $broad_setup_postcondition$
begin
  if not has_table_privilege('anon', 'public.import_runs', 'TRUNCATE')
     or not has_table_privilege('authenticated', 'public.import_events', 'DELETE')
     or not has_table_privilege('service_role', 'public.import_rows', 'TRIGGER')
     or not has_column_privilege(
       'authenticated', 'public.import_batches', 'internal_diagnostic', 'SELECT'
     ) then
    raise exception 'Failed to reproduce the broad hosted-default ACL condition';
  end if;

  if current_setting('server_version_num')::integer >= 170000
     and not has_table_privilege('authenticated', 'public.import_runs', 'MAINTAIN') then
    raise exception 'Broad PG17 ACL setup did not include MAINTAIN';
  end if;
end
$broad_setup_postcondition$;
