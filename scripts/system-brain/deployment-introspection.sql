-- Ask DW System Brain M1B — schema-only deployment introspection.
-- This query reads PostgreSQL catalogs only. It does not select tenant rows.
--
-- Expected output is the structural source that feeds
-- scripts/system-brain-deployment-fingerprint.mjs.

with table_sigs as (
  select t.table_name as name,
         string_agg(
           c.ordinal_position::text || ':' || c.column_name || ':' || c.udt_name || ':' ||
           c.is_nullable || ':' || coalesce(c.column_default,''),
           '|' order by c.ordinal_position
         ) as signature
  from information_schema.tables t
  join information_schema.columns c
    on c.table_schema=t.table_schema and c.table_name=t.table_name
  where t.table_schema='public' and t.table_type='BASE TABLE'
  group by t.table_name
), rls as (
  select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r'
), fks as (
  select tc.table_name || '.' || kcu.column_name || '->' ||
         ccu.table_name || '.' || ccu.column_name as signature
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name=kcu.constraint_name and tc.table_schema=kcu.table_schema
  join information_schema.constraint_column_usage ccu
    on ccu.constraint_name=tc.constraint_name and ccu.table_schema=tc.table_schema
  where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'
), policies as (
  select tablename || ':' || policyname || ':' || cmd || ':' ||
         array_to_string(roles,',') || ':' || coalesce(qual,'') || ':' ||
         coalesce(with_check,'') as signature
  from pg_policies where schemaname='public'
), funcs as (
  select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')->' ||
         pg_get_function_result(p.oid) || ':' || l.lanname ||
         ':security_definer=' || p.prosecdef::text as signature
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  join pg_language l on l.oid=p.prolang
  where n.nspname='public'
)
select jsonb_build_object(
  'source_kind','SCHEMA_ONLY_DEPLOYMENT_SNAPSHOT',
  'fingerprint_source_version','SYSTEM_BRAIN_DEPLOYMENT_SOURCE_V0',
  'schema','public',
  'tenant_row_data_read',false,
  'tables',(
    select jsonb_agg(jsonb_build_object(
      'name',t.name,
      'signature',t.signature,
      'rls_enabled',r.enabled,
      'rls_forced',r.forced
    ) order by t.name)
    from table_sigs t join rls r using(name)
  ),
  'foreign_keys',(select coalesce(jsonb_agg(signature order by signature),'[]'::jsonb) from fks),
  'policies',(select coalesce(jsonb_agg(signature order by signature),'[]'::jsonb) from policies),
  'database_functions',(select coalesce(jsonb_agg(signature order by signature),'[]'::jsonb) from funcs)
) as deployment_source;
