-- ============================================================================
-- DueWatch — normalized canonical structural snapshot.
--
-- Emits one comparable text stream describing the STRUCTURE of the
-- DueWatch-relevant schemas (public, duewatch_ops) across:
--   tables (RLS), columns, constraints (incl. FK actions + validity),
--   indexes, RLS policies, table/column/function grants, functions,
--   and triggers.
--
-- Normalization rules (what makes two snapshots comparable):
--   * every record is ONE physical line: any embedded newline inside a
--     definition (function bodies, policy expressions) is rendered as a
--     literal \n marker;
--   * only object NAME + normalized DEFINITION text are emitted — never
--     oids, catalog identifiers, or physical ordering;
--   * the caller sorts the output (`sort`) before diffing, so declaration
--     order is irrelevant;
--   * sequences owned by serial/identity columns are not emitted (they
--     are internal catalog artifacts);
--   * the auth schema, extensions schema, and supabase_migrations are
--     intentionally excluded — platform/ledger state, not DueWatch
--     application structure.
--
-- Usage:  psql "$DB_URL" -X -q -t -A -F $'\t' \
--           -f supabase/convergence/checks/canonical_snapshot_queries.sql \
--           | sort > snapshot.txt
-- ============================================================================

-- ---- tables: RLS enablement + force flag ----------------------------------
select 'TABLE_RLS' as kind,
       n.nspname || '.' || c.relname as object,
       'rowsecurity=' || c.relrowsecurity || ',forcerowsecurity=' || c.relforcerowsecurity as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'duewatch_ops')
  and c.relkind in ('r', 'p')
order by 1, 2;

-- ---- columns: name, type, nullability, default ----------------------------
select 'COLUMN' as kind,
       n.nspname || '.' || c.relname || '.' || a.attname as object,
       replace(
         'type=' || format_type(a.atttypid, a.atttypmod)
         || ',notnull=' || a.attnotnull
         || ',default=' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), '-')
         || ',identity=' || case a.attidentity::text when '' then 'no' else a.attidentity::text end,
         chr(10), '\n'
       ) as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
where n.nspname in ('public', 'duewatch_ops')
  and c.relkind in ('r', 'p')
order by 1, 2;

-- ---- constraints: name, type, definition, validity, deferrability ---------
-- (pg_get_constraintdef renders FK actions: ON DELETE SET NULL (client_id) etc.)
select 'CONSTRAINT' as kind,
       n.nspname || '.' || c.relname || '.' || con.conname as object,
       replace(
         'type=' || con.contype::text
         || ',def=' || pg_get_constraintdef(con.oid)
         || ',validated=' || con.convalidated
         || ',deferrable=' || con.condeferrable
         || ',deferred=' || con.condeferred,
         chr(10), '\n'
       ) as detail
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'duewatch_ops')
order by 1, 2;

-- ---- indexes: name + full definition (covers partial/unique/expr) ---------
select 'INDEX' as kind,
       schemaname || '.' || tablename || '.' || indexname as object,
       replace('def=' || indexdef, chr(10), '\n') as detail
from pg_indexes
where schemaname in ('public', 'duewatch_ops')
order by 1, 2;

-- ---- RLS policies -----------------------------------------------------------
select 'POLICY' as kind,
       schemaname || '.' || tablename || '.' || policyname as object,
       replace(
         'cmd=' || cmd
         || ',roles=' || array_to_string(roles, ',')
         || ',permissive=' || permissive
         || ',qual=' || coalesce(replace(qual, chr(10), '\n'), '-')
         || ',withcheck=' || coalesce(replace(with_check, chr(10), '\n'), '-'),
         chr(10), '\n'
       ) as detail
from pg_policies
where schemaname in ('public', 'duewatch_ops')
order by 1, 2;

-- ---- table-level grants (catalog-faithful: aclexplode of relacl) ------
-- information_schema.role_table_grants is NOT used: it demonstrably drops
-- grantee/privilege combinations that relacl contains (reproduced locally:
-- anon DELETE invisible in the view while present in relacl). The catalog
-- is the source of truth.
select 'TABLE_GRANT' as kind,
       n.nspname || '.' || c.relname as object,
       'privilege=' || a.privilege_type || ',grantee=' || r.rolname
       || case when a.is_grantable then ',grantable' else '' end as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace,
     aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as a(grantor, grantee, privilege_type, is_grantable)
join pg_roles r on r.oid = a.grantee
where n.nspname in ('public', 'duewatch_ops')
  and c.relkind in ('r', 'p')
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by 1, 2, 3;

-- ---- column-level grants (catalog-faithful: only real column ACLs) ----
select 'COLUMN_GRANT' as kind,
       n.nspname || '.' || c.relname || '.' || g.attname as object,
       'privilege=' || a.privilege_type || ',grantee=' || r.rolname as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute g on g.attrelid = c.oid and g.attnum > 0 and not g.attisdropped and g.attacl is not null
cross join lateral aclexplode(g.attacl) as a(grantor, grantee, privilege_type, is_grantable)
join pg_roles r on r.oid = a.grantee
where n.nspname in ('public', 'duewatch_ops')
  and c.relkind in ('r', 'p')
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by 1, 2, 3;

-- ---- function grants --------------------------------------------------------
select 'FUNCTION_GRANT' as kind,
       n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object,
       replace('grantee=' || r.rolname || case when a.is_grantable then ',grantable' else '' end,
               chr(10), '\n') as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace,
     aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as a(grantor, grantee, privilege_type, is_grantable)
join pg_roles r on r.oid = a.grantee
where n.nspname in ('public', 'duewatch_ops')
  and r.rolname in ('anon', 'authenticated', 'service_role')
  and a.privilege_type = 'EXECUTE'
order by 1, 2, 3;

-- ---- functions: full normalized definition ---------------------------------
-- pg_get_functiondef includes language, volatility, security, search_path,
-- and body — the complete normalized identity of a function.
select 'FUNCTION' as kind,
       n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object,
       replace('def=' || pg_get_functiondef(p.oid), chr(10), '\n') as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'duewatch_ops')
  and p.prokind = 'f'
order by 1, 2;

-- ---- triggers on DueWatch tables (excludes platform/auth triggers) ---------
select 'TRIGGER' as kind,
       n.nspname || '.' || c.relname || '.' || t.tgname as object,
       replace(
         'timing=' || case when t.tgenabled in ('O', 'A') then 'enabled' else 'disabled' end
         || ',def=' || pg_get_triggerdef(t.oid),
         chr(10), '\n'
       ) as detail
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'duewatch_ops')
  and not t.tgisinternal
order by 1, 2;
