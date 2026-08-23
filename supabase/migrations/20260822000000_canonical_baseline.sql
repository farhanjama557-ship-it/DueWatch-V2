-- ============================================================================
-- DueWatch canonical baseline — the single active migration that constructs
-- the complete canonical pre-PR-B DueWatch database from an EMPTY Supabase
-- stack.
--
-- GENERATED FILE — do not edit by hand.
-- Regenerate with: bash supabase/convergence/assemble_canonical_baseline.sh
--
-- Provenance: assembled verbatim from the archived historical chain
-- (supabase/migrations_legacy/) plus the canonical Autopilot section
-- (supabase/convergence/sections/20260822000001_autopilot_canonical.sql).
-- The historical file 20260811000000_client_source_identities_tenant_fk.sql
-- is intentionally NOT part of this chain: it is the documented
-- non-replay-safe migration (its unknown-FK allowlist predates the import
-- tables), and its intended end-state is already created correctly by the
-- corrected 20260726000000. See migrations_legacy/README.md.
--
-- What this file is NOT:
--   * it does NOT converge a legacy production database — that is the
--     one-time, state-aware script supabase/convergence/
--     20260822_legacy_live_to_canonical.sql, which includes this baseline;
--   * it does NOT contain the event-origin architecture (PR B), Scheduled
--     Actions, or Promise-to-Pay.
--
-- Proofs (scripts/ci + supabase/convergence/checks):
--   * fresh `supabase db reset` constructs this schema and nothing else;
--   * the baseline is structurally equivalent to the CANONICAL INTENDED
--     HISTORICAL END-STATE (see below) under normalized structural
--     equivalence, ignoring catalog ids and ordering;
--   * legacy-like fixture + the convergence script reach the same state.
--
-- CANONICAL INTENDED HISTORICAL END-STATE means: the archived chain's
-- intended final schema — schema.sql plus every migration EXCEPT the
-- documented non-replay-safe 20260811000000, whose intended effect (the
-- composite tenant-safe FK on client_source_identities) is already
-- created from the start by the corrected 20260726000000, and whose
-- function-refresh is superseded by the later definition installed by
-- 20260803021842. It does NOT claim the broken chronological chain ever
-- ran to completion (it cannot — 20260811000000 raises when replayed
-- after the import tables exist).
-- ============================================================================

begin;

-- ============================================================================
-- [SOURCE: schema.sql]
-- ============================================================================
-- ============================================================
-- DueWatch — Supabase schema
-- Tables: profiles, clients, invoices, line_items
-- RLS: each user sees only their own data
-- Auto-provision a profile row on signup via trigger
-- Run this in the Supabase SQL editor.
-- ============================================================

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now()
);

-- ---------- clients ----------
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  email text,
  phone text,
  company text,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- invoices ----------
-- NOTE: matches the existing/validated table. There is no `status` column —
-- status is derived in the app from `paid` + `due_date`.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  inv_num text,
  amount numeric(12, 2) not null default 0,
  amount_paid numeric(12, 2) not null default 0,
  inv_date date,
  due_date date,
  notes text,
  paid boolean not null default false,
  last_reminder timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- line_items ----------
create table if not exists public.line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  description text not null,
  quantity numeric(12, 2) not null default 1,
  unit_price numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

-- Helpful indexes for per-user lookups.
create index if not exists clients_user_id_idx on public.clients (user_id);
create index if not exists invoices_user_id_idx on public.invoices (user_id);
create index if not exists invoices_client_id_idx on public.invoices (client_id);
create index if not exists line_items_invoice_id_idx on public.line_items (invoice_id);
create index if not exists line_items_user_id_idx on public.line_items (user_id);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.invoices enable row level security;
alter table public.line_items enable row level security;

-- ---------- profiles policies ----------
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- ---------- clients policies ----------
drop policy if exists "clients_all_own" on public.clients;
create policy "clients_all_own" on public.clients
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- invoices policies ----------
drop policy if exists "invoices_all_own" on public.invoices;
create policy "invoices_all_own" on public.invoices
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- line_items policies ----------
drop policy if exists "line_items_all_own" on public.line_items;
create policy "line_items_all_own" on public.line_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- Auto-provision a profile row when a new auth user signs up
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Session 2 additions: partial payments, last reminder, reminder events
-- (idempotent — safe to re-run)
-- ============================================================

-- Amount already collected against an invoice (for partial payment / balance due).
alter table public.invoices
  add column if not exists amount_paid numeric(12, 2) not null default 0;

-- Timestamp of the most recent reminder sent for this invoice.
alter table public.invoices
  add column if not exists last_reminder timestamptz;

-- Reminder / activity events shown in the invoice detail timeline.
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists reminders_invoice_id_idx on public.reminders (invoice_id);
create index if not exists reminders_user_id_idx on public.reminders (user_id);

alter table public.reminders enable row level security;

drop policy if exists "reminders_all_own" on public.reminders;
create policy "reminders_all_own" on public.reminders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- Usage events — fire-and-forget analytics of key actions
-- (invoice_created, reminder_opened, reminder_sent,
--  payment_recorded, invoice_marked_paid)
-- ============================================================
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_type text not null,
  invoice_id uuid references public.invoices (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists events_user_id_idx on public.events (user_id);
create index if not exists events_type_idx on public.events (event_type);

alter table public.events enable row level security;

drop policy if exists "events_all_own" on public.events;
create policy "events_all_own" on public.events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- Session 7 — Making Autopilot Real
-- ============================================================

-- Awaiting Signature: reminders Autopilot has drafted but not sent,
-- queued for the founder to approve, edit, or skip.
create table if not exists public.awaiting_signature (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  action_type text not null default 'send_reminder',
  recommended_tone text not null,
  draft_content text not null,
  ai_reason text not null,
  ai_context jsonb default '{}',
  status text not null default 'pending', -- pending | approved | rejected | skipped | expired
  founder_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (user_id, invoice_id, status)
);

create index if not exists awaiting_signature_user_status_idx on public.awaiting_signature (user_id, status);
create index if not exists awaiting_signature_created_idx on public.awaiting_signature (created_at desc);

alter table public.awaiting_signature enable row level security;

drop policy if exists "awaiting_signature_own" on public.awaiting_signature;
create policy "awaiting_signature_own" on public.awaiting_signature
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Autopilot run log: one row per scheduler cycle, including no-op runs.
-- This is what makes "Last checked X ago" trustworthy rather than decorative.
create table if not exists public.autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'running', -- running | completed | error
  invoices_checked integer not null default 0,
  reminders_drafted integer not null default 0,
  reminders_skipped integer not null default 0,
  errors integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists autopilot_runs_user_idx on public.autopilot_runs (user_id, started_at desc);

alter table public.autopilot_runs enable row level security;

drop policy if exists "autopilot_runs_own" on public.autopilot_runs;
create policy "autopilot_runs_own" on public.autopilot_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Lifecycle tracking on the existing events table (the engineering spec's
-- `activity_log` was named `events` in this project from Session 5 onward —
-- these alterations apply to the table that actually exists here).
alter table public.events add column if not exists lifecycle_stage text;
alter table public.events add column if not exists lifecycle_state text; -- completed | current | future | skipped | error | pending
alter table public.events add column if not exists previous_action_id uuid references public.events (id);
alter table public.events add column if not exists evidence jsonb default '{}';

create index if not exists events_lifecycle_idx on public.events (lifecycle_stage, lifecycle_state);

-- Session 7.5 build order #7 — per-invoice Autopilot toggle. Pausing a
-- single invoice must not affect any other invoice, so this lives on the
-- invoice row itself rather than in autopilot_settings/autopilot_rules.
alter table public.invoices add column if not exists autopilot_paused boolean not null default false;

-- ============================================================
-- Session 8 — Morning Brief / Pulse redesign
-- ============================================================

-- Last time the founder actually loaded the dashboard — the real baseline
-- "Since your last visit" diffs against (autopilot_runs.invoices_checked,
-- awaiting_signature.created_at) since the previous session.
alter table public.profiles add column if not exists last_seen_at timestamptz;

-- ============================================================================
-- [SOURCE: sections/20260822000001_autopilot_canonical.sql]
-- ============================================================================
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
         aclexplode(coalesce(c.relacl, '{}'::aclitem[])) as a(grantor, grantee, privilege_type, is_grantable)
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
  join pg_attribute a2 on a2.attrelid = c.oid and a2.attnum > 0 and not a2.attisdropped,
       aclexplode(coalesce(a2.attacl, '{}'::aclitem[])) as a(grantor, grantee, privilege_type, is_grantable)
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

-- ============================================================================
-- [SOURCE: 20260726000000_canonical_clients.sql]
-- ============================================================================
-- Phase 0: canonical client identity and reversible duplicate cleanup.
-- Applying this migration is non-destructive. Execution is disabled by
-- default and requires three independent gates plus a run-specific phrase.

create schema if not exists duewatch_ops;
revoke all on schema duewatch_ops from public, anon, authenticated;
grant usage on schema duewatch_ops to service_role;

create table if not exists duewatch_ops.client_dedup_config (
  singleton boolean primary key default true check (singleton),
  execution_enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  change_note text not null default 'Execution disabled by migration'
);
insert into duewatch_ops.client_dedup_config(singleton)
values (true) on conflict (singleton) do nothing;
revoke all on duewatch_ops.client_dedup_config from public, anon, authenticated;

create or replace function public.normalize_client_text(value text)
returns text language sql immutable parallel safe as $$
  select nullif(trim(regexp_replace(
    lower(coalesce(value, '')), '[^[:alnum:]]+', ' ', 'g'
  )), '')
$$;

create or replace function public.normalize_client_email(value text)
returns text language sql immutable parallel safe as $$
  select nullif(lower(trim(coalesce(value, ''))), '')
$$;

create or replace function public.normalize_client_phone(value text)
returns text language sql immutable parallel safe as $$
  select nullif(regexp_replace(coalesce(value, ''), '[^0-9]+', '', 'g'), '')
$$;

revoke execute on function public.normalize_client_text(text) from public, anon;
revoke execute on function public.normalize_client_email(text) from public, anon;
revoke execute on function public.normalize_client_phone(text) from public, anon;
grant execute on function public.normalize_client_text(text) to authenticated, service_role;
grant execute on function public.normalize_client_email(text) to authenticated, service_role;
grant execute on function public.normalize_client_phone(text) to authenticated, service_role;

alter table public.clients add column if not exists canonical_id uuid;
alter table public.clients add column if not exists normalized_name text;
alter table public.clients add column if not exists normalized_email text;
alter table public.clients add column if not exists normalized_domain text;
alter table public.clients add column if not exists normalized_phone text;
alter table public.clients add column if not exists normalized_company text;

update public.clients
set canonical_id = coalesce(canonical_id, id),
    normalized_name = public.normalize_client_text(name),
    normalized_email = public.normalize_client_email(email),
    normalized_domain = nullif(split_part(
      public.normalize_client_email(email), '@', 2
    ), ''),
    normalized_phone = public.normalize_client_phone(phone),
    normalized_company = public.normalize_client_text(company);

alter table public.clients alter column canonical_id set default gen_random_uuid();
alter table public.clients alter column canonical_id set not null;
create unique index if not exists clients_canonical_id_uidx
  on public.clients(canonical_id);
create index if not exists clients_normalized_name_idx
  on public.clients(user_id, normalized_name);
create index if not exists clients_normalized_email_idx
  on public.clients(user_id, normalized_email);
create index if not exists clients_normalized_phone_idx
  on public.clients(user_id, normalized_phone);

create or replace function public.set_client_identity_fields()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.canonical_id := coalesce(new.canonical_id, gen_random_uuid());
  new.normalized_name := public.normalize_client_text(new.name);
  new.normalized_email := public.normalize_client_email(new.email);
  new.normalized_domain := nullif(split_part(new.normalized_email, '@', 2), '');
  new.normalized_phone := public.normalize_client_phone(new.phone);
  new.normalized_company := public.normalize_client_text(new.company);
  return new;
end
$$;
revoke execute on function public.set_client_identity_fields() from public, anon, authenticated;

drop trigger if exists clients_set_identity_fields on public.clients;
create trigger clients_set_identity_fields
  before insert or update of name, email, phone, company, canonical_id
  on public.clients for each row execute function public.set_client_identity_fields();

-- PostgreSQL requires the referenced composite columns to be covered by a
-- non-partial unique index. clients.id remains the primary key, so this adds
-- no new identity semantics; it makes (user_id, id) a valid FK target. Also
-- (re)created, idempotently, by 20260803021842_enforce_invoice_client_tenant_
-- ownership.sql for the invoices FK — creating it here too, ahead of that
-- migration, is what lets client_source_identities be born with the same
-- tenant-safe FK shape on a fresh install instead of only gaining it later.
create unique index if not exists clients_user_id_id_uidx
  on public.clients(user_id, id);

-- A single-column client_id FK only proves the referenced client exists —
-- not that it belongs to the same tenant as user_id. An authenticated
-- caller could satisfy RLS's `auth.uid() = user_id` check while pointing
-- client_id at a different tenant's client, and PostgreSQL would accept it.
-- The composite FK below is the same tenant-ownership pattern already used
-- by invoices_user_id_client_id_fkey: it proves both that the client exists
-- and that it belongs to user_id, enforced for every role (including ones
-- that bypass RLS), not just the authenticated insert/update paths.
create table if not exists public.client_source_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  source text not null,
  external_id text not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, source, external_id),
  constraint client_source_identities_user_id_client_id_fkey
    foreign key (user_id, client_id)
    references public.clients(user_id, id)
    on update no action
    on delete cascade
);
create index if not exists client_source_identities_client_idx
  on public.client_source_identities(client_id);
alter table public.client_source_identities enable row level security;
drop policy if exists "client_source_identities_select_own"
  on public.client_source_identities;
create policy "client_source_identities_select_own"
  on public.client_source_identities for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- resolve_or_create_client() runs security invoker, so an authenticated
-- caller's own insert/upsert into this table is subject to RLS directly.
-- Table privileges already permit insert/update, but with RLS enabled and
-- only a select-own policy present, RLS denied every insert by default —
-- the hosted-staging failure on the source-identity path. These two
-- policies scope insert/update to the caller's own rows, matching the
-- select-own policy and the table's tenant-scoped
-- unique(user_id, source, external_id) constraint.
drop policy if exists "client_source_identities_insert_own"
  on public.client_source_identities;
create policy "client_source_identities_insert_own"
  on public.client_source_identities
  for insert
  to authenticated
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "client_source_identities_update_own"
  on public.client_source_identities;
create policy "client_source_identities_update_own"
  on public.client_source_identities
  for update
  to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
  with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant select on public.client_source_identities to authenticated;
grant select, insert, update, delete on public.client_source_identities to service_role;

insert into public.client_source_identities(
  user_id, client_id, source, external_id, provenance
)
select user_id, id, 'duewatch', id::text,
  jsonb_build_object(
    'kind', 'legacy_client_id',
    'backfilled_at', now(),
    'canonical_id', canonical_id
  )
from public.clients
on conflict(user_id, source, external_id) do update
set client_id = excluded.client_id,
    provenance = public.client_source_identities.provenance || excluded.provenance;

create table if not exists public.client_dedup_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'prepared' check (
    status in ('prepared', 'executing', 'completed', 'rolled_back', 'failed')
  ),
  summary jsonb not null default '{}'::jsonb,
  foreign_keys_verified_at timestamptz,
  foreign_key_evidence jsonb,
  integration_tests_passed_at timestamptz,
  integration_test_evidence jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  rolled_back_at timestamptz
);

create table if not exists public.client_merge_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.client_dedup_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Deliberately not foreign keys: audit/candidate IDs must survive deletion.
  primary_client_id uuid not null,
  duplicate_client_id uuid not null,
  classification text not null check (
    classification in ('exact', 'review_required')
  ),
  rule_code text not null,
  status text not null check (
    status in ('ready', 'review_required', 'approved', 'skipped', 'executed')
  ),
  evidence jsonb not null default '{}'::jsonb,
  affected_invoice_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique(run_id, primary_client_id, duplicate_client_id)
);

create table if not exists public.client_merge_audit (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.client_dedup_runs(id) on delete restrict,
  candidate_id uuid not null references public.client_merge_candidates(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary_client_id uuid not null,
  duplicate_client_id uuid not null,
  duplicate_snapshot jsonb not null,
  relationship_snapshot jsonb not null,
  executed_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  unique(run_id, duplicate_client_id)
);

create index if not exists client_dedup_runs_user_created_idx
  on public.client_dedup_runs(user_id, created_at desc);
create index if not exists client_merge_candidates_user_idx
  on public.client_merge_candidates(user_id);
create index if not exists client_merge_audit_user_idx
  on public.client_merge_audit(user_id);
create index if not exists client_merge_audit_candidate_idx
  on public.client_merge_audit(candidate_id);

alter table public.client_dedup_runs enable row level security;
alter table public.client_merge_candidates enable row level security;
alter table public.client_merge_audit enable row level security;

drop policy if exists "client_dedup_runs_select_own" on public.client_dedup_runs;
create policy "client_dedup_runs_select_own"
  on public.client_dedup_runs for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
drop policy if exists "client_merge_candidates_select_own"
  on public.client_merge_candidates;
create policy "client_merge_candidates_select_own"
  on public.client_merge_candidates for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);
drop policy if exists "client_merge_audit_select_own" on public.client_merge_audit;
create policy "client_merge_audit_select_own"
  on public.client_merge_audit for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

grant select on public.client_dedup_runs,
  public.client_merge_candidates, public.client_merge_audit to authenticated;
grant select, insert, update, delete on public.client_dedup_runs,
  public.client_merge_candidates, public.client_merge_audit to service_role;

-- Returns any FK touching clients/invoices that is not in the verified map.
create or replace function duewatch_ops.unknown_client_foreign_keys()
returns table(
  table_schema text,
  table_name text,
  column_name text,
  foreign_table_schema text,
  foreign_table_name text,
  foreign_column_name text,
  delete_rule text,
  update_rule text
) language sql security definer set search_path = pg_catalog, public as $$
  with relationships as (
    select
      tc.table_schema::text,
      tc.table_name::text,
      kcu.column_name::text,
      ccu.table_schema::text foreign_table_schema,
      ccu.table_name::text foreign_table_name,
      ccu.column_name::text foreign_column_name,
      rc.delete_rule::text,
      rc.update_rule::text
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
     and kcu.constraint_schema = tc.constraint_schema
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
     and ccu.constraint_schema = tc.constraint_schema
    join information_schema.referential_constraints rc
      on rc.constraint_name = tc.constraint_name
     and rc.constraint_schema = tc.constraint_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and (
        (ccu.table_schema = 'public'
          and ccu.table_name in ('clients', 'invoices'))
        or (tc.table_schema = 'public'
          and tc.table_name in ('clients', 'invoices'))
      )
  )
  select r.* from relationships r
  where (r.table_schema, r.table_name, r.column_name,
         r.foreign_table_schema, r.foreign_table_name, r.foreign_column_name,
         r.delete_rule, r.update_rule)
    not in (
      ('public','invoices','client_id','public','clients','id','SET NULL','NO ACTION'),
      ('public','client_source_identities','client_id','public','clients','id','CASCADE','NO ACTION'),
      ('public','line_items','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','reminders','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','events','invoice_id','public','invoices','id','SET NULL','NO ACTION'),
      ('public','awaiting_signature','invoice_id','public','invoices','id','CASCADE','NO ACTION')
    )
$$;
revoke execute on function duewatch_ops.unknown_client_foreign_keys()
  from public, anon, authenticated;
grant execute on function duewatch_ops.unknown_client_foreign_keys()
  to service_role;

create or replace function duewatch_ops.prepare_client_dedup(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run_id uuid := gen_random_uuid();
begin
  insert into public.client_dedup_runs(id, user_id) values(v_run_id, p_user_id);

  with pairs as (
    select
      older.id primary_id,
      older.created_at primary_created_at,
      newer.id duplicate_id,
      case
        when older.normalized_email is not null
         and older.normalized_email = newer.normalized_email
         and (
           (older.normalized_name is not null
             and older.normalized_name = newer.normalized_name)
           or (older.normalized_company is not null
             and older.normalized_company = newer.normalized_company)
         ) then 'email_with_name_or_company'
        when older.normalized_phone is not null
         and older.normalized_phone = newer.normalized_phone
         and (
           (older.normalized_name is not null
             and older.normalized_name = newer.normalized_name)
           or (older.normalized_company is not null
             and older.normalized_company = newer.normalized_company)
         ) then 'phone_with_name_or_company'
        when older.normalized_domain is not null
         and older.normalized_domain = newer.normalized_domain
         and older.normalized_company is not null
         and older.normalized_company = newer.normalized_company
          then 'domain_with_company'
        when older.normalized_email is not null
         and older.normalized_email = newer.normalized_email then 'email_only'
        when older.normalized_name is not null
         and older.normalized_name = newer.normalized_name then 'name_only'
        when older.normalized_phone is not null
         and older.normalized_phone = newer.normalized_phone then 'phone_only'
        when older.normalized_domain is not null
         and older.normalized_domain = newer.normalized_domain then 'domain_only'
      end rule_code
    from public.clients older
    join public.clients newer
      on newer.user_id = older.user_id
     and (older.created_at, older.id) < (newer.created_at, newer.id)
    where older.user_id = p_user_id
      and (
        (older.normalized_email is not null
          and older.normalized_email = newer.normalized_email)
        or (older.normalized_phone is not null
          and older.normalized_phone = newer.normalized_phone)
        or (older.normalized_name is not null
          and older.normalized_name = newer.normalized_name)
        or (older.normalized_domain is not null
          and older.normalized_domain = newer.normalized_domain)
      )
  ), ranked as (
    select *, row_number() over (
      partition by duplicate_id
      order by
        case rule_code
          when 'email_with_name_or_company' then 1
          when 'phone_with_name_or_company' then 10
          when 'domain_with_company' then 11
          when 'email_only' then 12
          when 'name_only' then 13
          when 'phone_only' then 14
          else 15
        end,
        primary_created_at,
        primary_id
    ) candidate_rank
    from pairs where rule_code is not null
  )
  insert into public.client_merge_candidates(
    run_id, user_id, primary_client_id, duplicate_client_id,
    classification, rule_code, status, evidence, affected_invoice_count
  )
  select
    v_run_id, p_user_id, r.primary_id, r.duplicate_id,
    case when r.rule_code = 'email_with_name_or_company'
      then 'exact' else 'review_required' end,
    r.rule_code,
    case when r.rule_code = 'email_with_name_or_company'
      then 'ready' else 'review_required' end,
    jsonb_build_object(
      'normalized', jsonb_build_object(
        'primary_name', a.normalized_name,
        'duplicate_name', b.normalized_name,
        'primary_email', a.normalized_email,
        'duplicate_email', b.normalized_email,
        'primary_phone', a.normalized_phone,
        'duplicate_phone', b.normalized_phone,
        'primary_company', a.normalized_company,
        'duplicate_company', b.normalized_company,
        'primary_domain', a.normalized_domain,
        'duplicate_domain', b.normalized_domain
      ),
      'raw', jsonb_build_object(
        'primary', jsonb_build_object(
          'name', a.name, 'email', a.email, 'phone', a.phone, 'company', a.company),
        'duplicate', jsonb_build_object(
          'name', b.name, 'email', b.email, 'phone', b.phone, 'company', b.company)
      )
    ),
    (select count(*) from public.invoices i where i.client_id = r.duplicate_id)
  from ranked r
  join public.clients a on a.id = r.primary_id
  join public.clients b on b.id = r.duplicate_id
  where r.candidate_rank = 1;

  update public.client_dedup_runs
  set summary = (
    select jsonb_build_object(
      'exact_matches', count(*) filter(where classification = 'exact'),
      'review_required', count(*) filter(where classification = 'review_required'),
      'skipped_records', count(*) filter(where status = 'skipped'),
      'affected_invoices', coalesce(sum(affected_invoice_count)
        filter(where classification = 'exact'), 0),
      'data_changed', false
    )
    from public.client_merge_candidates where run_id = v_run_id
  )
  where id = v_run_id;
  return v_run_id;
end
$$;

create or replace function duewatch_ops.attest_client_dedup_gate(
  p_run_id uuid,
  p_gate text,
  p_evidence jsonb,
  p_confirmation text
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_gate = 'foreign_keys' then
    if p_confirmation <> ('VERIFY FOREIGN KEYS ' || p_run_id::text) then
      raise exception 'Confirmation must be exactly: VERIFY FOREIGN KEYS %', p_run_id;
    end if;
    if coalesce(p_evidence->>'environment', '') <> 'staging'
      or coalesce(jsonb_typeof(p_evidence->'unknown_foreign_keys'), '') <> 'array'
      or coalesce(jsonb_array_length(p_evidence->'unknown_foreign_keys'), -1) <> 0
      or coalesce(jsonb_typeof(p_evidence->'missing_foreign_keys'), '') <> 'array'
      or coalesce(jsonb_array_length(p_evidence->'missing_foreign_keys'), -1) <> 0 then
      raise exception 'Foreign-key evidence must be a passing staging report';
    end if;
    update public.client_dedup_runs
    set foreign_keys_verified_at = now(), foreign_key_evidence = p_evidence
    where id = p_run_id and status = 'prepared';
  elsif p_gate = 'integration_tests' then
    if p_confirmation <> ('VERIFY INTEGRATION TESTS ' || p_run_id::text) then
      raise exception 'Confirmation must be exactly: VERIFY INTEGRATION TESTS %', p_run_id;
    end if;
    if coalesce((p_evidence->>'passed')::boolean, false) is not true
      or coalesce((p_evidence->>'transaction_rolled_back')::boolean, false) is not true then
      raise exception 'Integration-test evidence must report pass and rollback';
    end if;
    update public.client_dedup_runs
    set integration_tests_passed_at = now(), integration_test_evidence = p_evidence
    where id = p_run_id and status = 'prepared';
  else
    raise exception 'Unknown gate: %', p_gate;
  end if;
  if not found then raise exception 'Prepared run not found'; end if;
end
$$;

create or replace function duewatch_ops.execute_client_dedup(
  p_run_id uuid,
  p_confirmation text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run public.client_dedup_runs%rowtype;
  c public.client_merge_candidates%rowtype;
  d public.clients%rowtype;
  v_invoice_ids jsonb;
  v_merged integer := 0;
begin
  if not exists (
    select 1 from duewatch_ops.client_dedup_config
    where singleton and execution_enabled
  ) then
    raise exception 'Client dedup execution is disabled';
  end if;
  if exists(select 1 from duewatch_ops.unknown_client_foreign_keys()) then
    raise exception 'Unknown client/invoice foreign keys exist; execution blocked';
  end if;

  select * into v_run from public.client_dedup_runs
  where id = p_run_id for update;
  if not found or v_run.status <> 'prepared' then
    raise exception 'Run is missing or not prepared';
  end if;
  if v_run.foreign_keys_verified_at is null then
    raise exception 'Staging foreign-key verification has not passed';
  end if;
  if v_run.integration_tests_passed_at is null then
    raise exception 'Integration tests have not passed';
  end if;
  if p_confirmation <> ('EXECUTE ' || p_run_id::text) then
    raise exception 'Confirmation must be exactly: EXECUTE %', p_run_id;
  end if;

  update public.client_dedup_runs set status = 'executing' where id = p_run_id;
  for c in
    select mc.* from public.client_merge_candidates mc
    join public.clients dup on dup.id = mc.duplicate_client_id
    where mc.run_id = p_run_id
      and mc.classification = 'exact'
      and mc.rule_code = 'email_with_name_or_company'
      and mc.status in ('ready', 'approved')
    order by dup.created_at desc, dup.id desc
  loop
    select * into d from public.clients
    where id = c.duplicate_client_id for update;
    if not found then
      update public.client_merge_candidates set status = 'skipped' where id = c.id;
      continue;
    end if;

    select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
    into v_invoice_ids from public.invoices where client_id = d.id;
    insert into public.client_merge_audit(
      run_id, candidate_id, user_id, primary_client_id, duplicate_client_id,
      duplicate_snapshot, relationship_snapshot
    ) values (
      p_run_id, c.id, c.user_id, c.primary_client_id, c.duplicate_client_id,
      to_jsonb(d),
      jsonb_build_object(
        'invoice_ids', v_invoice_ids,
        'source_identity_ids', (
          select coalesce(jsonb_agg(id order by id), '[]'::jsonb)
          from public.client_source_identities where client_id = d.id
        ),
        'invoice_count', jsonb_array_length(v_invoice_ids),
        'line_item_count', (select count(*) from public.line_items li
          join public.invoices i on i.id = li.invoice_id where i.client_id = d.id),
        'reminder_count', (select count(*) from public.reminders r
          join public.invoices i on i.id = r.invoice_id where i.client_id = d.id),
        'activity_count', (select count(*) from public.events e
          join public.invoices i on i.id = e.invoice_id where i.client_id = d.id),
        'evidence_count', (select count(*) from public.events e
          join public.invoices i on i.id = e.invoice_id
          where i.client_id = d.id and e.evidence is not null),
        'approval_count', (select count(*) from public.awaiting_signature a
          join public.invoices i on i.id = a.invoice_id where i.client_id = d.id)
      )
    );

    update public.invoices set client_id = c.primary_client_id
    where client_id = d.id;
    update public.client_source_identities set client_id = c.primary_client_id
    where client_id = d.id;
    delete from public.clients where id = d.id;
    update public.client_merge_candidates set status = 'executed' where id = c.id;
    v_merged := v_merged + 1;
  end loop;

  update public.client_dedup_runs
  set status = 'completed', executed_at = now(),
      summary = summary || jsonb_build_object('merged_clients', v_merged)
  where id = p_run_id;
  return jsonb_build_object('run_id', p_run_id, 'merged_clients', v_merged);
exception when others then
  update public.client_dedup_runs set status = 'failed'
  where id = p_run_id and status = 'executing';
  raise;
end
$$;

create or replace function duewatch_ops.rollback_client_dedup(
  p_run_id uuid,
  p_confirmation text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.client_merge_audit%rowtype;
  v_restored integer := 0;
begin
  if p_confirmation <> ('ROLLBACK ' || p_run_id::text) then
    raise exception 'Confirmation must be exactly: ROLLBACK %', p_run_id;
  end if;
  if not exists(select 1 from public.client_dedup_runs
    where id = p_run_id and status = 'completed') then
    raise exception 'Only a completed run can be rolled back';
  end if;

  for a in select * from public.client_merge_audit
    where run_id = p_run_id and rolled_back_at is null
    order by executed_at desc, id desc
  loop
    insert into public.clients(
      id, user_id, name, email, phone, company, notes, created_at, canonical_id
    ) values (
      (a.duplicate_snapshot->>'id')::uuid,
      (a.duplicate_snapshot->>'user_id')::uuid,
      a.duplicate_snapshot->>'name',
      nullif(a.duplicate_snapshot->>'email', ''),
      nullif(a.duplicate_snapshot->>'phone', ''),
      nullif(a.duplicate_snapshot->>'company', ''),
      nullif(a.duplicate_snapshot->>'notes', ''),
      (a.duplicate_snapshot->>'created_at')::timestamptz,
      (a.duplicate_snapshot->>'canonical_id')::uuid
    ) on conflict(id) do nothing;

    update public.invoices set client_id = a.duplicate_client_id
    where id in (
      select jsonb_array_elements_text(
        a.relationship_snapshot->'invoice_ids'
      )::uuid
    );
    update public.client_source_identities set client_id = a.duplicate_client_id
    where id in (
      select jsonb_array_elements_text(
        a.relationship_snapshot->'source_identity_ids'
      )::uuid
    );
    update public.client_merge_audit set rolled_back_at = now() where id = a.id;
    v_restored := v_restored + 1;
  end loop;

  update public.client_dedup_runs
  set status = 'rolled_back', rolled_back_at = now() where id = p_run_id;
  return jsonb_build_object('run_id', p_run_id, 'restored_clients', v_restored);
end
$$;

revoke execute on function duewatch_ops.prepare_client_dedup(uuid)
  from public, anon, authenticated;
revoke execute on function duewatch_ops.attest_client_dedup_gate(uuid,text,jsonb,text)
  from public, anon, authenticated;
revoke execute on function duewatch_ops.execute_client_dedup(uuid,text)
  from public, anon, authenticated;
revoke execute on function duewatch_ops.rollback_client_dedup(uuid,text)
  from public, anon, authenticated;
grant execute on function duewatch_ops.prepare_client_dedup(uuid),
  duewatch_ops.attest_client_dedup_gate(uuid,text,jsonb,text),
  duewatch_ops.execute_client_dedup(uuid,text),
  duewatch_ops.rollback_client_dedup(uuid,text) to service_role;

-- Service-role-only public wrappers for the non-browser operator script.
create or replace function public.admin_prepare_client_dedup(p_user_id uuid)
returns uuid language sql security invoker set search_path = public as $$
  select duewatch_ops.prepare_client_dedup(p_user_id)
$$;
create or replace function public.admin_attest_client_dedup_gate(
  p_run_id uuid, p_gate text, p_evidence jsonb, p_confirmation text
) returns void language sql security invoker set search_path = public as $$
  select duewatch_ops.attest_client_dedup_gate(
    p_run_id, p_gate, p_evidence, p_confirmation
  )
$$;
create or replace function public.admin_execute_client_dedup(
  p_run_id uuid, p_confirmation text
) returns jsonb language sql security invoker set search_path = public as $$
  select duewatch_ops.execute_client_dedup(p_run_id, p_confirmation)
$$;
create or replace function public.admin_rollback_client_dedup(
  p_run_id uuid, p_confirmation text
) returns jsonb language sql security invoker set search_path = public as $$
  select duewatch_ops.rollback_client_dedup(p_run_id, p_confirmation)
$$;

revoke execute on function public.admin_prepare_client_dedup(uuid)
  from public, anon, authenticated;
revoke execute on function public.admin_attest_client_dedup_gate(uuid,text,jsonb,text)
  from public, anon, authenticated;
revoke execute on function public.admin_execute_client_dedup(uuid,text)
  from public, anon, authenticated;
revoke execute on function public.admin_rollback_client_dedup(uuid,text)
  from public, anon, authenticated;
grant execute on function public.admin_prepare_client_dedup(uuid),
  public.admin_attest_client_dedup_gate(uuid,text,jsonb,text),
  public.admin_execute_client_dedup(uuid,text),
  public.admin_rollback_client_dedup(uuid,text) to service_role;

-- Browser-safe creation path. The invoice modal calls this instead of a
-- race-prone cached lookup followed by a direct insert.
create or replace function public.resolve_or_create_client(
  p_user_id uuid,
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_company text default null,
  p_source text default null,
  p_external_id text default null,
  p_provenance jsonb default '{}'::jsonb
) returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_count integer;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user_id then
    raise exception 'Cannot resolve a client for another user';
  end if;
  if public.normalize_client_text(p_name) is null then
    raise exception 'Client name is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_user_id::text || ':' || coalesce(
      public.normalize_client_email(p_email),
      public.normalize_client_phone(p_phone),
      public.normalize_client_text(p_name)
    ), 0
  ));

  if p_source is not null and p_external_id is not null then
    select client_id into v_id from public.client_source_identities
    where user_id = p_user_id and source = lower(trim(p_source))
      and external_id = trim(p_external_id);
    if found then return v_id; end if;
  end if;

  select count(*) into v_count from public.clients
  where user_id = p_user_id and (
    (
      public.normalize_client_email(p_email) is not null
      and normalized_email = public.normalize_client_email(p_email)
      and (
        normalized_name = public.normalize_client_text(p_name)
        or (
          public.normalize_client_text(p_company) is not null
          and normalized_company = public.normalize_client_text(p_company)
        )
      )
    )
    or (
      p_email is null and p_phone is null and p_company is null
      and normalized_name = public.normalize_client_text(p_name)
    )
  );

  if v_count > 1 then
    raise exception 'Ambiguous client identity; select a client explicitly';
  elsif v_count = 0 then
    insert into public.clients(user_id, name, email, phone, company)
    values(p_user_id, trim(p_name), p_email, p_phone, p_company)
    returning id into v_id;
  else
    select id into v_id from public.clients
    where user_id = p_user_id and (
      (
        public.normalize_client_email(p_email) is not null
        and normalized_email = public.normalize_client_email(p_email)
        and (
          normalized_name = public.normalize_client_text(p_name)
          or (
            public.normalize_client_text(p_company) is not null
            and normalized_company = public.normalize_client_text(p_company)
          )
        )
      )
      or (
        p_email is null and p_phone is null and p_company is null
        and normalized_name = public.normalize_client_text(p_name)
      )
    )
    limit 1;
  end if;

  if p_source is not null and p_external_id is not null then
    insert into public.client_source_identities(
      user_id, client_id, source, external_id, provenance
    ) values (
      p_user_id, v_id, lower(trim(p_source)), trim(p_external_id), p_provenance
    ) on conflict(user_id, source, external_id) do update
      set provenance = public.client_source_identities.provenance
        || excluded.provenance;
  end if;
  return v_id;
end
$$;
revoke execute on function public.resolve_or_create_client(
  uuid,text,text,text,text,text,text,jsonb
) from public, anon;
grant execute on function public.resolve_or_create_client(
  uuid,text,text,text,text,text,text,jsonb
) to authenticated, service_role;

-- ============================================================================
-- [SOURCE: 20260803021842_enforce_invoice_client_tenant_ownership.sql]
-- ============================================================================
-- Enforce tenant ownership for every invoice/client relationship.
--
-- The existing single-column FK proves only that client_id exists. This
-- composite FK also proves that the invoice and client belong to the same
-- user. It applies to every database role, including roles that bypass RLS.

do $preflight$
begin
  if exists (
    select 1
    from public.invoices i
    join public.clients c on c.id = i.client_id
    where i.client_id is not null
      and i.user_id <> c.user_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot enforce invoice/client tenant ownership: cross-tenant relationships exist';
  end if;
end
$preflight$;

-- PostgreSQL requires the referenced composite columns to be covered by a
-- non-partial unique index. clients.id remains the primary key, so this adds
-- no new identity semantics; it makes (user_id, id) a valid FK target.
create unique index if not exists clients_user_id_id_uidx
  on public.clients(user_id, id);

do $constraint$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and conname = 'invoices_user_id_client_id_fkey'
      and contype = 'f'
  ) then
    alter table public.invoices
      add constraint invoices_user_id_client_id_fkey
      foreign key (user_id, client_id)
      references public.clients(user_id, id)
      on update no action
      on delete set null (client_id)
      not valid;
  end if;
end
$constraint$;

alter table public.invoices
  validate constraint invoices_user_id_client_id_fkey;

-- Remove only the repository's superseded FK shape, regardless of its name.
-- The new composite constraint stays in place throughout this step.
do $drop_single_column_fks$
declare
  v_constraint record;
  v_client_id_attnum smallint;
  v_client_pk_attnum smallint;
begin
  select attnum into v_client_id_attnum
  from pg_attribute
  where attrelid = 'public.invoices'::regclass and attname = 'client_id';

  select attnum into v_client_pk_attnum
  from pg_attribute
  where attrelid = 'public.clients'::regclass and attname = 'id';

  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.invoices'::regclass
      and confrelid = 'public.clients'::regclass
      and contype = 'f'
      and conkey = array[v_client_id_attnum]::smallint[]
      and confkey = array[v_client_pk_attnum]::smallint[]
  loop
    execute format(
      'alter table public.invoices drop constraint %I',
      v_constraint.conname
    );
  end loop;
end
$drop_single_column_fks$;

-- Refresh the Phase 0 unknown-FK gate so it pairs composite FK columns by
-- ordinal position instead of producing a Cartesian product through
-- information_schema.constraint_column_usage.
create or replace function duewatch_ops.unknown_client_foreign_keys()
returns table(
  table_schema text,
  table_name text,
  column_name text,
  foreign_table_schema text,
  foreign_table_name text,
  foreign_column_name text,
  delete_rule text,
  update_rule text
) language sql security definer set search_path = pg_catalog, public as $$
  with relationships as (
    select
      child_ns.nspname::text as table_schema,
      child.relname::text as table_name,
      child_col.attname::text as column_name,
      parent_ns.nspname::text as foreign_table_schema,
      parent.relname::text as foreign_table_name,
      parent_col.attname::text as foreign_column_name,
      case fk.confdeltype
        when 'a' then 'NO ACTION'
        when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE'
        when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
      end::text as delete_rule,
      case fk.confupdtype
        when 'a' then 'NO ACTION'
        when 'r' then 'RESTRICT'
        when 'c' then 'CASCADE'
        when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
      end::text as update_rule
    from pg_constraint fk
    join pg_class child on child.oid = fk.conrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_class parent on parent.oid = fk.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    join lateral unnest(fk.conkey) with ordinality child_key(attnum, ord) on true
    join lateral unnest(fk.confkey) with ordinality parent_key(attnum, ord)
      on parent_key.ord = child_key.ord
    join pg_attribute child_col
      on child_col.attrelid = child.oid and child_col.attnum = child_key.attnum
    join pg_attribute parent_col
      on parent_col.attrelid = parent.oid and parent_col.attnum = parent_key.attnum
    where fk.contype = 'f'
      -- Phase 0 mutates client rows and invoice.client_id. Only foreign keys
      -- whose referenced table is clients/invoices can be affected by those
      -- operations; the separate auth.users ownership FKs are out of scope.
      and parent_ns.nspname = 'public'
      and parent.relname in ('clients', 'invoices')
  )
  select r.* from relationships r
  where (r.table_schema, r.table_name, r.column_name,
         r.foreign_table_schema, r.foreign_table_name, r.foreign_column_name,
         r.delete_rule, r.update_rule)
    not in (
      ('public','invoices','user_id','public','clients','user_id','SET NULL','NO ACTION'),
      ('public','invoices','client_id','public','clients','id','SET NULL','NO ACTION'),
      -- client_source_identities' single-column client_id FK below was
      -- superseded by a composite (user_id, client_id) tenant-safe FK, the
      -- same pattern as invoices above (see
      -- 20260811000000_client_source_identities_tenant_fk.sql). Kept
      -- current here too, not just in that later migration: on a fresh
      -- install 20260726000000_canonical_clients.sql now creates
      -- client_source_identities with the composite FK from the start, so
      -- by the time this migration's own postcondition check below runs
      -- (immediately after this function is (re)defined), the table
      -- already has the composite shape and needs it in the allowlist -
      -- an already-migrated environment still gets this update for real
      -- via the later forward migration re-defining this same function,
      -- since Supabase does not re-run an already-applied migration file.
      ('public','client_source_identities','user_id','public','clients','user_id','CASCADE','NO ACTION'),
      ('public','client_source_identities','client_id','public','clients','id','CASCADE','NO ACTION'),
      ('public','line_items','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','reminders','invoice_id','public','invoices','id','CASCADE','NO ACTION'),
      ('public','events','invoice_id','public','invoices','id','SET NULL','NO ACTION'),
      ('public','awaiting_signature','invoice_id','public','invoices','id','CASCADE','NO ACTION')
    )
$$;
revoke execute on function duewatch_ops.unknown_client_foreign_keys()
  from public, anon, authenticated;
grant execute on function duewatch_ops.unknown_client_foreign_keys()
  to service_role;

do $postconditions$
declare
  v_definition text;
begin
  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.invoices'::regclass
    and conname = 'invoices_user_id_client_id_fkey'
    and contype = 'f';

  if v_definition is null
    or v_definition not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_definition not like '%ON DELETE SET NULL (client_id)%' then
    raise exception 'Invoice/client tenant constraint does not match the required definition';
  end if;

  if exists(select 1 from duewatch_ops.unknown_client_foreign_keys()) then
    raise exception 'Invoice/client tenant migration left an unknown client/invoice FK';
  end if;

  if (select execution_enabled
      from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$postconditions$;

-- ============================================================================
-- [SOURCE: 20260803150000_import_persistence_core.sql]
-- ============================================================================
-- Phase 1.5B Checkpoint 1: safe, server-authoritative import persistence
-- core. Takes normalized, eligible importer rows and persists canonical
-- clients and invoices in bounded batches with durable, truthful outcomes.
--
-- Revised after independent review (see DUEWATCH_CONTEXT_LOG.md) to fix:
-- row-vs-batch exception classification and SQLERRM exposure, missing
-- server-side input bounds, incomplete server-authoritative eligibility
-- (date/amount/currency/status/paid-consistency, ready-with-issues
-- contradiction, warning acknowledgement), weak-client-identity auto-
-- persistence, a matched-vs-created bug on source-identity retries, a
-- missing durable invoice-source-identity/conflict contract, silently
-- dropped material fields (currency/payment_date/source_system/
-- source_invoice_id), a SELECT-then-INSERT race in run idempotency,
-- progress counts that didn't include runtime-blocked rows, and missing
-- tenant-safe composite FKs across the full import graph.
--
-- Architecture (preserving PR #22's Architecture B):
--   - public.resolve_or_create_client(...)'s signature and matching policy
--     are UNCHANGED. This migration adds a companion wrapper,
--     duewatch_ops.resolve_client_for_import(...), that determines
--     matched-vs-created truthfully under the SAME advisory lock the
--     resolver itself takes internally, without reimplementing or
--     duplicating any matching rule. See that function's own comment for
--     exactly how it avoids a race without touching the resolver.
--   - Every new function below follows the two conventions already
--     established in this repository, combined: internal orchestration
--     functions live in `duewatch_ops` (mirroring PR #22's
--     prepare/execute/rollback functions), but the entry points a
--     founder's own browser session calls are SECURITY DEFINER, granted
--     to `authenticated`, and independently re-check `auth.uid() =
--     p_user_id` inside the function body — the exact pattern
--     `public.resolve_or_create_client` itself already uses. This lets the
--     browser drive batch persistence directly (as it already does for
--     ordinary invoice creation) without granting `authenticated` direct
--     write access to any of these tables.
--   - Every new table is tenant-owned, RLS-enabled, `authenticated`-select-
--     only (writes happen only inside the SECURITY DEFINER functions,
--     never via direct grants) — mirroring PR #22's
--     client_dedup_runs/client_merge_candidates/client_merge_audit tables
--     exactly.
--
-- Scope (Checkpoint 1 only): eligibility revalidation, idempotent batched
-- persistence, minimum recovery mechanics (retry, cancellation, failed-
-- batch rollback, refresh reconstruction). No UI polish, no animations, no
-- AI, no saved mappings, no fuzzy matching — see DUEWATCH_CONTEXT_LOG.md's
-- 2026-08-03 entry for the full deferral list.

-- ============================================================
-- Server-side mirror of the eligibility allowlist
-- ============================================================
-- The browser's own preview outcome/issue codes are never authoritative —
-- this table is this migration's own independent copy of exactly which
-- issue codes block import, verified by reading every makeIssue() call
-- site in src/lib/import/normalize.js (see the identical comment and table
-- in src/lib/importPersistence/eligibility.js, which both derive from the
-- same audit so neither module trusts the other).
create schema if not exists duewatch_ops;

create table if not exists duewatch_ops.import_issue_codes (
  code text primary key,
  blocks_import boolean not null
);
revoke all on duewatch_ops.import_issue_codes from public, anon, authenticated;

insert into duewatch_ops.import_issue_codes(code, blocks_import) values
  ('EMPTY_FILE', true),
  ('HEADERS_ONLY', true),
  ('DUPLICATE_HEADER', true),
  ('MALFORMED_FILE', true),
  ('MISSING_REQUIRED_MAPPING', true),
  ('MISSING_REQUIRED_VALUE', true),
  ('INVALID_AMOUNT', true),
  ('AMBIGUOUS_AMOUNT_FORMAT', true),
  ('INVALID_DATE', true),
  ('AMBIGUOUS_DATE_FORMAT', true),
  ('MIXED_DATE_FORMATS', true),
  ('UNKNOWN_STATUS', true),
  ('PAID_WITHOUT_PAYMENT_DATE', false),
  ('AMOUNT_PAID_EXCEEDS_AMOUNT', true),
  ('PARTIAL_PAYMENT_REVIEW', true),
  ('DUPLICATE_IN_UPLOAD', true),
  ('DUPLICATE_DETECTION_INCOMPLETE', false),
  ('FORMULA_VALUE_UNAVAILABLE', false),
  ('FORMULA_CACHED_VALUE_USED', false),
  ('UNSUPPORTED_CURRENCY', true),
  ('CURRENCY_DECISION_REQUIRED', true),
  ('ROW_COLUMN_COUNT_MISMATCH', false),
  ('FILE_TOO_LARGE', true),
  ('ROW_LIMIT_EXCEEDED', true)
on conflict (code) do update set blocks_import = excluded.blocks_import;

create table if not exists duewatch_ops.import_approved_warning_codes (
  code text primary key references duewatch_ops.import_issue_codes(code)
);
revoke all on duewatch_ops.import_approved_warning_codes from public, anon, authenticated;

insert into duewatch_ops.import_approved_warning_codes(code) values
  ('DUPLICATE_DETECTION_INCOMPLETE'),
  ('FORMULA_CACHED_VALUE_USED'),
  ('FORMULA_VALUE_UNAVAILABLE'),
  ('PAID_WITHOUT_PAYMENT_DATE'),
  ('ROW_COLUMN_COUNT_MISMATCH')
on conflict (code) do nothing;

-- Mirrors src/lib/import/fields.js's STATUS_VALUES and
-- src/lib/import/money.js's SUPPORTED_CURRENCIES — local copies for the
-- same independent-auditability reason the issue-code table above is a
-- local copy, not a reference into the importer engine.
create table if not exists duewatch_ops.import_status_values (
  value text primary key
);
revoke all on duewatch_ops.import_status_values from public, anon, authenticated;
insert into duewatch_ops.import_status_values(value) values
  ('draft'), ('sent'), ('paid'), ('partial'), ('overdue'), ('void')
on conflict (value) do nothing;

create table if not exists duewatch_ops.import_supported_currencies (
  code text primary key
);
revoke all on duewatch_ops.import_supported_currencies from public, anon, authenticated;
insert into duewatch_ops.import_supported_currencies(code) values
  ('USD'), ('CAD'), ('GBP'), ('EUR'), ('AUD'), ('NZD')
on conflict (code) do nothing;

-- Server-side eligibility re-evaluation. `stable` (not `immutable`) because
-- it reads from the lookup tables above, whose contents this function
-- depends on. Mirrors src/lib/importPersistence/eligibility.js's
-- evaluateRowEligibility() field-for-field. p_warnings_acknowledged is a
-- REQUEST-level fact (see start_import_run) — a single row can never
-- assert its own acknowledgement.
drop function if exists duewatch_ops.evaluate_row_eligibility(text, text[], jsonb);
create or replace function duewatch_ops.evaluate_row_eligibility(
  p_outcome text,
  p_issue_codes text[],
  p_normalized jsonb,
  p_warnings_acknowledged boolean
) returns table(eligible boolean, reason_code text)
language plpgsql stable security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_code text;
  v_blocks boolean;
  v_approved boolean;
  v_amount numeric(12, 2);
  v_amount_paid numeric(12, 2);
  v_status text;
  v_has_source_identity boolean;
  v_has_email_identity boolean;
  v_ok boolean;
begin
  if p_outcome is null or p_outcome not in ('ready', 'ready_with_warnings') then
    if p_outcome = 'review_required' then
      return query select false, 'REVIEW_REQUIRED'; return;
    elsif p_outcome = 'rejected' then
      return query select false, 'REJECTED'; return;
    else
      return query select false, 'UNKNOWN_OUTCOME'; return;
    end if;
  end if;

  -- A genuine 'ready' outcome never carries any issue at all (see
  -- normalize.js's computeOutcome: issues.length > 0 always yields
  -- 'ready_with_warnings'). A row claiming 'ready' while carrying ANY
  -- issue code is internally contradictory.
  if p_outcome = 'ready' and coalesce(array_length(p_issue_codes, 1), 0) > 0 then
    return query select false, 'OUTCOME_ISSUE_MISMATCH'; return;
  end if;

  if p_issue_codes is not null then
    foreach v_code in array p_issue_codes loop
      select ic.blocks_import into v_blocks
      from duewatch_ops.import_issue_codes ic where ic.code = v_code;

      if v_blocks is null then
        return query select false, 'UNKNOWN_ISSUE_CODE'; return;
      end if;
      if v_blocks then
        return query select false, 'BLOCKING_ISSUE_ON_ELIGIBLE_OUTCOME'; return;
      end if;
      select exists(
        select 1 from duewatch_ops.import_approved_warning_codes w where w.code = v_code
      ) into v_approved;
      if not v_approved then
        return query select false, 'UNAPPROVED_WARNING_CODE'; return;
      end if;
    end loop;
  end if;

  if p_outcome = 'ready_with_warnings'
     and coalesce(array_length(p_issue_codes, 1), 0) > 0
     and not coalesce(p_warnings_acknowledged, false) then
    return query select false, 'WARNINGS_NOT_ACKNOWLEDGED'; return;
  end if;

  if coalesce(trim(p_normalized->>'invoice_number'), '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;
  if coalesce(p_normalized->>'invoice_date', '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;
  if coalesce(p_normalized->>'amount', '') = '' then
    return query select false, 'MISSING_MATERIAL_FIELD'; return;
  end if;

  if p_normalized->>'invoice_date' !~ '^\d{4}-\d{2}-\d{2}$' then
    return query select false, 'INVALID_DATE_VALUE'; return;
  end if;
  begin
    perform (p_normalized->>'invoice_date')::date;
  exception when others then
    return query select false, 'INVALID_DATE_VALUE'; return;
  end;
  if coalesce(p_normalized->>'due_date', '') <> '' then
    if p_normalized->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end if;
    begin
      perform (p_normalized->>'due_date')::date;
    exception when others then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end;
  end if;
  if coalesce(p_normalized->>'payment_date', '') <> '' then
    if p_normalized->>'payment_date' !~ '^\d{4}-\d{2}-\d{2}$' then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end if;
    begin
      perform (p_normalized->>'payment_date')::date;
    exception when others then
      return query select false, 'INVALID_DATE_VALUE'; return;
    end;
  end if;

  if p_normalized->>'amount' !~ '^-?\d{1,10}\.\d{2}$' then
    return query select false, 'INVALID_AMOUNT_VALUE'; return;
  end if;
  v_amount := (p_normalized->>'amount')::numeric(12, 2);
  if v_amount <= 0 then
    return query select false, 'NON_POSITIVE_AMOUNT'; return;
  end if;

  if coalesce(p_normalized->>'currency', '') <> '' then
    select exists(
      select 1 from duewatch_ops.import_supported_currencies c where c.code = p_normalized->>'currency'
    ) into v_ok;
    if not v_ok then
      return query select false, 'UNSUPPORTED_CURRENCY'; return;
    end if;
  end if;

  v_amount_paid := null;
  if coalesce(p_normalized->>'amount_paid', '') <> '' then
    if p_normalized->>'amount_paid' !~ '^-?\d{1,10}\.\d{2}$' then
      return query select false, 'INVALID_AMOUNT_PAID_VALUE'; return;
    end if;
    v_amount_paid := (p_normalized->>'amount_paid')::numeric(12, 2);
    if v_amount_paid < 0 or v_amount_paid > v_amount then
      return query select false, 'AMOUNT_PAID_OUT_OF_RANGE'; return;
    end if;
  end if;

  v_status := p_normalized->>'status';
  if coalesce(v_status, '') <> '' then
    if v_status = 'void' then
      return query select false, 'UNSUPPORTED_STATUS_VALUE'; return;
    end if;
    select exists(select 1 from duewatch_ops.import_status_values s where s.value = v_status) into v_ok;
    if not v_ok then
      return query select false, 'UNKNOWN_STATUS_VALUE'; return;
    end if;
    if v_status = 'paid' and v_amount_paid is not null and v_amount_paid <> v_amount then
      return query select false, 'PAID_STATUS_AMOUNT_MISMATCH'; return;
    end if;
  end if;

  -- Strong client identity only (see this migration's client-identity
  -- comment on resolve_client_for_import): company/name-only or name-only
  -- identity is not retry-safe automatic identity and must never
  -- auto-persist. Required: EITHER source_system + source_client_id, OR a
  -- present client_email.
  v_has_source_identity :=
    coalesce(trim(p_normalized->>'source_system'), '') <> ''
    and coalesce(trim(p_normalized->>'source_client_id'), '') <> '';
  v_has_email_identity := coalesce(trim(p_normalized->>'client_email'), '') <> '';
  if not v_has_source_identity and not v_has_email_identity then
    return query select false, 'WEAK_CLIENT_IDENTITY'; return;
  end if;

  return query select true, null::text;
end
$$;
revoke execute on function duewatch_ops.evaluate_row_eligibility(text, text[], jsonb, boolean)
  from public, anon, authenticated;
grant execute on function duewatch_ops.evaluate_row_eligibility(text, text[], jsonb, boolean)
  to service_role;

-- ============================================================
-- Tables
-- ============================================================

create table if not exists public.import_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  -- Hash of the exact logical request (rows + acknowledgement flag) that
  -- created this run (see start_import_run). A retry with the SAME
  -- idempotency_key must submit the SAME request; a mismatch fails closed
  -- rather than silently returning a run whose stored rows don't match
  -- what the caller just sent.
  request_payload_hash text not null,
  warnings_acknowledged boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'partially_completed', 'failed', 'cancelled')),
  total_rows integer not null default 0,
  eligible_rows integer not null default 0,
  blocked_rows integer not null default 0,
  next_batch_index integer not null default 0,
  cancel_requested_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique(user_id, idempotency_key),
  -- Tenant-safe composite FK target for import_batches/import_rows below.
  unique(user_id, id)
);
create index if not exists import_runs_user_idx on public.import_runs(user_id, created_at desc);

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_index integer not null,
  status text not null check (status in ('in_progress', 'committed', 'failed')),
  row_count integer not null default 0,
  -- Customer-facing, sanitized: never raw SQLERRM (may contain schema,
  -- column, or data-derived text). See internal_diagnostic below for the
  -- operator-only counterpart.
  failure_reason text,
  -- Raw diagnostic detail for unexpected failures, never granted to
  -- `authenticated` (see the column-scoped GRANT below) — operator/
  -- service_role visibility only, alongside a `raise log` at the point of
  -- failure.
  internal_diagnostic text,
  created_at timestamptz not null default now(),
  unique(run_id, batch_index),
  unique(user_id, id),
  foreign key (user_id, run_id) references public.import_runs(user_id, id) on delete cascade
);
create index if not exists import_batches_run_idx on public.import_batches(run_id, batch_index);

create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  batch_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  row_number integer not null,
  row_idempotency_key text not null,
  material_payload jsonb not null,
  material_payload_hash text not null,
  server_status text not null default 'pending'
    check (server_status in ('pending', 'committed', 'blocked', 'failed')),
  block_reason_code text,
  block_reason_detail jsonb,
  client_id uuid references public.clients(id),
  client_result text check (client_result in ('matched', 'created')),
  invoice_id uuid references public.invoices(id),
  invoice_result text check (invoice_result in ('inserted', 'already_existed')),
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(run_id, row_number),
  unique(user_id, row_idempotency_key),
  unique(user_id, id),
  foreign key (user_id, run_id) references public.import_runs(user_id, id) on delete cascade,
  foreign key (user_id, batch_id) references public.import_batches(user_id, id) on delete set null
);
create index if not exists import_rows_run_status_idx
  on public.import_rows(run_id, server_status, row_number);
create index if not exists import_rows_batch_idx on public.import_rows(batch_id);

create table if not exists public.import_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid,
  row_id uuid,
  event_type text not null check (event_type in (
    'run_created', 'batch_started', 'client_matched', 'client_created',
    'invoice_inserted', 'invoice_already_existed', 'row_blocked',
    'batch_committed', 'batch_failed', 'cancellation_requested',
    'run_partially_completed', 'run_completed', 'run_failed'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (user_id, run_id) references public.import_runs(user_id, id) on delete cascade,
  foreign key (user_id, batch_id) references public.import_batches(user_id, id) on delete set null,
  foreign key (user_id, row_id) references public.import_rows(user_id, id) on delete set null
);
create index if not exists import_events_run_idx on public.import_events(run_id, created_at);

-- ---- material fields the original Checkpoint 1 draft silently dropped ----
-- currency/payment_date/source_system/source_invoice_id are enumerated
-- material fields (materialPayload.js) but the invoice insert never
-- persisted them. All four are nullable with NO default — a blank
-- currency stays null, never silently defaulted to 'USD'; existing
-- (non-imported) invoices simply read null for all four, meaning
-- "not tracked," which is accurate, not a guess.
alter table public.invoices add column if not exists currency text;
alter table public.invoices add column if not exists payment_date date;
alter table public.invoices add column if not exists source_system text;
alter table public.invoices add column if not exists source_invoice_id text;

-- ---- tenant-safe composite FKs, matching PR #22's established pattern ----
-- invoices needs the same (user_id, id) unique index clients already got
-- from PR #22's tenant-ownership migration, since import_rows.invoice_id
-- is a new FK target against it.
create unique index if not exists invoices_user_id_id_uidx
  on public.invoices(user_id, id);

-- Durable, tenant-scoped invoice-source-identity: source_system is
-- normalized case-insensitively (lower/trim, matching
-- client_source_identities' own convention), source_invoice_id is
-- outer-trimmed but case-sensitive. This is the STRONGEST invoice
-- identity when both are present — enforced at the database level so two
-- rows can never collide, not just checked in application code.
create unique index if not exists invoices_user_source_identity_uidx
  on public.invoices(user_id, source_system, source_invoice_id)
  where source_system is not null and source_invoice_id is not null;

do $tenant_fks$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_rows'::regclass
      and conname = 'import_rows_user_id_client_id_fkey' and contype = 'f'
  ) then
    alter table public.import_rows
      add constraint import_rows_user_id_client_id_fkey
      foreign key (user_id, client_id)
      references public.clients(user_id, id)
      on update no action
      on delete set null (client_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_rows'::regclass
      and conname = 'import_rows_user_id_invoice_id_fkey' and contype = 'f'
  ) then
    alter table public.import_rows
      add constraint import_rows_user_id_invoice_id_fkey
      foreign key (user_id, invoice_id)
      references public.invoices(user_id, id)
      on update no action
      on delete set null (invoice_id);
  end if;
end
$tenant_fks$;

-- ============================================================
-- RLS: authenticated may only ever SELECT their own rows. All writes
-- happen inside the SECURITY DEFINER functions below, never via a direct
-- grant — mirrors PR #22's client_dedup_runs/client_merge_candidates/
-- client_merge_audit tables exactly.
-- ============================================================
alter table public.import_runs enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_events enable row level security;

drop policy if exists "import_runs_select_own" on public.import_runs;
create policy "import_runs_select_own" on public.import_runs
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_batches_select_own" on public.import_batches;
create policy "import_batches_select_own" on public.import_batches
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_rows_select_own" on public.import_rows;
create policy "import_rows_select_own" on public.import_rows
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "import_events_select_own" on public.import_events;
create policy "import_events_select_own" on public.import_events
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- Hosted Supabase projects may pre-grant broad table privileges through
-- project-level default ACLs. Establish the complete privilege baseline
-- here instead of assuming any particular project default. The column-level
-- revokes also remove legacy per-column grants before the one deliberate
-- authenticated column grant on import_batches is restored below.
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
-- import_batches.internal_diagnostic is deliberately withheld from
-- `authenticated` via a column-scoped grant instead of the blanket
-- whole-table grant every other import table gets (see Blocker 1 in the
-- independent review: never expose raw SQLERRM to authenticated users).
revoke select on public.import_batches from authenticated;
grant select (id, run_id, user_id, batch_index, status, row_count, failure_reason, created_at)
  on public.import_batches to authenticated;
grant select, insert, update, delete
  on public.import_runs, public.import_batches, public.import_rows, public.import_events
  to service_role;

-- ============================================================
-- Client resolution wrapper — matched-vs-created truth without a second
-- matching algorithm.
-- ============================================================
-- public.resolve_or_create_client(...) is SECURITY INVOKER and internally
-- requires auth.uid() = p_user_id (see its own definition in
-- 20260726000000_canonical_clients.sql) — the exact same context PR #22's
-- own integration test simulates via set_config('request.jwt.claim.sub',
-- ...). This wrapper establishes that same context so a server-driven
-- batch can call the unmodified resolver at all, and separately determines
-- matched-vs-created WITHOUT re-deriving or duplicating any matching rule.
--
-- Two determination paths, mirroring the resolver's own two internal
-- paths in the same order:
--
--  1. SOURCE IDENTITY FAST PATH. resolve_or_create_client's first move,
--     before any email/phone/name matching, is a direct lookup in
--     client_source_identities by (user_id, lower(trim(source)),
--     trim(external_id)) — if found, it returns that client_id
--     immediately, full stop. This wrapper performs the IDENTICAL lookup
--     (same normalization, same table, same columns — reusing the
--     resolver's own deterministic first branch, not a second matching
--     algorithm) BEFORE calling the resolver. If it finds a mapping, the
--     resolver is guaranteed to return that same existing client via its
--     own fast path — was_created is unconditionally false, regardless of
--     whether the import row's name/email happen to differ from what's
--     currently stored on that client. (An earlier version of this
--     wrapper only checked an email/phone/name lock-key partition, which
--     is the WRONG identity space for a source-identity retry whose
--     name/email drifted from the client's stored values — exactly the
--     bug an independent review caught: a source-identity retry with a
--     different name was misreported as "created" a second time.)
--
--  2. EMAIL/PHONE/NAME FALLTHROUGH. If no source-identity mapping exists
--     yet, the resolver falls through to its own count-based matching
--     query. This wrapper takes the identical advisory lock the resolver
--     computes internally (same coalesce(normalized_email,
--     normalized_phone, normalized_name) formula — copying a lock *key
--     expression* is not matching logic; the decision of which existing
--     client counts as the same identity stays 100% inside the resolver),
--     holds it for this transaction, and snapshots which client ids
--     already exist in this identity's lock-key partition BEFORE calling
--     the resolver, then checks set membership after. This is race-free
--     (the lock is held across both the snapshot and the call) and
--     correctly treats "matched a client created earlier in this same
--     transaction" as a match, not a create — an even earlier version of
--     this wrapper compared created_at to transaction_timestamp(), which
--     local Postgres smoke testing proved wrong (transaction_timestamp()
--     is frozen for the whole transaction, so every row inserted anywhere
--     in the same transaction shares one timestamp).
create or replace function duewatch_ops.resolve_client_for_import(
  p_user_id uuid,
  p_name text,
  p_email text default null,
  p_phone text default null,
  p_company text default null,
  p_source text default null,
  p_external_id text default null,
  p_provenance jsonb default '{}'::jsonb
) returns table(client_id uuid, was_created boolean)
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_client_id uuid;
  v_lock_key bigint;
  v_existing_ids uuid[];
  v_source_identity_existed boolean := false;
begin
  if p_source is not null and p_external_id is not null then
    select exists(
      select 1 from public.client_source_identities
      where user_id = p_user_id
        and source = lower(trim(p_source))
        and external_id = trim(p_external_id)
    ) into v_source_identity_existed;
  end if;

  v_lock_key := hashtextextended(
    p_user_id::text || ':' || coalesce(
      public.normalize_client_email(p_email),
      public.normalize_client_phone(p_phone),
      public.normalize_client_text(p_name)
    ), 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- Every client sharing this identity's lock-key partition, before the
  -- resolver runs. Reuses only the lock-key EXPRESSION (identical to the
  -- resolver's own internal lock) to scope this existence check — never a
  -- match *decision* — so this stays a wrapper around PR #22's resolver,
  -- not a second matching algorithm. Only needed for the fallthrough path
  -- (source identity not already existing); harmless to compute either way.
  select coalesce(array_agg(c.id), array[]::uuid[]) into v_existing_ids
  from public.clients c
  where c.user_id = p_user_id
    and hashtextextended(
      p_user_id::text || ':' || coalesce(
        public.normalize_client_email(c.email),
        public.normalize_client_phone(c.phone),
        public.normalize_client_text(c.name)
      ), 0
    ) = v_lock_key;

  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_client_id := public.resolve_or_create_client(
    p_user_id, p_name, p_email, p_phone, p_company, p_source, p_external_id, p_provenance
  );

  return query select
    v_client_id,
    case
      when v_source_identity_existed then false
      else not (v_client_id = any(v_existing_ids))
    end;
end
$$;
revoke execute on function duewatch_ops.resolve_client_for_import(
  uuid, text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function duewatch_ops.resolve_client_for_import(
  uuid, text, text, text, text, text, text, jsonb
) to service_role;

-- ============================================================
-- start_import_run — atomically idempotent run creation + server-side row
-- revalidation. Called once per "click Start Import."
-- ============================================================
-- p_rows: jsonb array of { row_number, outcome, issue_codes: text[],
-- normalized: {...material fields...} } — exactly the shape the browser's
-- eligibility.js already evaluates client-side; this function re-evaluates
-- every row from scratch rather than trusting any eligibility claim in the
-- payload. p_warnings_acknowledged is a single request-level flag (not
-- per-row): the browser shows one confirmation before submitting a run
-- that contains any ready_with_warnings rows, and that one flag governs
-- every such row in the request.
drop function if exists public.start_import_run(uuid, text, jsonb);
create or replace function public.start_import_run(
  p_user_id uuid,
  p_idempotency_key text,
  p_rows jsonb,
  p_warnings_acknowledged boolean default false
) returns uuid
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_run_id uuid;
  v_existing_run_id uuid;
  v_row jsonb;
  v_blocked_row record;
  v_eligible boolean;
  v_reason text;
  v_payload jsonb;
  v_hash text;
  v_row_key text;
  v_total integer := 0;
  v_eligible_count integer := 0;
  v_blocked_count integer := 0;
  v_request_hash text;
  v_existing_hash text;
  v_row_number_count integer;
  v_distinct_row_number_count integer;
  v_invalid_row_numbers integer;
begin
  if (select auth.uid()) is null or (select auth.uid()) <> p_user_id then
    raise exception 'Cannot start an import run for another user';
  end if;
  if p_idempotency_key is null or trim(p_idempotency_key) = '' then
    raise exception 'idempotency key is required';
  end if;

  -- ---- server-enforced bounds (Blocker 2) — never trust the caller ----
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total > 10000 then
    raise exception 'Import request exceeds the maximum of 10000 rows (got %)', v_total;
  end if;

  select count(*) into v_invalid_row_numbers
  from jsonb_array_elements(p_rows) r
  where jsonb_typeof(r->'row_number') <> 'number'
    or (r->>'row_number')::numeric <> floor((r->>'row_number')::numeric)
    or (r->>'row_number')::numeric < 1;
  if v_invalid_row_numbers > 0 then
    raise exception 'Every row must have a positive integer row_number';
  end if;

  select count(*), count(distinct (r->>'row_number'))
  into v_row_number_count, v_distinct_row_number_count
  from jsonb_array_elements(p_rows) r;
  if v_row_number_count <> v_distinct_row_number_count then
    raise exception 'row_number values must be unique within one import request';
  end if;

  -- jsonb::text is a deterministic, canonical rendering of the same jsonb
  -- value (Postgres normalizes whitespace/structure on the way into jsonb
  -- storage) — this hash only ever needs to compare against itself on a
  -- later call with the exact same key, not match any hash computed
  -- elsewhere, so this canonicalization is sufficient. Includes the
  -- acknowledgement flag: a same-key retry that flips acknowledgement is
  -- also a different logical request.
  v_request_hash := encode(sha256(convert_to(
    jsonb_build_object('rows', p_rows, 'warnings_acknowledged', coalesce(p_warnings_acknowledged, false))::text,
    'UTF8'
  )), 'hex');

  -- ---- atomic idempotent run creation (Blocker 8) ----
  -- INSERT ... ON CONFLICT DO NOTHING is the whole fix: two concurrent
  -- calls with the same (user_id, idempotency_key) can no longer race a
  -- plain SELECT-then-INSERT into a unique-constraint error. Exactly one
  -- concurrent caller's INSERT wins; Postgres blocks the other caller's
  -- INSERT on the same unique index entry until the winner's transaction
  -- resolves, then that caller sees either the committed winning row (via
  -- the SELECT fallback below) or, if the winner rolled back, an open
  -- conflict to retry into.
  insert into public.import_runs(
    id, user_id, idempotency_key, request_payload_hash, warnings_acknowledged, status, total_rows, started_at
  ) values (
    gen_random_uuid(), p_user_id, p_idempotency_key, v_request_hash, coalesce(p_warnings_acknowledged, false),
    'in_progress', v_total, now()
  )
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_run_id;

  if v_run_id is not null then
    -- We won the race (or there was no race) — populate rows below.
    null;
  else
    select id, request_payload_hash into v_existing_run_id, v_existing_hash
    from public.import_runs
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

    if v_existing_run_id is null then
      -- Extremely unlikely: the conflicting row vanished between the
      -- INSERT and this SELECT (e.g. a concurrent user deletion cascade).
      -- Fail loudly rather than loop indefinitely on a pathological case.
      raise exception 'Could not resolve import run for idempotency key %', p_idempotency_key;
    end if;
    if v_existing_hash <> v_request_hash then
      raise exception
        'Idempotency key % was already used to start a different import; refusing to overwrite it',
        p_idempotency_key;
    end if;
    return v_existing_run_id;
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    select e.eligible, e.reason_code into v_eligible, v_reason
    from duewatch_ops.evaluate_row_eligibility(
      v_row->>'outcome',
      case when v_row->'issue_codes' is null then null
        else array(select jsonb_array_elements_text(v_row->'issue_codes')) end,
      coalesce(v_row->'normalized', '{}'::jsonb),
      coalesce(p_warnings_acknowledged, false)
    ) e;

    v_payload := jsonb_build_object(
      'user_id', p_user_id::text,
      'client_name', v_row->'normalized'->>'client_name',
      'client_company', v_row->'normalized'->>'client_company',
      'client_email', v_row->'normalized'->>'client_email',
      'client_phone', v_row->'normalized'->>'client_phone',
      'source_system', v_row->'normalized'->>'source_system',
      'source_client_id', v_row->'normalized'->>'source_client_id',
      'invoice_number', v_row->'normalized'->>'invoice_number',
      'source_invoice_id', v_row->'normalized'->>'source_invoice_id',
      'invoice_date', v_row->'normalized'->>'invoice_date',
      'due_date', v_row->'normalized'->>'due_date',
      'amount', v_row->'normalized'->>'amount',
      'currency', v_row->'normalized'->>'currency',
      'status', v_row->'normalized'->>'status',
      'amount_paid', v_row->'normalized'->>'amount_paid',
      'payment_date', v_row->'normalized'->>'payment_date'
    );
    v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
    v_row_key := v_run_id::text || ':' || (v_row->>'row_number');

    if v_eligible then
      v_eligible_count := v_eligible_count + 1;
      insert into public.import_rows(
        run_id, user_id, row_number, row_idempotency_key,
        material_payload, material_payload_hash, server_status
      ) values (
        v_run_id, p_user_id, (v_row->>'row_number')::integer, v_row_key,
        v_payload, v_hash, 'pending'
      );
    else
      v_blocked_count := v_blocked_count + 1;
      insert into public.import_rows(
        run_id, user_id, row_number, row_idempotency_key,
        material_payload, material_payload_hash, server_status,
        block_reason_code, block_reason_detail
      ) values (
        v_run_id, p_user_id, (v_row->>'row_number')::integer, v_row_key,
        v_payload, v_hash, 'blocked',
        v_reason, jsonb_build_object('outcome', v_row->>'outcome')
      );
    end if;
  end loop;

  update public.import_runs
  set eligible_rows = v_eligible_count, blocked_rows = v_blocked_count
  where id = v_run_id;

  insert into public.import_events(run_id, user_id, event_type, detail)
  values (v_run_id, p_user_id, 'run_created', jsonb_build_object(
    'total_rows', v_total, 'eligible_rows', v_eligible_count, 'blocked_rows', v_blocked_count
  ));
  for v_blocked_row in
    select id, block_reason_code from public.import_rows
    where run_id = v_run_id and server_status = 'blocked'
  loop
    insert into public.import_events(run_id, user_id, row_id, event_type, detail)
    values (v_run_id, p_user_id, v_blocked_row.id, 'row_blocked',
      jsonb_build_object('reason_code', v_blocked_row.block_reason_code));
  end loop;

  return v_run_id;
end
$$;
revoke execute on function public.start_import_run(uuid, text, jsonb, boolean)
  from public, anon;
grant execute on function public.start_import_run(uuid, text, jsonb, boolean) to authenticated, service_role;

-- ============================================================
-- process_import_batch — claims and transactionally persists the next
-- pending batch (bounded to 200 rows). Call repeatedly from the browser
-- until the returned status is 'completed', 'partially_completed', or
-- 'cancelled'.
-- ============================================================
create or replace function public.process_import_batch(
  p_run_id uuid,
  p_batch_size integer default 200
) returns jsonb
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_run public.import_runs%rowtype;
  v_batch_index integer;
  v_batch_id uuid;
  v_row public.import_rows%rowtype;
  v_client_id uuid;
  v_was_created boolean;
  v_invoice_id uuid;
  v_invoice_result text;
  v_paid boolean;
  v_amount_paid numeric(12, 2);
  v_amount numeric(12, 2);
  v_currency text;
  v_payment_date date;
  v_source_system text;
  v_source_invoice_id text;
  v_lock_key bigint;
  v_row_count integer := 0;
  v_remaining integer;
  v_committed_in_call integer;
  v_existing public.invoices%rowtype;
  v_fallback_invoice_ids uuid[];
  v_fallback_match_count integer;
  v_conflict boolean;
  v_sanitized_reason text := 'An unexpected error occurred while processing this batch. No rows from this batch were saved.';
begin
  select * into v_run from public.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'Import run not found';
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> v_run.user_id then
    raise exception 'Cannot process a batch for another user''s import run';
  end if;

  -- ---- server-enforced bounds (Blocker 2) ----
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 200 then
    raise exception 'p_batch_size must be an integer between 1 and 200 inclusive';
  end if;

  if v_run.status in ('completed', 'partially_completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', v_run.status, 'run_id', p_run_id);
  end if;

  -- Cancellation is observed BETWEEN batches, never mid-batch: checked
  -- here, before any new batch is claimed, never inside the loop below.
  if v_run.cancel_requested_at is not null then
    update public.import_runs set status = 'cancelled', completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id, 'run_completed');
    return jsonb_build_object('status', 'cancelled', 'run_id', p_run_id);
  end if;

  -- Claim up to p_batch_size PENDING rows. FOR UPDATE SKIP LOCKED means a
  -- second concurrent call for the same run claims a *different* set of
  -- rows (or none) rather than racing on the same ones. (Defense-in-depth:
  -- the run-row FOR UPDATE lock taken above already fully serializes
  -- concurrent calls for the SAME run — stated plainly, not overclaiming
  -- finer-grained concurrency than what's actually load-bearing here.)
  create temporary table if not exists _claimed_rows (id uuid primary key) on commit drop;
  delete from _claimed_rows
  where id is not null;
  insert into _claimed_rows
  select id from public.import_rows
  where run_id = p_run_id and batch_id is null and server_status = 'pending'
  order by row_number
  limit p_batch_size
  for update skip locked;

  select count(*) into v_row_count from _claimed_rows;

  if v_row_count = 0 then
    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status = 'pending';
    if v_remaining > 0 then
      -- Another concurrent worker holds the remaining pending rows right
      -- now; this run is not finished, just not claimable by us this call.
      return jsonb_build_object('status', 'in_progress', 'run_id', p_run_id, 'claimed', 0);
    end if;

    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status in ('blocked', 'failed');
    update public.import_runs
    set status = case when v_remaining > 0 then 'partially_completed' else 'completed' end,
        completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id,
      case when v_remaining > 0 then 'run_partially_completed' else 'run_completed' end);
    return jsonb_build_object(
      'status', case when v_remaining > 0 then 'partially_completed' else 'completed' end,
      'run_id', p_run_id
    );
  end if;

  update public.import_runs set next_batch_index = next_batch_index + 1
  where id = p_run_id
  returning next_batch_index - 1 into v_batch_index;

  -- The batch row is inserted FIRST (status='in_progress') so that
  -- per-row UPDATEs referencing batch_id never violate
  -- import_rows_batch_id_fkey by pointing at a batch that doesn't exist
  -- yet. Its status is corrected to 'committed' or 'failed' below, once
  -- known.
  v_batch_id := gen_random_uuid();
  insert into public.import_batches(id, run_id, user_id, batch_index, status, row_count)
  values (v_batch_id, p_run_id, v_run.user_id, v_batch_index, 'in_progress', v_row_count);

  insert into public.import_events(run_id, user_id, event_type, detail)
  values (p_run_id, v_run.user_id, 'batch_started', jsonb_build_object('batch_index', v_batch_index, 'row_count', v_row_count));

  -- Nested block = implicit savepoint. Any unexpected exception here rolls
  -- back every row-level write in this batch (invoice inserts, client
  -- creates via the resolver, import_rows updates) while letting the
  -- OUTER block still record a truthful 'batch_failed' fact afterward —
  -- the failure record itself is not part of what gets rolled back.
  begin
    for v_row in
      select r.* from public.import_rows r
      join _claimed_rows c on c.id = r.id
      order by r.row_number
    loop
      begin
        select * from duewatch_ops.resolve_client_for_import(
          v_run.user_id,
          v_row.material_payload->>'client_name',
          v_row.material_payload->>'client_email',
          v_row.material_payload->>'client_phone',
          v_row.material_payload->>'client_company',
          v_row.material_payload->>'source_system',
          v_row.material_payload->>'source_client_id',
          jsonb_build_object('import_run_id', p_run_id, 'row_id', v_row.id)
        ) into v_client_id, v_was_created;
      exception when others then
        -- Row-vs-batch exception classification (Blocker 1): only
        -- explicitly defined, expected business outcomes of the resolver
        -- may block a single row. 'Ambiguous client identity...' (v_count
        -- > 1 in resolve_or_create_client) and 'Client name is required'
        -- (no usable normalized name) are the resolver's own two named,
        -- deterministic, data-dependent failure modes — genuinely
        -- reachable even after this migration's own strong-identity gate,
        -- since an email match can still be ambiguous across two existing
        -- clients, and client_name is not itself a required material
        -- field. Anything else (permission errors, schema drift, type
        -- errors, serialization failures, unexpected nulls) is NOT a
        -- known business outcome and must re-raise, aborting and rolling
        -- back the whole batch via the outer savepoint — never silently
        -- blocking just this row for a reason nobody defined.
        if sqlerrm = 'Ambiguous client identity; select a client explicitly' then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'AMBIGUOUS_CLIENT_IDENTITY',
              block_reason_detail = jsonb_build_object('message', 'Multiple existing clients match this row''s identity.'),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'AMBIGUOUS_CLIENT_IDENTITY'));
          continue;
        elsif sqlerrm = 'Client name is required' then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'MISSING_CLIENT_NAME',
              block_reason_detail = jsonb_build_object('message', 'No usable client name was provided.'),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'MISSING_CLIENT_NAME'));
          continue;
        else
          raise;
        end if;
      end;

      -- ---- durable, tenant-scoped invoice-source-identity (Blocker 6) ----
      -- source_system normalized case-insensitively (lower/trim, matching
      -- client_source_identities' own convention); source_invoice_id
      -- outer-trimmed but case-sensitive. Strongest identity when both
      -- present; fallback is (client_id, invoice_number) — invoice number
      -- alone is never sufficient, a client_id is always part of the
      -- fallback key.
      v_source_system := nullif(lower(trim(v_row.material_payload->>'source_system')), '');
      v_source_invoice_id := nullif(trim(v_row.material_payload->>'source_invoice_id'), '');

      v_lock_key := hashtextextended(
        v_run.user_id::text || ':inv:' || coalesce(
          case when v_source_system is not null and v_source_invoice_id is not null
            then v_source_system || ':' || v_source_invoice_id
          end,
          v_client_id::text || ':' || (v_row.material_payload->>'invoice_number')
        ), 0
      );
      perform pg_advisory_xact_lock(v_lock_key);

      if v_source_system is not null and v_source_invoice_id is not null then
        select i.* into v_existing from public.invoices i
        where i.user_id = v_run.user_id
          and i.source_system = v_source_system
          and i.source_invoice_id = v_source_invoice_id;
      else
        -- A source-less fallback is not structurally unique in the legacy
        -- invoice schema. Probe at most two IDs under the existing fallback
        -- advisory lock: zero means insert, one is safe to compare, and two
        -- is enough to prove ambiguity without choosing or exposing either
        -- candidate. Ordering is deterministic only for testability; an
        -- ambiguous candidate is never selected regardless of that order.
        select coalesce(array_agg(matches.id order by matches.id), '{}'::uuid[])
        into v_fallback_invoice_ids
        from (
          select i.id
          from public.invoices i
          where i.user_id = v_run.user_id
            and i.client_id = v_client_id
            and i.inv_num = (v_row.material_payload->>'invoice_number')
            and i.source_system is null and i.source_invoice_id is null
          order by i.id
          limit 2
        ) matches;

        v_fallback_match_count := cardinality(v_fallback_invoice_ids);
        if v_fallback_match_count > 1 then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'AMBIGUOUS_INVOICE_IDENTITY',
              block_reason_detail = jsonb_build_object(
                'message', 'Multiple existing invoices match this client and invoice number. Review is required.'
              ),
              batch_id = v_batch_id,
              invoice_id = null,
              invoice_result = null
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object(
              'reason_code', 'AMBIGUOUS_INVOICE_IDENTITY',
              'message', 'Multiple existing invoices match this client and invoice number. Review is required.'
            ));
          continue;
        elsif v_fallback_match_count = 1 then
          select i.* into strict v_existing
          from public.invoices i
          where i.id = v_fallback_invoice_ids[1]
            and i.user_id = v_run.user_id;
        else
          v_existing := null;
        end if;
      end if;

      -- status -> paid boolean translation (the real schema has no status
      -- column; this is Phase 1.5B's one authoritative, locked
      -- translation, never re-derived elsewhere):
      --   'paid'                          -> paid = true
      --   'partial' / 'draft' / 'sent' /
      --   'overdue' / null (blank)        -> paid = false
      --   'void'                          -> blocked before reaching here
      --                                      (see evaluate_row_eligibility)
      -- coalesce is required: `null = 'paid'` evaluates to NULL, not
      -- false, and invoices.paid is not-null — a blank/omitted status
      -- must resolve to paid = false, not an unassigned NULL.
      v_amount := (v_row.material_payload->>'amount')::numeric(12, 2);
      v_paid := coalesce(v_row.material_payload->>'status', '') = 'paid';
      v_amount_paid := case
        when v_row.material_payload->>'amount_paid' is not null
          then (v_row.material_payload->>'amount_paid')::numeric(12,2)
        when v_paid then v_amount
        else 0
      end;
      v_currency := nullif(v_row.material_payload->>'currency', '');
      v_payment_date := nullif(v_row.material_payload->>'payment_date', '')::date;

      if v_existing.id is not null then
        -- Idempotent-retry vs conflicting-retry: an EXACT match on every
        -- material fact is a safe, idempotent already_existed outcome. Any
        -- difference is a conflict — never committed, saved, inserted, or
        -- silently skipped, and the existing invoice is never overwritten.
        v_conflict :=
          v_existing.amount is distinct from v_amount
          or v_existing.inv_date is distinct from (v_row.material_payload->>'invoice_date')::date
          or v_existing.due_date is distinct from nullif(v_row.material_payload->>'due_date', '')::date
          or v_existing.paid is distinct from v_paid
          or v_existing.amount_paid is distinct from v_amount_paid
          or v_existing.currency is distinct from v_currency
          or v_existing.payment_date is distinct from v_payment_date;

        if v_conflict then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'INVOICE_MATERIAL_CONFLICT',
              block_reason_detail = jsonb_build_object(
                'existing_invoice_id', v_existing.id,
                'message', 'An invoice with this identity already exists with different details.'
              ),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'INVOICE_MATERIAL_CONFLICT', 'existing_invoice_id', v_existing.id));
          continue;
        end if;

        v_invoice_id := v_existing.id;
        v_invoice_result := 'already_existed';
      else
        insert into public.invoices(
          user_id, client_id, inv_num, amount, amount_paid,
          inv_date, due_date, paid, currency, payment_date,
          source_system, source_invoice_id
        ) values (
          v_run.user_id, v_client_id,
          v_row.material_payload->>'invoice_number',
          v_amount,
          v_amount_paid,
          (v_row.material_payload->>'invoice_date')::date,
          nullif(v_row.material_payload->>'due_date', '')::date,
          v_paid,
          v_currency,
          v_payment_date,
          v_source_system,
          v_source_invoice_id
        )
        returning id into v_invoice_id;
        v_invoice_result := 'inserted';
      end if;

      update public.import_rows
      set server_status = 'committed',
          batch_id = v_batch_id,
          client_id = v_client_id,
          client_result = case when v_was_created then 'created' else 'matched' end,
          invoice_id = v_invoice_id,
          invoice_result = v_invoice_result,
          committed_at = now()
      where id = v_row.id;

      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_was_created then 'client_created' else 'client_matched' end,
        jsonb_build_object('client_id', v_client_id));
      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_invoice_result = 'inserted' then 'invoice_inserted' else 'invoice_already_existed' end,
        jsonb_build_object('invoice_id', v_invoice_id));
    end loop;

    -- Batch row committed only now, once every claimed row in it has a
    -- durable outcome (committed or blocked) — this UPDATE and every
    -- import_rows/import_events write above are part of the SAME
    -- transaction as the function call itself, so they commit together
    -- or not at all.
    update public.import_batches
    set status = 'committed', row_count = v_row_count
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_committed', jsonb_build_object('row_count', v_row_count));
  exception when others then
    -- Savepoint rollback undid every row-level write above; the claimed
    -- rows are back to server_status='pending', batch_id=null — exactly
    -- as if this call never happened, safe to retry. The import_batches
    -- row itself (status='in_progress') was inserted before the savepoint
    -- began and is NOT rolled back, so it must be corrected via UPDATE,
    -- not re-inserted. Raw SQLERRM is logged server-side and stored in the
    -- operator-only internal_diagnostic column — never returned to the
    -- caller or written into an authenticated-visible event.
    raise log 'process_import_batch: batch % (run %) failed: %', v_batch_id, p_run_id, sqlerrm;
    update public.import_batches
    set status = 'failed', failure_reason = v_sanitized_reason, internal_diagnostic = sqlerrm
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_failed', jsonb_build_object('message', v_sanitized_reason));
    return jsonb_build_object('status', 'batch_failed', 'run_id', p_run_id, 'reason', v_sanitized_reason);
  end;

  -- Truthful progress (Blocker 9): count what was ACTUALLY committed in
  -- this call, straight from import_rows, rather than reusing the claimed
  -- count (some claimed rows may have been blocked, not committed).
  select count(*) into v_committed_in_call
  from public.import_rows where batch_id = v_batch_id and server_status = 'committed';

  return jsonb_build_object(
    'status', 'in_progress', 'run_id', p_run_id,
    'committed', v_committed_in_call, 'claimed', v_row_count
  );
end
$$;
revoke execute on function public.process_import_batch(uuid, integer) from public, anon;
grant execute on function public.process_import_batch(uuid, integer) to authenticated, service_role;

-- ============================================================
-- request_import_cancellation — idempotent; cancellation is observed
-- between batches by process_import_batch, never mid-batch.
-- ============================================================
create or replace function public.request_import_cancellation(p_run_id uuid)
returns void
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_user_id uuid;
begin
  select user_id into v_user_id from public.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'Import run not found';
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> v_user_id then
    raise exception 'Cannot cancel another user''s import run';
  end if;

  update public.import_runs
  set cancel_requested_at = coalesce(cancel_requested_at, now())
  where id = p_run_id;

  insert into public.import_events(run_id, user_id, event_type)
  values (p_run_id, v_user_id, 'cancellation_requested');
end
$$;
revoke execute on function public.request_import_cancellation(uuid) from public, anon;
grant execute on function public.request_import_cancellation(uuid) to authenticated, service_role;

-- ============================================================
-- Postconditions
-- ============================================================
do $postconditions$
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename in ('import_runs', 'import_batches', 'import_rows', 'import_events')
    having count(*) = 4
  ) then
    raise exception 'Not all four import persistence tables were created';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invoices'
      and column_name in ('currency', 'payment_date', 'source_system', 'source_invoice_id')
    having count(*) = 4
  ) then
    raise exception 'invoices is missing one or more material-field columns';
  end if;

  if (select execution_enabled from duewatch_ops.client_dedup_config where singleton) then
    raise exception 'Canonical dedup execution must remain disabled';
  end if;
end
$postconditions$;

-- ============================================================================
-- [SOURCE: 20260810000000_client_source_identities_rls.sql]
-- ============================================================================
-- Forward migration for the hosted-staging RLS finding on
-- client_source_identities. 20260726000000_canonical_clients.sql (PR #22,
-- already merged and already applied to staging) now creates these two
-- policies for fresh installs, but Supabase does not re-run an already-
-- applied migration file just because its contents changed — an existing
-- database that already ran 20260726000000 before this fix will never pick
-- up the policy change from editing that file alone. This migration carries
-- the same two policies forward so an already-migrated database actually
-- receives them.
--
-- resolve_or_create_client() runs security invoker, so an authenticated
-- caller's own insert/upsert into client_source_identities is subject to
-- RLS directly. With only a select-own policy present, RLS denied every
-- insert by default — the hosted-staging failure on the source-identity
-- path. These two policies scope insert/update to the caller's own rows,
-- matching the select-own policy and the table's tenant-scoped
-- unique(user_id, source, external_id) constraint.
--
-- Idempotent: safe to run on a database that already has these policies
-- (from a fresh install of 20260726000000) or does not yet have them (an
-- already-migrated database receiving this fix for the first time).
drop policy if exists "client_source_identities_insert_own"
  on public.client_source_identities;

create policy "client_source_identities_insert_own"
  on public.client_source_identities
  for insert
  to authenticated
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

drop policy if exists "client_source_identities_update_own"
  on public.client_source_identities;

create policy "client_source_identities_update_own"
  on public.client_source_identities
  for update
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  )
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

-- ============================================================================
-- [SOURCE: 20260811083005_phase15b_import_table_privilege_baseline.sql]
-- ============================================================================
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

-- ============================================================================
-- [SOURCE: 20260811092928_process_import_batch_hosted_compatibility.sql]
-- ============================================================================
-- Phase 1.5B hosted SQL-safety compatibility correction.
--
-- Generated with Supabase CLI 2.111.0. Hosted staging already has the original
-- Phase 1.5B migration and the privilege-baseline correction, so this append-
-- only migration replaces only process_import_batch. Its definition is kept
-- byte-for-byte aligned with the corrected fresh-install migration except that
-- clearing the transaction-scoped temporary claim table now uses an explicit
-- predicate accepted by hosted require-WHERE guards.

create or replace function public.process_import_batch(
  p_run_id uuid,
  p_batch_size integer default 200
) returns jsonb
language plpgsql security definer set search_path = public, duewatch_ops, pg_temp as $$
declare
  v_run public.import_runs%rowtype;
  v_batch_index integer;
  v_batch_id uuid;
  v_row public.import_rows%rowtype;
  v_client_id uuid;
  v_was_created boolean;
  v_invoice_id uuid;
  v_invoice_result text;
  v_paid boolean;
  v_amount_paid numeric(12, 2);
  v_amount numeric(12, 2);
  v_currency text;
  v_payment_date date;
  v_source_system text;
  v_source_invoice_id text;
  v_lock_key bigint;
  v_row_count integer := 0;
  v_remaining integer;
  v_committed_in_call integer;
  v_existing public.invoices%rowtype;
  v_fallback_invoice_ids uuid[];
  v_fallback_match_count integer;
  v_conflict boolean;
  v_sanitized_reason text := 'An unexpected error occurred while processing this batch. No rows from this batch were saved.';
begin
  select * into v_run from public.import_runs where id = p_run_id for update;
  if not found then
    raise exception 'Import run not found';
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> v_run.user_id then
    raise exception 'Cannot process a batch for another user''s import run';
  end if;

  -- ---- server-enforced bounds (Blocker 2) ----
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 200 then
    raise exception 'p_batch_size must be an integer between 1 and 200 inclusive';
  end if;

  if v_run.status in ('completed', 'partially_completed', 'failed', 'cancelled') then
    return jsonb_build_object('status', v_run.status, 'run_id', p_run_id);
  end if;

  -- Cancellation is observed BETWEEN batches, never mid-batch: checked
  -- here, before any new batch is claimed, never inside the loop below.
  if v_run.cancel_requested_at is not null then
    update public.import_runs set status = 'cancelled', completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id, 'run_completed');
    return jsonb_build_object('status', 'cancelled', 'run_id', p_run_id);
  end if;

  -- Claim up to p_batch_size PENDING rows. FOR UPDATE SKIP LOCKED means a
  -- second concurrent call for the same run claims a *different* set of
  -- rows (or none) rather than racing on the same ones. (Defense-in-depth:
  -- the run-row FOR UPDATE lock taken above already fully serializes
  -- concurrent calls for the SAME run — stated plainly, not overclaiming
  -- finer-grained concurrency than what's actually load-bearing here.)
  create temporary table if not exists _claimed_rows (id uuid primary key) on commit drop;
  delete from _claimed_rows
  where id is not null;
  insert into _claimed_rows
  select id from public.import_rows
  where run_id = p_run_id and batch_id is null and server_status = 'pending'
  order by row_number
  limit p_batch_size
  for update skip locked;

  select count(*) into v_row_count from _claimed_rows;

  if v_row_count = 0 then
    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status = 'pending';
    if v_remaining > 0 then
      -- Another concurrent worker holds the remaining pending rows right
      -- now; this run is not finished, just not claimable by us this call.
      return jsonb_build_object('status', 'in_progress', 'run_id', p_run_id, 'claimed', 0);
    end if;

    select count(*) into v_remaining from public.import_rows
    where run_id = p_run_id and server_status in ('blocked', 'failed');
    update public.import_runs
    set status = case when v_remaining > 0 then 'partially_completed' else 'completed' end,
        completed_at = now()
    where id = p_run_id;
    insert into public.import_events(run_id, user_id, event_type)
    values (p_run_id, v_run.user_id,
      case when v_remaining > 0 then 'run_partially_completed' else 'run_completed' end);
    return jsonb_build_object(
      'status', case when v_remaining > 0 then 'partially_completed' else 'completed' end,
      'run_id', p_run_id
    );
  end if;

  update public.import_runs set next_batch_index = next_batch_index + 1
  where id = p_run_id
  returning next_batch_index - 1 into v_batch_index;

  -- The batch row is inserted FIRST (status='in_progress') so that
  -- per-row UPDATEs referencing batch_id never violate
  -- import_rows_batch_id_fkey by pointing at a batch that doesn't exist
  -- yet. Its status is corrected to 'committed' or 'failed' below, once
  -- known.
  v_batch_id := gen_random_uuid();
  insert into public.import_batches(id, run_id, user_id, batch_index, status, row_count)
  values (v_batch_id, p_run_id, v_run.user_id, v_batch_index, 'in_progress', v_row_count);

  insert into public.import_events(run_id, user_id, event_type, detail)
  values (p_run_id, v_run.user_id, 'batch_started', jsonb_build_object('batch_index', v_batch_index, 'row_count', v_row_count));

  -- Nested block = implicit savepoint. Any unexpected exception here rolls
  -- back every row-level write in this batch (invoice inserts, client
  -- creates via the resolver, import_rows updates) while letting the
  -- OUTER block still record a truthful 'batch_failed' fact afterward —
  -- the failure record itself is not part of what gets rolled back.
  begin
    for v_row in
      select r.* from public.import_rows r
      join _claimed_rows c on c.id = r.id
      order by r.row_number
    loop
      begin
        select * from duewatch_ops.resolve_client_for_import(
          v_run.user_id,
          v_row.material_payload->>'client_name',
          v_row.material_payload->>'client_email',
          v_row.material_payload->>'client_phone',
          v_row.material_payload->>'client_company',
          v_row.material_payload->>'source_system',
          v_row.material_payload->>'source_client_id',
          jsonb_build_object('import_run_id', p_run_id, 'row_id', v_row.id)
        ) into v_client_id, v_was_created;
      exception when others then
        -- Row-vs-batch exception classification (Blocker 1): only
        -- explicitly defined, expected business outcomes of the resolver
        -- may block a single row. 'Ambiguous client identity...' (v_count
        -- > 1 in resolve_or_create_client) and 'Client name is required'
        -- (no usable normalized name) are the resolver's own two named,
        -- deterministic, data-dependent failure modes — genuinely
        -- reachable even after this migration's own strong-identity gate,
        -- since an email match can still be ambiguous across two existing
        -- clients, and client_name is not itself a required material
        -- field. Anything else (permission errors, schema drift, type
        -- errors, serialization failures, unexpected nulls) is NOT a
        -- known business outcome and must re-raise, aborting and rolling
        -- back the whole batch via the outer savepoint — never silently
        -- blocking just this row for a reason nobody defined.
        if sqlerrm = 'Ambiguous client identity; select a client explicitly' then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'AMBIGUOUS_CLIENT_IDENTITY',
              block_reason_detail = jsonb_build_object('message', 'Multiple existing clients match this row''s identity.'),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'AMBIGUOUS_CLIENT_IDENTITY'));
          continue;
        elsif sqlerrm = 'Client name is required' then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'MISSING_CLIENT_NAME',
              block_reason_detail = jsonb_build_object('message', 'No usable client name was provided.'),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'MISSING_CLIENT_NAME'));
          continue;
        else
          raise;
        end if;
      end;

      -- ---- durable, tenant-scoped invoice-source-identity (Blocker 6) ----
      -- source_system normalized case-insensitively (lower/trim, matching
      -- client_source_identities' own convention); source_invoice_id
      -- outer-trimmed but case-sensitive. Strongest identity when both
      -- present; fallback is (client_id, invoice_number) — invoice number
      -- alone is never sufficient, a client_id is always part of the
      -- fallback key.
      v_source_system := nullif(lower(trim(v_row.material_payload->>'source_system')), '');
      v_source_invoice_id := nullif(trim(v_row.material_payload->>'source_invoice_id'), '');

      v_lock_key := hashtextextended(
        v_run.user_id::text || ':inv:' || coalesce(
          case when v_source_system is not null and v_source_invoice_id is not null
            then v_source_system || ':' || v_source_invoice_id
          end,
          v_client_id::text || ':' || (v_row.material_payload->>'invoice_number')
        ), 0
      );
      perform pg_advisory_xact_lock(v_lock_key);

      if v_source_system is not null and v_source_invoice_id is not null then
        select i.* into v_existing from public.invoices i
        where i.user_id = v_run.user_id
          and i.source_system = v_source_system
          and i.source_invoice_id = v_source_invoice_id;
      else
        -- A source-less fallback is not structurally unique in the legacy
        -- invoice schema. Probe at most two IDs under the existing fallback
        -- advisory lock: zero means insert, one is safe to compare, and two
        -- is enough to prove ambiguity without choosing or exposing either
        -- candidate. Ordering is deterministic only for testability; an
        -- ambiguous candidate is never selected regardless of that order.
        select coalesce(array_agg(matches.id order by matches.id), '{}'::uuid[])
        into v_fallback_invoice_ids
        from (
          select i.id
          from public.invoices i
          where i.user_id = v_run.user_id
            and i.client_id = v_client_id
            and i.inv_num = (v_row.material_payload->>'invoice_number')
            and i.source_system is null and i.source_invoice_id is null
          order by i.id
          limit 2
        ) matches;

        v_fallback_match_count := cardinality(v_fallback_invoice_ids);
        if v_fallback_match_count > 1 then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'AMBIGUOUS_INVOICE_IDENTITY',
              block_reason_detail = jsonb_build_object(
                'message', 'Multiple existing invoices match this client and invoice number. Review is required.'
              ),
              batch_id = v_batch_id,
              invoice_id = null,
              invoice_result = null
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object(
              'reason_code', 'AMBIGUOUS_INVOICE_IDENTITY',
              'message', 'Multiple existing invoices match this client and invoice number. Review is required.'
            ));
          continue;
        elsif v_fallback_match_count = 1 then
          select i.* into strict v_existing
          from public.invoices i
          where i.id = v_fallback_invoice_ids[1]
            and i.user_id = v_run.user_id;
        else
          v_existing := null;
        end if;
      end if;

      -- status -> paid boolean translation (the real schema has no status
      -- column; this is Phase 1.5B's one authoritative, locked
      -- translation, never re-derived elsewhere):
      --   'paid'                          -> paid = true
      --   'partial' / 'draft' / 'sent' /
      --   'overdue' / null (blank)        -> paid = false
      --   'void'                          -> blocked before reaching here
      --                                      (see evaluate_row_eligibility)
      -- coalesce is required: `null = 'paid'` evaluates to NULL, not
      -- false, and invoices.paid is not-null — a blank/omitted status
      -- must resolve to paid = false, not an unassigned NULL.
      v_amount := (v_row.material_payload->>'amount')::numeric(12, 2);
      v_paid := coalesce(v_row.material_payload->>'status', '') = 'paid';
      v_amount_paid := case
        when v_row.material_payload->>'amount_paid' is not null
          then (v_row.material_payload->>'amount_paid')::numeric(12,2)
        when v_paid then v_amount
        else 0
      end;
      v_currency := nullif(v_row.material_payload->>'currency', '');
      v_payment_date := nullif(v_row.material_payload->>'payment_date', '')::date;

      if v_existing.id is not null then
        -- Idempotent-retry vs conflicting-retry: an EXACT match on every
        -- material fact is a safe, idempotent already_existed outcome. Any
        -- difference is a conflict — never committed, saved, inserted, or
        -- silently skipped, and the existing invoice is never overwritten.
        v_conflict :=
          v_existing.amount is distinct from v_amount
          or v_existing.inv_date is distinct from (v_row.material_payload->>'invoice_date')::date
          or v_existing.due_date is distinct from nullif(v_row.material_payload->>'due_date', '')::date
          or v_existing.paid is distinct from v_paid
          or v_existing.amount_paid is distinct from v_amount_paid
          or v_existing.currency is distinct from v_currency
          or v_existing.payment_date is distinct from v_payment_date;

        if v_conflict then
          update public.import_rows
          set server_status = 'blocked',
              block_reason_code = 'INVOICE_MATERIAL_CONFLICT',
              block_reason_detail = jsonb_build_object(
                'existing_invoice_id', v_existing.id,
                'message', 'An invoice with this identity already exists with different details.'
              ),
              batch_id = v_batch_id
          where id = v_row.id;
          insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
          values (p_run_id, v_run.user_id, v_batch_id, v_row.id, 'row_blocked',
            jsonb_build_object('reason_code', 'INVOICE_MATERIAL_CONFLICT', 'existing_invoice_id', v_existing.id));
          continue;
        end if;

        v_invoice_id := v_existing.id;
        v_invoice_result := 'already_existed';
      else
        insert into public.invoices(
          user_id, client_id, inv_num, amount, amount_paid,
          inv_date, due_date, paid, currency, payment_date,
          source_system, source_invoice_id
        ) values (
          v_run.user_id, v_client_id,
          v_row.material_payload->>'invoice_number',
          v_amount,
          v_amount_paid,
          (v_row.material_payload->>'invoice_date')::date,
          nullif(v_row.material_payload->>'due_date', '')::date,
          v_paid,
          v_currency,
          v_payment_date,
          v_source_system,
          v_source_invoice_id
        )
        returning id into v_invoice_id;
        v_invoice_result := 'inserted';
      end if;

      update public.import_rows
      set server_status = 'committed',
          batch_id = v_batch_id,
          client_id = v_client_id,
          client_result = case when v_was_created then 'created' else 'matched' end,
          invoice_id = v_invoice_id,
          invoice_result = v_invoice_result,
          committed_at = now()
      where id = v_row.id;

      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_was_created then 'client_created' else 'client_matched' end,
        jsonb_build_object('client_id', v_client_id));
      insert into public.import_events(run_id, user_id, batch_id, row_id, event_type, detail)
      values (p_run_id, v_run.user_id, v_batch_id, v_row.id,
        case when v_invoice_result = 'inserted' then 'invoice_inserted' else 'invoice_already_existed' end,
        jsonb_build_object('invoice_id', v_invoice_id));
    end loop;

    -- Batch row committed only now, once every claimed row in it has a
    -- durable outcome (committed or blocked) — this UPDATE and every
    -- import_rows/import_events write above are part of the SAME
    -- transaction as the function call itself, so they commit together
    -- or not at all.
    update public.import_batches
    set status = 'committed', row_count = v_row_count
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_committed', jsonb_build_object('row_count', v_row_count));
  exception when others then
    -- Savepoint rollback undid every row-level write above; the claimed
    -- rows are back to server_status='pending', batch_id=null — exactly
    -- as if this call never happened, safe to retry. The import_batches
    -- row itself (status='in_progress') was inserted before the savepoint
    -- began and is NOT rolled back, so it must be corrected via UPDATE,
    -- not re-inserted. Raw SQLERRM is logged server-side and stored in the
    -- operator-only internal_diagnostic column — never returned to the
    -- caller or written into an authenticated-visible event.
    raise log 'process_import_batch: batch % (run %) failed: %', v_batch_id, p_run_id, sqlerrm;
    update public.import_batches
    set status = 'failed', failure_reason = v_sanitized_reason, internal_diagnostic = sqlerrm
    where id = v_batch_id;
    insert into public.import_events(run_id, user_id, batch_id, event_type, detail)
    values (p_run_id, v_run.user_id, v_batch_id, 'batch_failed', jsonb_build_object('message', v_sanitized_reason));
    return jsonb_build_object('status', 'batch_failed', 'run_id', p_run_id, 'reason', v_sanitized_reason);
  end;

  -- Truthful progress (Blocker 9): count what was ACTUALLY committed in
  -- this call, straight from import_rows, rather than reusing the claimed
  -- count (some claimed rows may have been blocked, not committed).
  select count(*) into v_committed_in_call
  from public.import_rows where batch_id = v_batch_id and server_status = 'committed';

  return jsonb_build_object(
    'status', 'in_progress', 'run_id', p_run_id,
    'committed', v_committed_in_call, 'claimed', v_row_count
  );
end
$$;
revoke execute on function public.process_import_batch(uuid, integer) from public, anon;
grant execute on function public.process_import_batch(uuid, integer) to authenticated, service_role;

-- Fail closed if the corrected reset or callable contract drifts.
do $postconditions$
declare
  v_definition text;
  v_config text[];
  v_security_definer boolean;
begin
  select pg_get_functiondef(p.oid), p.proconfig, p.prosecdef
  into v_definition, v_config, v_security_definer
  from pg_proc p
  where p.oid = 'public.process_import_batch(uuid, integer)'::regprocedure;

  if not v_security_definer then
    raise exception 'process_import_batch must remain SECURITY DEFINER';
  end if;
  if v_config is distinct from array['search_path=public, duewatch_ops, pg_temp']::text[] then
    raise exception 'process_import_batch search_path drifted: %', v_config;
  end if;
  if position('delete from _claimed_rows;' in lower(v_definition)) > 0 then
    raise exception 'Unsafe WHERE-less _claimed_rows reset remains';
  end if;
  if position('delete from _claimed_rows' || chr(10) || '  where id is not null;' in lower(v_definition)) = 0 then
    raise exception 'Expected WHERE-qualified _claimed_rows reset is missing';
  end if;
  if not has_function_privilege('authenticated', 'public.process_import_batch(uuid, integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.process_import_batch(uuid, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.process_import_batch(uuid, integer)', 'EXECUTE') then
    raise exception 'process_import_batch EXECUTE contract drifted';
  end if;
end
$postconditions$;

-- ============================================================================
-- [SOURCE: 20260813161329_autopilot_execution_claims.sql]
-- ============================================================================
-- Post-2A.1 execution safety checkpoint: Autopilot at-most-once auto-send.
--
-- LOAD-BEARING INVARIANT: before Duewatch makes any external automatic
-- reminder-send request, it must first atomically acquire a durable,
-- uniquely constrained execution claim for the exact
-- (user_id, invoice_id, rule_id, action_type) identity. Only the caller
-- that wins the claim may make the external send request. This proves
-- AT-MOST-ONCE automatic execution — not exactly-once delivery (Resend
-- delivery itself is outside Duewatch's control).
--
-- Why not reuse an existing table:
--   - awaiting_signature has unique(user_id, invoice_id, status), scoped to
--     the review-queue lifecycle (pending/approved/rejected/...). It is not
--     an execution ledger for auto-sent reminders: the auto-send code path
--     in autopilot-scheduler/index.ts never writes a row there at all, so
--     it cannot record "this rule already auto-sent to this invoice."
--   - events has no unique boundary on (user_id, invoice_id, rule_id,
--     action_type) — it's an append-only activity log, and reminder_sent
--     rows are written AFTER the Resend call, not before, so it cannot
--     serve as the pre-send claim gate the invariant requires.
--   - autopilot_runs is one row per scheduler cycle, not per
--     invoice/rule/action; it has no relevant uniqueness dimension at all.
--
-- Design: reuses the exact atomic-claim pattern already proven in this
-- repo for start_import_run (Phase 1.5B, Blocker 8) — a table with a
-- composite unique constraint on the true identity, and a SECURITY DEFINER
-- function that does INSERT ... ON CONFLICT DO NOTHING RETURNING id, so
-- concurrent callers serialize on the unique index instead of racing a
-- SELECT-then-INSERT. Exactly one caller acquires the claim; every other
-- caller (concurrent or a later scheduler run, regardless of the existing
-- row's status) gets acquired = false and must not attempt the external
-- send. rule_id, action_type, and the caller-supplied deterministic
-- idempotency_key are NOT randomness/time/run-id/snapshot-hash-based —
-- editing the same rule's tone/trigger_days, or running the scheduler
-- again, never manufactures a fresh identity.

create table if not exists public.autopilot_execution_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  -- rule_id intentionally has NO foreign key. autopilot_rules is a real,
  -- RLS-enabled hosted table (see src/lib/autopilot.js's header comment:
  -- "Real columns (already created, RLS enabled)") but its DDL has never
  -- been tracked in this repo's migrations or schema.sql, so a disposable
  -- local Postgres/Supabase instance has no autopilot_rules table to
  -- reference. The (user_id, invoice_id, rule_id, action_type) unique
  -- constraint below is the real execution-identity boundary; it does not
  -- depend on rule_id being FK-valid.
  rule_id uuid not null,
  action_type text not null,
  -- The exact deterministic string sent to the provider as the
  -- Idempotency-Key header (see supabase/functions/_shared/executionClaim.js).
  -- Stored as evidence of what was actually sent, never re-derived here.
  idempotency_key text not null,
  status text not null default 'in_flight',
  provider text not null default 'resend',
  provider_message_id text,
  -- Debug/audit evidence only (e.g. provider error text, rule name at
  -- claim time) — like nextActionAuthority.js's rule snapshot hash, this
  -- is evidence, never itself treated as authorization or identity.
  evidence jsonb not null default '{}',
  claimed_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint autopilot_execution_claims_status_check
    check (status in ('in_flight', 'sent', 'send_failed', 'uncertain')),
  -- The load-bearing constraint: at most one claim row can ever exist for
  -- this identity, for the lifetime of the table. No scheduler run id, no
  -- date/time, no random uuid, no rule snapshot hash is part of it.
  unique (user_id, invoice_id, rule_id, action_type)
);

create index if not exists autopilot_execution_claims_user_idx
  on public.autopilot_execution_claims (user_id, claimed_at desc);

alter table public.autopilot_execution_claims enable row level security;

-- Founders may read their own execution claims (future recovery UI reads
-- this table); they can never insert/update/delete it directly — every
-- write goes through the service-role scheduler, and every insert goes
-- through acquire_autopilot_execution_claim specifically.
drop policy if exists "autopilot_execution_claims_select_own" on public.autopilot_execution_claims;
create policy "autopilot_execution_claims_select_own" on public.autopilot_execution_claims
  for select using (auth.uid() = user_id);

-- ---- privileges (explicit revoke-then-grant, matching the Phase 1.5B
-- privilege-baseline convention — never rely on Postgres's default PUBLIC
-- EXECUTE/table-owner-default grants) ----
revoke all privileges on public.autopilot_execution_claims from PUBLIC, anon, authenticated, service_role;
revoke all privileges (
  id, user_id, invoice_id, rule_id, action_type, idempotency_key,
  status, provider, provider_message_id, evidence, claimed_at, resolved_at
) on public.autopilot_execution_claims from PUBLIC, anon, authenticated, service_role;

grant select on public.autopilot_execution_claims to authenticated;
grant select on public.autopilot_execution_claims to service_role;
-- The scheduler resolves an already-acquired claim (status/provider
-- evidence) directly via the service-role client; it never inserts or
-- deletes a row directly — inserts only ever happen inside
-- acquire_autopilot_execution_claim (SECURITY DEFINER, executes as the
-- function owner, not as service_role), and rows are never deleted.
grant update (status, provider_message_id, evidence, resolved_at)
  on public.autopilot_execution_claims to service_role;

-- ---- atomic claim acquisition ----
-- Called only by the trusted server-side scheduler (service_role). Never
-- exposed to anon/authenticated: this is not a browser-callable RPC.
drop function if exists public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text);
create or replace function public.acquire_autopilot_execution_claim(
  p_user_id uuid,
  p_invoice_id uuid,
  p_rule_id uuid,
  p_action_type text,
  p_idempotency_key text
) returns table(claim_id uuid, acquired boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim_id uuid;
begin
  if p_user_id is null or p_invoice_id is null or p_rule_id is null
     or p_action_type is null or trim(p_action_type) = ''
     or p_idempotency_key is null or trim(p_idempotency_key) = '' then
    raise exception 'acquire_autopilot_execution_claim requires user_id, invoice_id, rule_id, action_type, and idempotency_key';
  end if;

  -- Malformed/mismatched tenant identity fails closed: the invoice must
  -- actually belong to the claiming user. This is a trusted service-role
  -- caller, so this is defense-in-depth against a caller bug, not an
  -- external security boundary — but Phase 2A.1's own doctrine is that
  -- tenant ownership is structurally checked, never assumed from inputs.
  if not exists (
    select 1 from public.invoices where id = p_invoice_id and user_id = p_user_id
  ) then
    raise exception 'invoice % does not belong to user %', p_invoice_id, p_user_id;
  end if;

  -- The atomic core: two concurrent callers with the same identity
  -- serialize on this unique index. Exactly one INSERT wins; the loser's
  -- INSERT resolves to zero rows affected (ON CONFLICT DO NOTHING) rather
  -- than erroring, and falls through to the SELECT below to observe the
  -- winner's row deterministically once its transaction commits.
  insert into public.autopilot_execution_claims (
    id, user_id, invoice_id, rule_id, action_type, idempotency_key, status, claimed_at
  ) values (
    gen_random_uuid(), p_user_id, p_invoice_id, p_rule_id, p_action_type, p_idempotency_key, 'in_flight', now()
  )
  on conflict (user_id, invoice_id, rule_id, action_type) do nothing
  returning id into v_claim_id;

  if v_claim_id is not null then
    return query select v_claim_id, true;
    return;
  end if;

  -- Did not win. A claim already exists for this identity — regardless of
  -- its current status (in_flight/sent/send_failed/uncertain), its mere
  -- existence is what blocks a second automatic attempt. This is the
  -- fail-closed behavior: an incomplete or uncertain prior execution is
  -- never treated as license to retry automatically.
  select id into v_claim_id
  from public.autopilot_execution_claims
  where user_id = p_user_id and invoice_id = p_invoice_id
    and rule_id = p_rule_id and action_type = p_action_type;

  return query select v_claim_id, false;
end;
$$;

revoke all on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text) from PUBLIC, anon, authenticated;
grant execute on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text) to service_role;

-- ---- privilege postconditions ----
do $post$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'autopilot_execution_claims'
      and grantee in ('PUBLIC', 'anon')
  ) then
    raise exception 'PUBLIC or anon retained a privilege on autopilot_execution_claims';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'autopilot_execution_claims'
      and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'authenticated retained a non-SELECT privilege on autopilot_execution_claims';
  end if;

  if has_table_privilege('service_role', 'public.autopilot_execution_claims', 'INSERT')
     or has_table_privilege('service_role', 'public.autopilot_execution_claims', 'DELETE') then
    raise exception 'service_role retained INSERT or DELETE on autopilot_execution_claims (inserts must go through acquire_autopilot_execution_claim only)';
  end if;

  if not has_table_privilege('service_role', 'public.autopilot_execution_claims', 'SELECT') then
    raise exception 'service_role is missing SELECT on autopilot_execution_claims';
  end if;

  if has_function_privilege('anon', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text)', 'EXECUTE') then
    raise exception 'anon or authenticated retained EXECUTE on acquire_autopilot_execution_claim';
  end if;

  if not has_function_privilege('service_role', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text)', 'EXECUTE') then
    raise exception 'service_role is missing EXECUTE on acquire_autopilot_execution_claim';
  end if;
end
$post$;

-- ============================================================================
-- [SOURCE: 20260814090000_awaiting_signature_pending_only_uniqueness.sql]
-- ============================================================================
-- Second execution-safety review-fix pass, HIGH: awaiting_signature's
-- original unique(user_id, invoice_id, status) constraint (schema.sql)
-- permits only ONE row per (user, invoice, status) combination FOREVER --
-- including 'approved'. That means once any rule's draft for an invoice
-- is approved, no OTHER rule can ever have its own draft approved for that
-- same invoice again, since a second row transitioning to status =
-- 'approved' would collide with the first.
--
-- Worse, this collision was reachable AFTER a real external send: the
-- execution-claim send path (autopilotExecutionCore.js's
-- recordSentEvidence) sends via Resend, resolves the durable claim, THEN
-- updates awaiting_signature.status = 'approved' -- so a second rule's
-- approval could have the email genuinely delivered and then fail on this
-- exact constraint while writing local bookkeeping, an external-succeeded/
-- local-failed inconsistency.
--
-- The real requirement is narrower than the original constraint: only one
-- PENDING ask per invoice at a time (so the founder never sees two open
-- signature requests for the same invoice simultaneously) -- historical
-- approved/rejected/skipped/expired rows must be free to coexist across
-- however many different rules eventually act on the same invoice.
alter table public.awaiting_signature
  drop constraint if exists awaiting_signature_user_id_invoice_id_status_key;

create unique index if not exists awaiting_signature_one_pending_per_invoice
  on public.awaiting_signature (user_id, invoice_id)
  where (status = 'pending');

-- ============================================================================
-- [SOURCE: 20260814100000_autopilot_execution_claims_canonical_receipt.sql]
-- ============================================================================
-- Third execution-safety review-fix pass, HIGH: the durable execution claim
-- row itself must BE the canonical execution receipt — carrying enough
-- provenance to answer "what did Duewatch decide, and why" — and that
-- provenance must exist BEFORE the external provider request is made, not
-- only after resolution. Checking a later Activity/events write's error is
-- not enough: if that write fails after a successful send, founder-facing
-- Evidence could disappear while the canonical receipt (this table) still
-- silently existed with none of that context in it.
--
-- This does NOT attempt to make the provider call and a Postgres write one
-- transaction (impossible: Resend is an external HTTP call). It instead
-- moves receipt-writing earlier: acquire_autopilot_execution_claim now
-- accepts the full canonical receipt (rule snapshot, ruleSnapshotHash,
-- factual basis, authorization evaluatedAt — user_id/invoice_id/rule_id/
-- action_type/idempotency_key/claimed_at were already real columns) and
-- persists it into `evidence` at INSERT time, before any send is attempted.
--
-- A new resolve_autopilot_execution_claim function replaces the raw
-- service_role UPDATE grant this table previously had: resolution now
-- jsonb-MERGES its evidence (provider_message_id / error) into the SAME
-- object rather than overwriting it, so the pre-send receipt is never
-- clobbered by the post-send write. This also narrows privileges: the
-- table's direct UPDATE grant to service_role is revoked, since every
-- resolution now goes exclusively through this SECURITY DEFINER function —
-- the same "inserts only via the function" discipline the original
-- migration already applied to INSERT.

drop function if exists public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text);
create or replace function public.acquire_autopilot_execution_claim(
  p_user_id uuid,
  p_invoice_id uuid,
  p_rule_id uuid,
  p_action_type text,
  p_idempotency_key text,
  -- Defaulted (not required) so the pre-existing 5-argument SQL test suite
  -- (supabase/tests/autopilot_execution_claims_test.sql) keeps working
  -- unmodified — both real callers (autopilot-scheduler,
  -- send-reminder-email) always pass this explicitly.
  p_receipt jsonb default '{}'::jsonb
) returns table(claim_id uuid, acquired boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim_id uuid;
begin
  if p_user_id is null or p_invoice_id is null or p_rule_id is null
     or p_action_type is null or trim(p_action_type) = ''
     or p_idempotency_key is null or trim(p_idempotency_key) = '' then
    raise exception 'acquire_autopilot_execution_claim requires user_id, invoice_id, rule_id, action_type, and idempotency_key';
  end if;

  -- Malformed/mismatched tenant identity fails closed: the invoice must
  -- actually belong to the claiming user. This is a trusted service-role
  -- caller, so this is defense-in-depth against a caller bug, not an
  -- external security boundary — but Phase 2A.1's own doctrine is that
  -- tenant ownership is structurally checked, never assumed from inputs.
  if not exists (
    select 1 from public.invoices where id = p_invoice_id and user_id = p_user_id
  ) then
    raise exception 'invoice % does not belong to user %', p_invoice_id, p_user_id;
  end if;

  -- The atomic core: two concurrent callers with the same identity
  -- serialize on this unique index. Exactly one INSERT wins; the loser's
  -- INSERT resolves to zero rows affected (ON CONFLICT DO NOTHING) rather
  -- than erroring, and falls through to the SELECT below to observe the
  -- winner's row deterministically once its transaction commits. The
  -- receipt is written in this SAME insert — before any send is attempted
  -- by either the winner or any loser.
  insert into public.autopilot_execution_claims (
    id, user_id, invoice_id, rule_id, action_type, idempotency_key, status, evidence, claimed_at
  ) values (
    gen_random_uuid(), p_user_id, p_invoice_id, p_rule_id, p_action_type, p_idempotency_key,
    'in_flight', coalesce(p_receipt, '{}'::jsonb), now()
  )
  on conflict (user_id, invoice_id, rule_id, action_type) do nothing
  returning id into v_claim_id;

  if v_claim_id is not null then
    return query select v_claim_id, true;
    return;
  end if;

  -- Did not win. A claim already exists for this identity — regardless of
  -- its current status (in_flight/sent/send_failed/uncertain), its mere
  -- existence is what blocks a second automatic attempt. This is the
  -- fail-closed behavior: an incomplete or uncertain prior execution is
  -- never treated as license to retry automatically.
  select id into v_claim_id
  from public.autopilot_execution_claims
  where user_id = p_user_id and invoice_id = p_invoice_id
    and rule_id = p_rule_id and action_type = p_action_type;

  return query select v_claim_id, false;
end;
$$;

revoke all on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb) from PUBLIC, anon, authenticated;
grant execute on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb) to service_role;

-- Resolution must MERGE into the existing evidence, never overwrite it —
-- the pre-send receipt (rule snapshot, factual basis, authorization) must
-- survive resolution; only the resolution-time facts (provider_message_id,
-- error text) are new information being added on top of it.
create or replace function public.resolve_autopilot_execution_claim(
  p_claim_id uuid,
  p_status text,
  p_provider_message_id text,
  p_evidence jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_claim_id is null or p_status is null then
    raise exception 'resolve_autopilot_execution_claim requires claim_id and status';
  end if;
  if p_status not in ('sent', 'send_failed', 'uncertain') then
    raise exception 'resolve_autopilot_execution_claim: invalid status %', p_status;
  end if;

  update public.autopilot_execution_claims
  set status = p_status,
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      evidence = coalesce(evidence, '{}'::jsonb) || coalesce(p_evidence, '{}'::jsonb),
      resolved_at = now()
  where id = p_claim_id;

  if not found then
    raise exception 'resolve_autopilot_execution_claim: no claim % found', p_claim_id;
  end if;
end;
$$;

revoke all on function public.resolve_autopilot_execution_claim(uuid, text, text, jsonb) from PUBLIC, anon, authenticated;
grant execute on function public.resolve_autopilot_execution_claim(uuid, text, text, jsonb) to service_role;

-- ---- privilege tightening: resolution no longer needs a raw table UPDATE
-- grant now that resolve_autopilot_execution_claim exists (SECURITY
-- DEFINER, executes as the function owner). Narrowing only — service_role
-- never had INSERT/DELETE here, and now loses direct UPDATE too.
revoke update on public.autopilot_execution_claims from service_role;

-- ---- privilege postconditions ----
do $post$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'autopilot_execution_claims'
      and grantee in ('PUBLIC', 'anon')
  ) then
    raise exception 'PUBLIC or anon retained a privilege on autopilot_execution_claims';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'autopilot_execution_claims'
      and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'authenticated retained a non-SELECT privilege on autopilot_execution_claims';
  end if;

  if has_table_privilege('service_role', 'public.autopilot_execution_claims', 'INSERT')
     or has_table_privilege('service_role', 'public.autopilot_execution_claims', 'DELETE')
     or has_table_privilege('service_role', 'public.autopilot_execution_claims', 'UPDATE') then
    raise exception 'service_role retained INSERT, DELETE, or direct UPDATE on autopilot_execution_claims (writes must go through acquire_autopilot_execution_claim / resolve_autopilot_execution_claim only)';
  end if;

  if not has_table_privilege('service_role', 'public.autopilot_execution_claims', 'SELECT') then
    raise exception 'service_role is missing SELECT on autopilot_execution_claims';
  end if;

  if has_function_privilege('anon', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'anon or authenticated retained EXECUTE on acquire_autopilot_execution_claim';
  end if;
  if not has_function_privilege('service_role', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'service_role is missing EXECUTE on acquire_autopilot_execution_claim';
  end if;

  if has_function_privilege('anon', 'public.resolve_autopilot_execution_claim(uuid, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.resolve_autopilot_execution_claim(uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'anon or authenticated retained EXECUTE on resolve_autopilot_execution_claim';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_autopilot_execution_claim(uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'service_role is missing EXECUTE on resolve_autopilot_execution_claim';
  end if;
end
$post$;

-- ============================================================================
-- [SOURCE: 20260816120000_payments_foundation.sql]
-- ============================================================================
-- Phase 2, Slice 1: immutable payment identity, explicit invoice allocations,
-- deterministic reversals, and lossless preservation of legacy aggregates.
--
-- This migration deliberately does not create Promise-to-Pay state. In
-- particular, every legacy row remains origin=legacy_carry_forward and is
-- therefore structurally distinguishable from founder-entered payment proof.



create schema if not exists duewatch_ops;

-- A durable, private snapshot proves that the backfill preserved the exact
-- aggregates it found. It is also the source for the migration report below.
create table if not exists duewatch_ops.payment_migration_invoice_snapshot (
  invoice_id uuid primary key,
  user_id uuid not null,
  original_amount numeric(12, 2) not null,
  original_amount_paid numeric(12, 2) not null,
  original_paid boolean not null,
  captured_at timestamptz not null default clock_timestamp()
);
revoke all on duewatch_ops.payment_migration_invoice_snapshot from public, anon, authenticated;

create table if not exists duewatch_ops.payment_migration_audit (
  id smallint primary key check (id = 1),
  generated_at timestamptz not null,
  invoices_with_preexisting_amount_paid bigint not null,
  reconstructed_invoices bigint not null,
  reconstructed_payment_rows bigint not null,
  carry_forward_invoices bigint not null,
  carry_forward_payment_rows bigint not null,
  amount_paid_mismatches bigint not null,
  inconsistent_paid_flags bigint not null,
  unknown_payment_dates bigint not null,
  unknown_currencies bigint not null
);
revoke all on duewatch_ops.payment_migration_audit from public, anon, authenticated;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recorded_by uuid references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  payment_date date,
  total_amount numeric(12, 2) not null check (total_amount > 0),
  currency text,
  method text,
  note text,
  origin text not null check (origin in ('founder_manual', 'legacy_carry_forward')),
  source_event_id uuid references public.events(id) on delete restrict,
  legacy_invoice_id uuid references public.invoices(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default clock_timestamp(),
  constraint payments_currency_format check (
    currency is null or (currency = upper(currency) and currency ~ '^[A-Z]{3}$')
  ),
  constraint payments_origin_facts_check check (
    (
      origin = 'founder_manual'
      and payment_date is not null
      and currency is not null
      and recorded_by is not null
      and recorded_by = user_id
      and source_event_id is null
      and legacy_invoice_id is null
    )
    or
    (
      origin = 'legacy_carry_forward'
      and recorded_by is null
      and ((source_event_id is not null)::integer + (legacy_invoice_id is not null)::integer = 1)
    )
  ),
  constraint payments_reversal_facts_check check (
    (reversed_at is null and reversed_by is null and reversal_reason is null)
    or
    (reversed_at is not null and reversed_by = user_id and nullif(trim(reversal_reason), '') is not null)
  )
);

comment on column public.payments.recorded_at is
  'System fact: when Duewatch stored the payment.';
comment on column public.payments.payment_date is
  'Founder/accounting fact: real-world payment date. Null only for legacy evidence where the date is unsupported.';
comment on column public.payments.origin is
  'legacy_carry_forward is preservation-only and must never qualify as Promise-to-Pay fulfillment evidence.';

create index if not exists payments_user_payment_date_idx
  on public.payments(user_id, payment_date desc);
create unique index if not exists payments_source_event_uidx
  on public.payments(source_event_id) where source_event_id is not null;
create unique index if not exists payments_legacy_invoice_uidx
  on public.payments(legacy_invoice_id) where legacy_invoice_id is not null;

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  amount numeric(12, 2) not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique(payment_id, invoice_id)
);

create index if not exists payment_allocations_invoice_id_idx
  on public.payment_allocations(invoice_id);

create or replace function duewatch_ops.validate_payment_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
begin
  if new.source_event_id is not null and not exists (
    select 1 from public.events e where e.id = new.source_event_id and e.user_id = new.user_id
  ) then raise exception 'Payment source event must belong to the same tenant'; end if;
  if new.legacy_invoice_id is not null and not exists (
    select 1 from public.invoices i where i.id = new.legacy_invoice_id and i.user_id = new.user_id
  ) then raise exception 'Legacy payment invoice must belong to the same tenant'; end if;
  return new;
end;
$$;

drop trigger if exists payments_validate_provenance on public.payments;
create trigger payments_validate_provenance
  before insert or update of user_id, source_event_id, legacy_invoice_id on public.payments
  for each row execute function duewatch_ops.validate_payment_provenance();
revoke all on function duewatch_ops.validate_payment_provenance() from public, anon, authenticated;

-- Every allocation derives ownership from its payment. This trigger is the
-- tenant/currency boundary even for a role that bypasses RLS.
create or replace function duewatch_ops.validate_payment_allocation()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_other_allocated numeric(12, 2);
begin
  if tg_op = 'UPDATE'
     and (new.payment_id, new.invoice_id) is distinct from (old.payment_id, old.invoice_id) then
    raise exception 'Payment allocation identity is immutable';
  end if;

  select * into v_payment
  from public.payments
  where id = new.payment_id
  for update;
  if not found then
    raise exception 'Payment does not exist';
  end if;
  if v_payment.reversed_at is not null then
    raise exception 'Cannot allocate a reversed payment';
  end if;

  select * into v_invoice
  from public.invoices
  where id = new.invoice_id
  for update;
  if not found then
    raise exception 'Invoice does not exist';
  end if;
  if v_invoice.user_id <> v_payment.user_id then
    raise exception 'Payment and invoice must belong to the same tenant';
  end if;
  if v_invoice.currency is distinct from v_payment.currency then
    raise exception 'Payment and invoice currencies must match exactly';
  end if;

  select coalesce(sum(a.amount), 0)::numeric(12, 2)
  into v_other_allocated
  from public.payment_allocations a
  where a.payment_id = new.payment_id
    and (tg_op <> 'UPDATE' or a.id <> old.id);

  if v_other_allocated + new.amount > v_payment.total_amount then
    raise exception 'Allocation total exceeds payment total';
  end if;
  if v_payment.origin = 'founder_manual'
     and v_invoice.amount_paid + new.amount > v_invoice.amount then
    raise exception 'Allocation would overpay invoice';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_allocations_validate on public.payment_allocations;
create trigger payment_allocations_validate
  before insert or update on public.payment_allocations
  for each row execute function duewatch_ops.validate_payment_allocation();
revoke all on function duewatch_ops.validate_payment_allocation() from public, anon, authenticated;

-- The application never edits or deletes allocations. This is defense in
-- depth for owner-side mistakes and keeps ledger facts append-only.
create or replace function duewatch_ops.reject_payment_allocation_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
begin
  raise exception 'Payment allocations are immutable';
end;
$$;

drop trigger if exists payment_allocations_immutable on public.payment_allocations;
create trigger payment_allocations_immutable
  before update or delete on public.payment_allocations
  for each row execute function duewatch_ops.reject_payment_allocation_mutation();
revoke all on function duewatch_ops.reject_payment_allocation_mutation() from public, anon, authenticated;

-- A deferred check permits payment + allocations to be inserted in one
-- transaction while proving at commit that no unallocated remainder exists.
create or replace function duewatch_ops.assert_payment_fully_allocated()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_payment_id uuid;
  v_total numeric(12, 2);
  v_allocated numeric(12, 2);
begin
  if tg_table_name = 'payments' then
    v_payment_id := coalesce(new.id, old.id);
  else
    v_payment_id := coalesce(new.payment_id, old.payment_id);
  end if;
  select total_amount into v_total from public.payments where id = v_payment_id;
  if not found then
    return null;
  end if;
  select coalesce(sum(amount), 0)::numeric(12, 2)
  into v_allocated
  from public.payment_allocations
  where payment_id = v_payment_id;
  if v_allocated <> v_total then
    raise exception 'Payment must be fully and explicitly allocated (payment %, total %, allocated %)',
      v_payment_id, v_total, v_allocated;
  end if;
  return null;
end;
$$;

drop trigger if exists payments_fully_allocated on public.payments;
create constraint trigger payments_fully_allocated
  after insert or update of total_amount on public.payments
  deferrable initially deferred
  for each row execute function duewatch_ops.assert_payment_fully_allocated();

drop trigger if exists payment_allocations_fully_allocated on public.payment_allocations;
create constraint trigger payment_allocations_fully_allocated
  after insert or update or delete on public.payment_allocations
  deferrable initially deferred
  for each row execute function duewatch_ops.assert_payment_fully_allocated();
revoke all on function duewatch_ops.assert_payment_fully_allocated() from public, anon, authenticated;

-- Existing invoices remain readable through amount_paid/paid, but browser and
-- service-role callers cannot mutate those aggregates directly after this
-- migration. SECURITY DEFINER payment/import functions still execute as their
-- owner and are independently validated here.
create or replace function duewatch_ops.guard_invoice_payment_aggregates()
returns trigger
language plpgsql
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_has_allocations boolean;
begin
  if new.amount_paid < 0 or new.amount_paid > new.amount then
    raise exception 'Invoice amount_paid must remain between zero and amount';
  end if;

  if tg_op = 'INSERT' then
    if current_user in ('authenticated', 'anon', 'service_role')
       and (new.amount_paid <> 0 or new.paid) then
      raise exception 'Invoice payment aggregates may only be initialized by a hardened database function';
    end if;
    if (new.amount_paid > 0 or new.paid)
       and new.paid is distinct from (new.amount > 0 and new.amount_paid = new.amount) then
      raise exception 'Invoice paid flag is inconsistent with amount_paid';
    end if;
    return new;
  end if;

  if current_user in ('authenticated', 'anon', 'service_role')
     and (new.amount_paid, new.paid) is distinct from (old.amount_paid, old.paid) then
    raise exception 'Invoice payment aggregates may only be changed by payment RPCs';
  end if;

  if (new.amount, new.currency) is distinct from (old.amount, old.currency) then
    select exists(
      select 1 from public.payment_allocations where invoice_id = old.id
    ) into v_has_allocations;
    if v_has_allocations then
      raise exception 'Invoice amount and currency are immutable after a payment allocation exists';
    end if;
  end if;

  if (new.amount_paid, new.paid, new.amount) is distinct from (old.amount_paid, old.paid, old.amount)
     and new.paid is distinct from (new.amount > 0 and new.amount_paid = new.amount) then
    raise exception 'Invoice paid flag is inconsistent with amount_paid';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_guard_payment_aggregates on public.invoices;
create trigger invoices_guard_payment_aggregates
  before insert or update of amount, amount_paid, paid, currency on public.invoices
  for each row execute function duewatch_ops.guard_invoice_payment_aggregates();
revoke all on function duewatch_ops.guard_invoice_payment_aggregates() from public, anon, authenticated;

-- Import persistence can create an invoice with a supported aggregate but no
-- historical payment identity. Capture that aggregate immediately as one
-- preservation-only legacy row; do not invent actor, date, or currency.
create or replace function duewatch_ops.capture_inserted_invoice_payment_aggregate()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_payment_id uuid;
begin
  if new.amount_paid <= 0 then
    return new;
  end if;
  insert into public.payments(
    user_id, recorded_by, recorded_at, payment_date, total_amount, currency,
    method, note, origin, legacy_invoice_id
  ) values (
    new.user_id, null, clock_timestamp(), new.payment_date, new.amount_paid,
    new.currency, null, null, 'legacy_carry_forward', new.id
  )
  on conflict (legacy_invoice_id) where legacy_invoice_id is not null do nothing
  returning id into v_payment_id;

  if v_payment_id is not null then
    insert into public.payment_allocations(payment_id, invoice_id, amount)
    values (v_payment_id, new.id, new.amount_paid);
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_capture_initial_payment_aggregate on public.invoices;
create trigger invoices_capture_initial_payment_aggregate
  after insert on public.invoices
  for each row execute function duewatch_ops.capture_inserted_invoice_payment_aggregate();
revoke all on function duewatch_ops.capture_inserted_invoice_payment_aggregate() from public, anon, authenticated;

-- Hardened founder write. There is intentionally no user_id argument: tenant
-- identity comes only from auth.uid(). The full total must be allocated.
create or replace function public.record_payment(
  p_payment_date date,
  p_total_amount numeric,
  p_currency text,
  p_allocations jsonb,
  p_method text default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment_id uuid;
  v_item jsonb;
  v_invoice public.invoices%rowtype;
  v_invoice_id uuid;
  v_amount numeric(12, 2);
  v_allocated numeric(12, 2) := 0;
  v_count integer := 0;
  v_allocation_id uuid;
  v_was_paid boolean;
  v_now_paid boolean;
  v_results jsonb := '[]'::jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_payment_date is null then raise exception 'Payment date is required'; end if;
  if p_payment_date > current_date then raise exception 'Payment date cannot be in the future'; end if;
  if p_total_amount is null or p_total_amount <= 0 then raise exception 'Payment total must be positive'; end if;
  if p_total_amount <> round(p_total_amount, 2) then raise exception 'Payment total has more than two decimal places'; end if;
  if p_currency is null or p_currency <> upper(trim(p_currency)) or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'A normalized three-letter currency is required';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'At least one explicit allocation is required';
  end if;
  if jsonb_array_length(p_allocations) > 100 then raise exception 'Too many allocations'; end if;
  if length(coalesce(p_method, '')) > 120 or length(coalesce(p_note, '')) > 2000 then
    raise exception 'Payment method or note is too long';
  end if;

  begin
    for v_item in select value from jsonb_array_elements(p_allocations) loop
      if coalesce(v_item->>'invoice_id', '') = '' or coalesce(v_item->>'amount', '') = '' then
        raise exception 'invalid';
      end if;
      v_invoice_id := (v_item->>'invoice_id')::uuid;
      v_amount := (v_item->>'amount')::numeric(12, 2);
      if v_amount <= 0 or (v_item->>'amount')::numeric <> v_amount then raise exception 'invalid'; end if;
      v_allocated := v_allocated + v_amount;
      v_count := v_count + 1;
    end loop;
  exception when others then
    raise exception 'Every allocation requires a valid invoice ID and positive two-decimal amount';
  end;

  if v_count <> (
    select count(distinct (value->>'invoice_id')) from jsonb_array_elements(p_allocations)
  ) then raise exception 'Each invoice may be allocated only once per payment'; end if;
  if v_allocated <> p_total_amount then
    raise exception 'Explicit allocation total must equal payment total';
  end if;

  -- Deterministic lock order prevents deadlocks for multi-invoice payments.
  for v_invoice in
    select i.*
    from public.invoices i
    join (
      select (value->>'invoice_id')::uuid as invoice_id
      from jsonb_array_elements(p_allocations)
    ) requested on requested.invoice_id = i.id
    order by i.id
    for update of i
  loop
    if v_invoice.user_id <> v_user_id then raise exception 'Invoice does not belong to authenticated tenant'; end if;
    if v_invoice.amount_paid < 0 or v_invoice.amount_paid > v_invoice.amount then
      raise exception 'Invoice has an invalid existing payment aggregate';
    end if;
    if v_invoice.paid is distinct from (v_invoice.amount > 0 and v_invoice.amount_paid = v_invoice.amount) then
      raise exception 'Invoice has an inconsistent existing paid flag';
    end if;
    if v_invoice.currency is null then
      if v_invoice.amount_paid <> 0 or exists (
        select 1 from public.payment_allocations a where a.invoice_id = v_invoice.id
      ) then
        raise exception 'Invoice has payment history with an unknown currency and requires review';
      end if;
      -- The founder supplied p_currency explicitly for this payment. Initializing
      -- a previously-unpaid legacy invoice here is supported fact, not a default.
      update public.invoices set currency = p_currency where id = v_invoice.id;
      v_invoice.currency := p_currency;
    elsif v_invoice.currency <> p_currency then
      raise exception 'Payment and invoice currencies must match exactly';
    end if;
  end loop;
  if not found or v_count <> (
    select count(*) from public.invoices i
    where i.id in (select (value->>'invoice_id')::uuid from jsonb_array_elements(p_allocations))
  ) then raise exception 'One or more invoices do not exist'; end if;

  insert into public.payments(
    user_id, recorded_by, payment_date, total_amount, currency, method, note, origin
  ) values (
    v_user_id, v_user_id, p_payment_date, p_total_amount, p_currency,
    nullif(trim(p_method), ''), nullif(trim(p_note), ''), 'founder_manual'
  ) returning id into v_payment_id;

  for v_item in select value from jsonb_array_elements(p_allocations) loop
    v_invoice_id := (v_item->>'invoice_id')::uuid;
    v_amount := (v_item->>'amount')::numeric(12, 2);
    select paid into v_was_paid from public.invoices where id = v_invoice_id;

    insert into public.payment_allocations(payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, v_amount)
    returning id into v_allocation_id;

    update public.invoices
    set amount_paid = amount_paid + v_amount,
        paid = (amount > 0 and amount_paid + v_amount = amount)
    where id = v_invoice_id
    returning paid into v_now_paid;

    insert into public.events(user_id, event_type, invoice_id, evidence)
    values (
      v_user_id, 'payment_recorded', v_invoice_id,
      jsonb_build_object(
        'payment_id', v_payment_id, 'allocation_id', v_allocation_id,
        'amount', v_amount, 'currency', p_currency,
        'payment_date', p_payment_date, 'origin', 'founder_manual'
      )
    );
    if not v_was_paid and v_now_paid then
      insert into public.events(user_id, event_type, invoice_id, evidence)
      values (
        v_user_id, 'invoice_marked_paid', v_invoice_id,
        jsonb_build_object('payment_id', v_payment_id, 'allocation_id', v_allocation_id)
      );
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'allocation_id', v_allocation_id, 'invoice_id', v_invoice_id,
      'amount', v_amount,
      'invoice_currency', (select currency from public.invoices where id = v_invoice_id),
      'invoice_amount_paid', (select amount_paid from public.invoices where id = v_invoice_id),
      'invoice_paid', v_now_paid
    ));
  end loop;

  return jsonb_build_object('payment_id', v_payment_id, 'allocations', v_results);
end;
$$;

create or replace function public.reverse_payment(
  p_payment_id uuid,
  p_reversal_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_allocation record;
  v_reversed_at timestamptz := clock_timestamp();
  v_results jsonb := '[]'::jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_payment_id is null then raise exception 'Payment ID is required'; end if;
  if nullif(trim(p_reversal_reason), '') is null then raise exception 'Reversal reason is required'; end if;
  if length(p_reversal_reason) > 1000 then raise exception 'Reversal reason is too long'; end if;

  select * into v_payment
  from public.payments
  where id = p_payment_id
  for update;
  if not found or v_payment.user_id <> v_user_id then raise exception 'Payment not found for authenticated tenant'; end if;
  if v_payment.reversed_at is not null then raise exception 'Payment has already been reversed'; end if;

  -- Lock all affected invoices in UUID order before changing any aggregate.
  perform i.id
  from public.invoices i
  join public.payment_allocations a on a.invoice_id = i.id
  where a.payment_id = p_payment_id
  order by i.id
  for update of i;

  for v_allocation in
    select a.id, a.invoice_id, a.amount, i.amount_paid, i.amount
    from public.payment_allocations a
    join public.invoices i on i.id = a.invoice_id
    where a.payment_id = p_payment_id
    order by i.id
  loop
    if v_allocation.amount_paid < v_allocation.amount then
      raise exception 'Invoice aggregate cannot safely reverse this payment';
    end if;
  end loop;

  update public.payments
  set reversed_at = v_reversed_at,
      reversed_by = v_user_id,
      reversal_reason = trim(p_reversal_reason)
  where id = p_payment_id;

  for v_allocation in
    select a.id, a.invoice_id, a.amount
    from public.payment_allocations a
    where a.payment_id = p_payment_id
    order by a.invoice_id
  loop
    update public.invoices
    set amount_paid = amount_paid - v_allocation.amount,
        paid = (amount > 0 and amount_paid - v_allocation.amount = amount)
    where id = v_allocation.invoice_id;

    insert into public.events(user_id, event_type, invoice_id, evidence)
    values (
      v_user_id, 'payment_reversed', v_allocation.invoice_id,
      jsonb_build_object(
        'payment_id', p_payment_id, 'allocation_id', v_allocation.id,
        'amount', v_allocation.amount, 'currency', v_payment.currency,
        'reversal_reason', trim(p_reversal_reason)
      )
    );
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'invoice_id', v_allocation.invoice_id,
      'invoice_amount_paid', (select amount_paid from public.invoices where id = v_allocation.invoice_id),
      'invoice_paid', (select paid from public.invoices where id = v_allocation.invoice_id)
    ));
  end loop;

  return jsonb_build_object(
    'payment_id', p_payment_id, 'reversed_at', v_reversed_at, 'invoices', v_results
  );
end;
$$;

-- Reads are tenant-scoped by RLS; writes are RPC-only.
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;

drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists payment_allocations_select_own on public.payment_allocations;
create policy payment_allocations_select_own on public.payment_allocations
  for select to authenticated
  using (exists (
    select 1 from public.payments p
    where p.id = payment_id and p.user_id = (select auth.uid())
  ));

revoke all on public.payments, public.payment_allocations from public, anon, authenticated;
grant select on public.payments, public.payment_allocations to authenticated;
grant select on public.payments, public.payment_allocations to service_role;

revoke all on function public.record_payment(date, numeric, text, jsonb, text, text)
  from public, anon;
grant execute on function public.record_payment(date, numeric, text, jsonb, text, text)
  to authenticated;
revoke all on function public.reverse_payment(uuid, text) from public, anon;
grant execute on function public.reverse_payment(uuid, text) to authenticated;

-- Reject impossible legacy aggregates rather than losing or normalizing them.
do $preflight$
declare
  v_invalid bigint;
begin
  select count(*) into v_invalid
  from public.invoices
  where amount_paid < 0 or amount_paid > amount;
  if v_invalid > 0 then
    raise exception 'Payments migration blocked: % invoice aggregates are negative or overpaid', v_invalid;
  end if;
end
$preflight$;

insert into duewatch_ops.payment_migration_invoice_snapshot(
  invoice_id, user_id, original_amount, original_amount_paid, original_paid
)
select id, user_id, amount, amount_paid, paid
from public.invoices
on conflict (invoice_id) do nothing;

-- Deterministic reconstruction: a valid payment_recorded amount is preferred.
-- invoice_marked_paid is used only when no payment_recorded event exists at
-- all for that invoice. If supported candidate value exceeds the preserved
-- aggregate, none of those candidates are reconstructed and the entire amount
-- remains one carry-forward, avoiding event + carry-forward double counting.
with valid_candidates as (
  select
    e.id as event_id, e.invoice_id, e.user_id, e.created_at,
    (trim(e.evidence->>'amount'))::numeric as amount,
    e.event_type,
    i.currency
  from public.events e
  join public.invoices i on i.id = e.invoice_id and i.user_id = e.user_id
  join duewatch_ops.payment_migration_invoice_snapshot s on s.invoice_id = i.id
  where s.original_amount_paid > 0
    and e.event_type in ('payment_recorded', 'invoice_marked_paid')
    and coalesce(trim(e.evidence->>'amount'), '') ~ '^\d+(\.\d{1,2})?$'
    and (trim(e.evidence->>'amount'))::numeric > 0
    and (trim(e.evidence->>'amount'))::numeric <= 9999999999.99
), preferred_candidates as (
  select c.*
  from valid_candidates c
  where c.event_type = 'payment_recorded'
     or (
       c.event_type = 'invoice_marked_paid'
       and not exists (
         select 1 from public.events pe
         where pe.invoice_id = c.invoice_id and pe.event_type = 'payment_recorded'
       )
     )
), safe_invoices as (
  select c.invoice_id
  from preferred_candidates c
  join duewatch_ops.payment_migration_invoice_snapshot s on s.invoice_id = c.invoice_id
  group by c.invoice_id, s.original_amount_paid
  having sum(c.amount) <= s.original_amount_paid
)
insert into public.payments(
  user_id, recorded_by, recorded_at, payment_date, total_amount, currency,
  method, note, origin, source_event_id
)
select
  c.user_id, null, c.created_at, null, c.amount, c.currency,
  null, null, 'legacy_carry_forward', c.event_id
from preferred_candidates c
join safe_invoices s on s.invoice_id = c.invoice_id
on conflict (source_event_id) where source_event_id is not null do nothing;

insert into public.payment_allocations(payment_id, invoice_id, amount)
select p.id, e.invoice_id, p.total_amount
from public.payments p
join public.events e on e.id = p.source_event_id
where p.origin = 'legacy_carry_forward'
  and p.source_event_id is not null
  and not exists (
    select 1 from public.payment_allocations a where a.payment_id = p.id
  );

with residuals as (
  select
    s.invoice_id, s.user_id, s.original_amount_paid,
    (s.original_amount_paid - coalesce(sum(a.amount), 0))::numeric(12, 2) as residual,
    count(*) filter (where p.source_event_id is not null) as reconstructed_count
  from duewatch_ops.payment_migration_invoice_snapshot s
  left join public.payment_allocations a on a.invoice_id = s.invoice_id
  left join public.payments p on p.id = a.payment_id and p.origin = 'legacy_carry_forward'
  group by s.invoice_id, s.user_id, s.original_amount_paid
)
insert into public.payments(
  user_id, recorded_by, recorded_at, payment_date, total_amount, currency,
  method, note, origin, legacy_invoice_id
)
select
  r.user_id, null, clock_timestamp(),
  case when r.reconstructed_count = 0 then i.payment_date else null end,
  r.residual, i.currency, null, null, 'legacy_carry_forward', r.invoice_id
from residuals r
join public.invoices i on i.id = r.invoice_id
where r.residual > 0
on conflict (legacy_invoice_id) where legacy_invoice_id is not null do nothing;

insert into public.payment_allocations(payment_id, invoice_id, amount)
select p.id, p.legacy_invoice_id, p.total_amount
from public.payments p
where p.origin = 'legacy_carry_forward'
  and p.legacy_invoice_id is not null
  and not exists (
    select 1 from public.payment_allocations a where a.payment_id = p.id
  );

insert into duewatch_ops.payment_migration_audit(
  id, generated_at, invoices_with_preexisting_amount_paid,
  reconstructed_invoices, reconstructed_payment_rows,
  carry_forward_invoices, carry_forward_payment_rows,
  amount_paid_mismatches, inconsistent_paid_flags,
  unknown_payment_dates, unknown_currencies
)
select
  1, clock_timestamp(),
  count(distinct s.invoice_id) filter (where s.original_amount_paid > 0),
  count(distinct s.invoice_id) filter (where p.source_event_id is not null),
  count(distinct p.id) filter (where p.source_event_id is not null),
  count(distinct s.invoice_id) filter (where p.legacy_invoice_id is not null),
  count(distinct p.id) filter (where p.legacy_invoice_id is not null),
  count(distinct s.invoice_id) filter (
    where s.original_amount_paid <> coalesce((
      select sum(a2.amount)
      from public.payment_allocations a2
      join public.payments p2 on p2.id = a2.payment_id
      where a2.invoice_id = s.invoice_id and p2.reversed_at is null
    ), 0)
  ),
  count(*) filter (
    where s.original_paid is distinct from (s.original_amount > 0 and s.original_amount_paid = s.original_amount)
  ),
  count(distinct p.id) filter (where p.payment_date is null),
  count(distinct p.id) filter (where p.currency is null)
from duewatch_ops.payment_migration_invoice_snapshot s
left join public.payment_allocations a on a.invoice_id = s.invoice_id
left join public.payments p on p.id = a.payment_id and p.origin = 'legacy_carry_forward'
on conflict (id) do update set
  generated_at = excluded.generated_at,
  invoices_with_preexisting_amount_paid = excluded.invoices_with_preexisting_amount_paid,
  reconstructed_invoices = excluded.reconstructed_invoices,
  reconstructed_payment_rows = excluded.reconstructed_payment_rows,
  carry_forward_invoices = excluded.carry_forward_invoices,
  carry_forward_payment_rows = excluded.carry_forward_payment_rows,
  amount_paid_mismatches = excluded.amount_paid_mismatches,
  inconsistent_paid_flags = excluded.inconsistent_paid_flags,
  unknown_payment_dates = excluded.unknown_payment_dates,
  unknown_currencies = excluded.unknown_currencies;

do $postflight$
declare
  v_mismatches bigint;
begin
  select amount_paid_mismatches into v_mismatches
  from duewatch_ops.payment_migration_audit where id = 1;
  if v_mismatches <> 0 then
    raise exception 'Payments migration invariant failed: % pre/post amount_paid mismatches', v_mismatches;
  end if;
end
$postflight$;



-- ============================================================================
-- [SOURCE: sections/20260822000002_final_canonical_assertions.sql]
-- ============================================================================
-- [SECTION: final-canonical-assertions begin]
-- ------------------------------------------------------------
-- Final canonical postconditions. Inlined by the assembler IMMEDIATELY
-- BEFORE the baseline's final `commit;`, so every assertion whose
-- failure means "convergence/construction did not succeed" executes
-- INSIDE the mutation transaction: a failure here rolls the entire
-- baseline back, for both fresh construction and legacy convergence.
--
-- Deliberately does NOT call duewatch_ops.unknown_client_foreign_keys():
-- that function's final definition (refreshed by the archived
-- 20260803021842) is NOT complete for the post-import schema — its
-- allowlist predates the import tables and does not contain
-- import_rows' composite/foreign-key pairs referencing clients and
-- invoices (the same fact that made 20260811000000 non-replay-safe).
-- Calling it here would misreport the import tables' own FKs as unknown.
-- The assertions below check expected facts directly instead.
--
-- DORMANT LIMITATION (documented, intentional): execute_client_dedup()
-- calls unknown_client_foreign_keys() as its blocking gate, and on the
-- canonical state that gate returns the import_rows FKs as "unknown".
-- Client dedup must not be enabled until import_rows reference behavior
-- during client/invoice merge/delete is reviewed and proven. The current
-- unknown-FK gate intentionally fails closed. (Regression-proven by
-- PROOF 15 in run_canonical_proofs.sh.)
-- ------------------------------------------------------------

do $final_canonical_assertions$
declare
  v_fk_def text;
  v_fk_valid boolean;
  v_idx_def text;
begin
  -- Invoice/client composite tenant FK: exact definition AND validated
  -- (convalidated = true asserted explicitly, not just implied by name).
  select pg_get_constraintdef(oid), con.convalidated into v_fk_def, v_fk_valid
  from pg_constraint con
  where conrelid = 'public.invoices'::regclass
    and conname = 'invoices_user_id_client_id_fkey'
    and contype = 'f';
  if v_fk_def is null
    or v_fk_def not like 'FOREIGN KEY (user_id, client_id) REFERENCES clients(user_id, id)%'
    or v_fk_def not like '%ON DELETE SET NULL (client_id)%' then
    raise exception 'FINAL ASSERTION FAILED: invoice/client composite tenant FK is not canonical';
  end if;
  if v_fk_valid is distinct from true then
    raise exception 'FINAL ASSERTION FAILED: invoice/client composite tenant FK is not validated (convalidated=%)', v_fk_valid;
  end if;

  -- Pending-only awaiting_signature uniqueness; legacy constraint gone.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.awaiting_signature'::regclass
      and conname = 'awaiting_signature_user_id_invoice_id_status_key'
  ) then
    raise exception 'FINAL ASSERTION FAILED: legacy awaiting_signature three-column unique still present';
  end if;
  -- The pending-only index is asserted by its FULL definition (unique,
  -- exact key columns (user_id, invoice_id), predicate equivalent to
  -- status = 'pending') — not merely by its name existing. A
  -- same-name/wrong-definition index is rejected.
  select pg_get_indexdef(i.oid) into v_idx_def
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join pg_class t on t.oid = x.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname = 'awaiting_signature'
    and i.relname = 'awaiting_signature_one_pending_per_invoice';
  if v_idx_def is distinct from
     'CREATE UNIQUE INDEX awaiting_signature_one_pending_per_invoice ON public.awaiting_signature USING btree (user_id, invoice_id) WHERE (status = ''pending''::text)' then
    raise exception 'FINAL ASSERTION FAILED: pending-only awaiting_signature unique index missing or not the exact canonical definition: %', coalesce(v_idx_def, '<missing>');
  end if;

  -- Canonical era tables exist.
  if exists (
    select 1 from (values
      ('autopilot_execution_claims'), ('payments'), ('payment_allocations'),
      ('import_runs'), ('import_batches'), ('import_rows'), ('import_events'),
      ('client_source_identities'), ('client_dedup_runs'),
      ('client_merge_candidates'), ('client_merge_audit'), ('autopilot_settings'),
      ('autopilot_rules')
    ) as expected(tablename)
    where to_regclass(format('public.%I', tablename)) is null
  ) then
    raise exception 'FINAL ASSERTION FAILED: one or more canonical public tables are missing';
  end if;

  -- Canonical RPC EXISTENCE/completeness check (presence of the four
  -- function names only — signatures/definitions/ACLs are not compared
  -- here; definition fidelity is proven structurally by proofs 3+4).
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in
      ('acquire_autopilot_execution_claim', 'resolve_autopilot_execution_claim',
       'record_payment', 'reverse_payment')
    having count(*) = 4
  ) then
    raise exception 'FINAL ASSERTION FAILED: canonical RPC set incomplete';
  end if;

  -- Canonical policy EXISTENCE/completeness check (presence of the five
  -- (table, policy) pairs only — policy definitions are not compared
  -- here).
  if exists (
    select 1 from (values
      ('payments', 'payments_select_own'),
      ('payment_allocations', 'payment_allocations_select_own'),
      ('autopilot_execution_claims', 'autopilot_execution_claims_select_own'),
      ('autopilot_settings', 'autopilot_settings_own'),
      ('autopilot_rules', 'autopilot_rules_own')
    ) as expected(tablename, policyname)
    where not exists (
      select 1 from pg_policies p2
      where p2.schemaname = 'public'
        and p2.tablename = expected.tablename
        and p2.policyname = expected.policyname
    )
  ) then
    raise exception 'FINAL ASSERTION FAILED: one or more canonical policies are missing';
  end if;

  raise notice 'final canonical assertions: all passed (inside the mutation transaction, before commit)';
end
$final_canonical_assertions$;
-- [SECTION: final-canonical-assertions end]

commit;
