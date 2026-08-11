-- Stable catalog fingerprint for the Gate 1 tenant boundary plus the
-- Phase 1.5B persistence contract. Object IDs and mutable row data are
-- deliberately excluded so fresh and forward-migrated schemas can be
-- compared directly.
with components as (
  select 'column' as kind,
         table_schema || '.' || table_name || '.' || column_name || ':' ||
         ordinal_position || ':' || udt_schema || '.' || udt_name || ':' ||
         is_nullable || ':' || coalesce(column_default, '') as definition
  from information_schema.columns
  where (table_schema = 'public' and table_name in (
           'clients', 'client_source_identities', 'invoices',
           'import_runs', 'import_batches', 'import_rows', 'import_events'
         ))
     or (table_schema = 'duewatch_ops' and table_name in (
           'import_issue_codes', 'import_approved_warning_codes',
           'import_status_values', 'import_supported_currencies'
         ))

  union all

  select 'constraint',
         conrelid::regclass::text || '.' || conname || ':' || contype::text || ':' ||
         convalidated || ':' || condeferrable || ':' || condeferred || ':' ||
         pg_get_constraintdef(oid)
  from pg_constraint
  where conrelid in (
    'public.clients'::regclass,
    'public.client_source_identities'::regclass,
    'public.invoices'::regclass,
    'public.import_runs'::regclass,
    'public.import_batches'::regclass,
    'public.import_rows'::regclass,
    'public.import_events'::regclass
  )

  union all

  select 'index', schemaname || '.' || indexname || ':' || indexdef
  from pg_indexes
  where (schemaname = 'public' and tablename in (
    'clients', 'client_source_identities', 'invoices',
    'import_runs', 'import_batches', 'import_rows', 'import_events'
  ))

  union all

  select 'policy', schemaname || '.' || tablename || '.' || policyname || ':' ||
         permissive || ':' || roles::text || ':' || cmd || ':' ||
         coalesce(qual, '') || ':' || coalesce(with_check, '')
  from pg_policies
  where schemaname = 'public' and tablename in (
    'client_source_identities', 'import_runs', 'import_batches', 'import_rows', 'import_events'
  )

  union all

  select 'table_grant', table_schema || '.' || table_name || ':' || grantee || ':' || privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name in ('import_runs', 'import_batches', 'import_rows', 'import_events')
    and grantee in ('authenticated', 'service_role')

  union all

  select 'column_grant', table_schema || '.' || table_name || '.' || column_name || ':' ||
         grantee || ':' || privilege_type
  from information_schema.role_column_grants
  where table_schema = 'public'
    and table_name in ('import_runs', 'import_batches', 'import_rows', 'import_events')
    and grantee in ('authenticated', 'service_role')

  union all

  select 'function', n.nspname || '.' || p.proname || ':' ||
         pg_get_function_identity_arguments(p.oid) || ':' || pg_get_functiondef(p.oid)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname in (
           'resolve_or_create_client', 'start_import_run',
           'process_import_batch', 'request_import_cancellation'
         ))
     or (n.nspname = 'duewatch_ops' and p.proname in (
           'evaluate_row_eligibility', 'resolve_client_for_import'
         ))
)
select 'SCHEMA_FINGERPRINT=' || md5(string_agg(kind || ':' || definition, E'\n' order by kind, definition))
from components;
