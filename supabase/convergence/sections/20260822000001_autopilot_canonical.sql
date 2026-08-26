-- [SECTION: autopilot-canonical begin]
-- ------------------------------------------------------------
-- Canonical Autopilot configuration tables.
--
-- These two tables were originally created OUTSIDE the repository's
-- migration history (directly in the hosted project). Their live shape
-- was independently verified (2026-08-22 coordinator inspection) and is
-- codified here exactly: columns, types, NOT NULL, defaults, the
-- unique(user_id) on settings, both ON DELETE CASCADE FKs to auth.users,
-- RLS enablement, and the *_own policies.
--
-- On a fresh database this section CREATES the tables. On the verified
-- legacy-live baseline the tables already exist; the assertion block
-- below then FAILS CLOSED if their actual shape deviates from the
-- verified canonical form instead of silently trusting a same-name table
-- (create-if-not-exists must never launder an unknown shape).
--
-- ACL: the hosted ACL was never captured, and hosted dashboard-created
-- tables typically carry broad default privileges. GRANT alone cannot
-- narrow those, so the canonical ACL is established explicitly:
-- REVOKE everything from the client roles first, then grant only what
-- the application requires. anon receives NO direct table privileges
-- (RLS + no grants); authenticated receives select/insert/update (the
-- settings/rules UI paths in src/lib/autopilot.js); service_role
-- receives those plus delete.
-- ------------------------------------------------------------

create table if not exists public.autopilot_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  approval_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint autopilot_settings_user_id_key unique (user_id)
);

create table if not exists public.autopilot_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  trigger_type text not null,
  trigger_days integer not null,
  tone text not null default 'friendly',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists autopilot_rules_user_id_idx
  on public.autopilot_rules (user_id);

alter table public.autopilot_settings enable row level security;
alter table public.autopilot_rules enable row level security;

drop policy if exists "autopilot_settings_own" on public.autopilot_settings;
create policy "autopilot_settings_own" on public.autopilot_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "autopilot_rules_own" on public.autopilot_rules;
create policy "autopilot_rules_own" on public.autopilot_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Canonical ACL: revoke-then-grant so pre-existing broader privileges
-- (e.g. dashboard defaults) cannot survive into the canonical state.
-- PUBLIC is revoked too: surviving PUBLIC privileges would silently
-- bypass the intended anon/authenticated/service_role-only grant matrix.
-- Column-level privileges are revoked explicitly as well — REVOKE ALL ON
-- <table> does NOT remove column-level ACLs, and the table shapes are
-- asserted exactly below, so the column lists are complete by
-- construction.
revoke all on public.autopilot_settings from PUBLIC, anon, authenticated, service_role;
revoke all on public.autopilot_rules from PUBLIC, anon, authenticated, service_role;
revoke all (id, user_id, enabled, approval_required, created_at, updated_at)
  on public.autopilot_settings from PUBLIC, anon, authenticated, service_role;
revoke all (id, user_id, name, trigger_type, trigger_days, tone, enabled, sort_order, created_at)
  on public.autopilot_rules from PUBLIC, anon, authenticated, service_role;
grant select, insert, update on public.autopilot_settings to authenticated;
grant select, insert, update on public.autopilot_rules to authenticated;
grant select, insert, update, delete on public.autopilot_settings to service_role;
grant select, insert, update, delete on public.autopilot_rules to service_role;

-- Fail-closed full-shape assertion: everything the section header claims
-- must be true in the catalog before the caller may proceed.
do $assert_autopilot_canonical$
declare
  v_expected_settings text := $ddl$id|uuid|NO|gen_random_uuid()
user_id|uuid|NO|
enabled|boolean|NO|false
approval_required|boolean|NO|true
created_at|timestamp with time zone|NO|now()
updated_at|timestamp with time zone|NO|now()$ddl$;
  v_expected_rules text := $ddl$id|uuid|NO|gen_random_uuid()
user_id|uuid|NO|
name|text|NO|
trigger_type|text|NO|
trigger_days|integer|NO|
tone|text|NO|'friendly'::text
enabled|boolean|NO|true
sort_order|integer|NO|0
created_at|timestamp with time zone|NO|now()$ddl$;
  v_settings text;
  v_rules text;
  v_settings_pk text;
  v_rules_pk text;
  v_settings_fk text;
  v_rules_fk text;
  v_settings_uq text;
  v_anon_privs text;
  v_auth_privs text;
  v_service_privs text;
  v_bad_policy text;
  v_acl_pair record;
begin
  -- Columns: name/type/nullability/default, exact set and order.
  select coalesce(string_agg(
    column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, ''),
    chr(10) order by ordinal_position
  ), '<missing>') into v_settings
  from information_schema.columns
  where table_schema = 'public' and table_name = 'autopilot_settings';

  select coalesce(string_agg(
    column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, ''),
    chr(10) order by ordinal_position
  ), '<missing>') into v_rules
  from information_schema.columns
  where table_schema = 'public' and table_name = 'autopilot_rules';

  if v_settings <> v_expected_settings or v_rules <> v_expected_rules then
    raise exception using
      errcode = '22023',
      message = 'autopilot_settings/autopilot_rules shape does not match the verified canonical DDL; refusing to converge an unrecognized table',
      detail = 'settings expected:' || chr(10) || v_expected_settings || chr(10)
            || 'settings actual:' || chr(10) || v_settings || chr(10)
            || 'rules expected:' || chr(10) || v_expected_rules || chr(10)
            || 'rules actual:' || chr(10) || v_rules;
  end if;

  -- Primary keys.
  select coalesce((select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.autopilot_settings'::regclass and contype = 'p'), '<missing>')
    into v_settings_pk;
  select coalesce((select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.autopilot_rules'::regclass and contype = 'p'), '<missing>')
    into v_rules_pk;
  if v_settings_pk <> 'PRIMARY KEY (id)' or v_rules_pk <> 'PRIMARY KEY (id)' then
    raise exception 'autopilot primary keys are not (id): settings=%, rules=%', v_settings_pk, v_rules_pk;
  end if;

  -- user_id FK -> auth.users(id) ON DELETE CASCADE (by definition, not name).
  select coalesce((select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.autopilot_settings'::regclass and contype = 'f'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE'), '<missing>')
    into v_settings_fk;
  select coalesce((select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.autopilot_rules'::regclass and contype = 'f'
      and pg_get_constraintdef(oid) = 'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE'), '<missing>')
    into v_rules_fk;
  if v_settings_fk = '<missing>' or v_rules_fk = '<missing>' then
    raise exception 'autopilot user_id -> auth.users(id) ON DELETE CASCADE FK missing or not exact: settings=%, rules=%', v_settings_fk, v_rules_fk;
  end if;

  -- settings UNIQUE(user_id) under its canonical name.
  if not exists (
    select 1 from pg_constraint k
    where k.conrelid = 'public.autopilot_settings'::regclass
      and k.contype = 'u'
      and k.conname = 'autopilot_settings_user_id_key'
      and pg_get_constraintdef(k.oid) = 'UNIQUE (user_id)'
  ) then
    raise exception 'autopilot_settings is missing UNIQUE (user_id) under its canonical name/definition';
  end if;

  -- RLS enabled on both tables.
  if not (select relrowsecurity from pg_class where oid = 'public.autopilot_settings'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.autopilot_rules'::regclass) then
    raise exception 'autopilot tables must have row level security enabled';
  end if;

  -- Exact policy definitions (command, roles, expressions).
  select coalesce(string_agg(
    policyname || ':' || cmd || ':roles=[' || array_to_string(roles, ',') || ']:qual=' || coalesce(qual, '-') || ':withcheck=' || coalesce(with_check, '-'),
    ' | ' order by policyname
  ), '<none>') into v_bad_policy
  from pg_policies
  where schemaname = 'public'
    and tablename in ('autopilot_settings', 'autopilot_rules')
    and (policyname, cmd, array_to_string(roles, ','), coalesce(qual, '-'), coalesce(with_check, '-')) not in (
      ('autopilot_settings_own', 'ALL', 'public', '(auth.uid() = user_id)', '(auth.uid() = user_id)'),
      ('autopilot_rules_own', 'ALL', 'public', '(auth.uid() = user_id)', '(auth.uid() = user_id)')
    );
  if v_bad_policy <> '<none>' or (
    select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('autopilot_settings', 'autopilot_rules')
  ) <> 2 then
    raise exception 'autopilot policies deviate from the canonical definitions: %', v_bad_policy;
  end if;

  -- Exact intended ACLs, asserted PER TABLE x PER GRANTEE (no INTERSECT:
  -- an intersection proves only common privileges, not each table's exact
  -- set). PUBLIC is grantee OID 0 in aclexplode and has no pg_roles row,
  -- so grantees are resolved without joining pg_roles. Each of the eight
  -- (table, grantee) pairs must equal its intended exact privilege set.
  create temp table _autopilot_acl_checks on commit drop as
    select c.relname,
           case a.grantee when 0 then 'PUBLIC' else r.rolname end as grantee,
           a.privilege_type
    from pg_class c,
         aclexplode(coalesce(c.relacl, array[]::aclitem[])) as a(grantor, grantee, privilege_type, is_grantable)
    left join pg_roles r on r.oid = a.grantee
    where c.oid in ('public.autopilot_settings'::regclass, 'public.autopilot_rules'::regclass)
      and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'));

  for v_acl_pair in
    select * from (values
      ('autopilot_settings','PUBLIC','<none>'),
      ('autopilot_settings','anon','<none>'),
      ('autopilot_settings','authenticated','INSERT,SELECT,UPDATE'),
      ('autopilot_settings','service_role','DELETE,INSERT,SELECT,UPDATE'),
      ('autopilot_rules','PUBLIC','<none>'),
      ('autopilot_rules','anon','<none>'),
      ('autopilot_rules','authenticated','INSERT,SELECT,UPDATE'),
      ('autopilot_rules','service_role','DELETE,INSERT,SELECT,UPDATE')
    ) p(relname, grantee, expected_privs)
  loop
    select coalesce(string_agg(privilege_type, ',' order by privilege_type), '<none>')
      into v_anon_privs
      from _autopilot_acl_checks
      where relname = v_acl_pair.relname and grantee = v_acl_pair.grantee;
    if v_anon_privs <> v_acl_pair.expected_privs then
      raise exception 'autopilot table ACL deviates from the canonical exact matrix: %.% expected [%] found [%]',
        v_acl_pair.relname, v_acl_pair.grantee, v_acl_pair.expected_privs, v_anon_privs;
    end if;
  end loop;

  -- No column-level privileges may remain for PUBLIC or any client role
  -- (an unexpected column ACL would bypass the table-level matrix).
  select coalesce(string_agg(
    c.relname || '.' || a2.attname || ':' ||
      case a.grantee when 0 then 'PUBLIC' else r.rolname end || '=' || a.privilege_type,
    ' | '), '<none>')
  into v_service_privs
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a2 on a2.attrelid = c.oid and a2.attnum > 0 and not a2.attisdropped
       and a2.attacl is not null
  cross join lateral aclexplode(a2.attacl) as a(grantor, grantee, privilege_type, is_grantable)
  left join pg_roles r on r.oid = a.grantee
  where c.oid in ('public.autopilot_settings'::regclass, 'public.autopilot_rules'::regclass)
    and (a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role'));
  if v_service_privs <> '<none>' then
    raise exception 'autopilot tables must carry NO column-level privileges for PUBLIC/anon/authenticated/service_role; found: %', v_service_privs;
  end if;

  drop table _autopilot_acl_checks;
end
$assert_autopilot_canonical$;
-- [SECTION: autopilot-canonical end]
