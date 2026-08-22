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
-- Grants: the hosted ACL was not part of the verified facts, so the
-- least-privilege set the application actually needs is granted here
-- explicitly (authenticated: select/insert/update for the settings and
-- rules UI paths in src/lib/autopilot.js; service_role: all), rather
-- than inheriting whatever a dashboard session happened to leave behind.
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

grant select, insert, update on public.autopilot_settings to authenticated;
grant select, insert, update on public.autopilot_rules to authenticated;
grant select, insert, update, delete on public.autopilot_settings to service_role;
grant select, insert, update, delete on public.autopilot_rules to service_role;

-- Fail-closed shape assertion: column name/type/nullability/default must
-- match the verified live DDL exactly, and no extra or missing columns
-- may exist. information_schema renderings are the canonical comparison
-- form (data_type + column_default text).
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
begin
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

  if not exists (
    select 1 from pg_constraint k
    where k.conrelid = 'public.autopilot_settings'::regclass
      and k.contype = 'u'
      and k.conname = 'autopilot_settings_user_id_key'
  ) then
    raise exception 'autopilot_settings is missing unique(user_id) under its canonical name';
  end if;

  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'autopilot_settings'
      and p.policyname = 'autopilot_settings_own'
  ) or not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'autopilot_rules'
      and p.policyname = 'autopilot_rules_own'
  ) then
    raise exception 'autopilot canonical policies (autopilot_settings_own / autopilot_rules_own) are missing';
  end if;
end
$assert_autopilot_canonical$;
-- [SECTION: autopilot-canonical end]
