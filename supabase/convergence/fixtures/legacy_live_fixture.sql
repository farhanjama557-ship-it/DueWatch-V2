-- ============================================================================
-- DueWatch — legacy-live fixture (verified production baseline state).
--
-- Reproduces, on a disposable database, the VERIFIED legacy production
-- state as inspected 2026-08-22:
--
--   * the ten baseline public tables exactly as the historical schema.sql
--     lineage created them (profiles, clients, invoices, line_items,
--     reminders, events, awaiting_signature, autopilot_runs,
--     autopilot_settings, autopilot_rules);
--   * invoices.client_id as a single-column FK to clients(id)
--     ON DELETE CASCADE — the verified live drift from schema.sql's
--     SET NULL;
--   * awaiting_signature with the legacy three-column
--     unique(user_id, invoice_id, status) — the pre-pending-only shape;
--   * autopilot_settings / autopilot_rules with the verified live DDL
--     and policies;
--   * NONE of the post-baseline-era objects (no duewatch_ops, no import
--     tables, no execution claims, no payments);
--   * no supabase_migrations metadata whatsoever.
--
-- Column-level facts beyond the autopilot tables, the invoices FK, and
-- the awaiting_signature constraint were not individually verified on
-- live; the fixture therefore carries the schema.sql lineage columns for
-- the eight base tables. The convergence preflight requires EXACT
-- equality with that shape (full structural fingerprint): if the live
-- database differs in ANY way — including additively (an extra column,
-- index, policy, or object) — convergence refuses before any mutation and
-- the fingerprint must be re-verified against live before the window
-- proceeds. The baseline's `add column if not exists` statements exist
-- for FRESH construction ordering, not as a license for unverified live
-- drift.
--
-- Expects: a database with the Supabase auth schema bootstrapped
-- (auth.users with a primary key) and pgcrypto available.
--
-- Includes minimal data rows so constraint transitions (FK replacement,
-- uniqueness replacement, dedup backfill, source-identity backfill)
-- execute against real rows rather than empty tables.
-- ============================================================================

create extension if not exists pgcrypto;

-- The historical schema.sql body, verbatim.
\ir ../../migrations_legacy/schema.sql

-- --- verified live drift #1: invoice→client FK is ON DELETE CASCADE ------
alter table public.invoices
  drop constraint invoices_client_id_fkey;
alter table public.invoices
  add constraint invoices_client_id_fkey
  foreign key (client_id) references public.clients (id) on delete cascade;

-- --- verified live drift #2: legacy three-column awaiting uniqueness -----
-- (schema.sql already creates this constraint; re-assert it exists with the
-- legacy definition for clarity and fail-fast if the archived schema.sql
-- ever changes underneath us.)
do $assert_legacy_awaiting$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.awaiting_signature'::regclass
      and conname = 'awaiting_signature_user_id_invoice_id_status_key'
  ) then
    raise exception 'fixture drift: archived schema.sql no longer creates the legacy awaiting_signature three-column unique constraint';
  end if;
end
$assert_legacy_awaiting$;

-- --- verified live autopilot tables (exact DDL, policies, no more) --------
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

alter table public.autopilot_settings enable row level security;
alter table public.autopilot_rules enable row level security;

create policy "autopilot_settings_own" on public.autopilot_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "autopilot_rules_own" on public.autopilot_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Minimal representative data.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'founder@legacy.test');
insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'other@legacy.test');

insert into public.profiles (id, email, full_name) values
  ('11111111-1111-1111-1111-111111111111', 'founder@legacy.test', 'Legacy Founder'),
  ('22222222-2222-2222-2222-222222222222', 'other@legacy.test', 'Other Founder')
on conflict (id) do nothing;

insert into public.clients (id, user_id, name, email, phone, company) values
  ('aaaaaaa1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Atlas Creative', 'billing@atlas.test', '5551230001', 'Atlas Creative LLC'),
  ('aaaaaaa1-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Atlas Creative', 'billing@atlas.test', null, null),
  ('aaaaaaa2-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Other Tenant Client', 'ops@other.test', null, null);

insert into public.invoices (id, user_id, client_id, inv_num, amount, amount_paid, inv_date, due_date, paid) values
  ('bbbbbbb1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000001', 'INV-221', 2400.00, 0, date '2026-08-01', date '2026-08-20', false),
  ('bbbbbbb1-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000002', 'INV-222', 900.00, 900.00, date '2026-07-01', date '2026-07-15', true),
  ('bbbbbbb1-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', null, 'INV-223', 300.00, 0, date '2026-08-10', date '2026-09-10', false);

insert into public.line_items (invoice_id, user_id, description, quantity, unit_price) values
  ('bbbbbbb1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Brand system', 1, 2400.00),
  ('bbbbbbb1-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Retainer', 1, 300.00);

insert into public.reminders (invoice_id, user_id, title, detail) values
  ('bbbbbbb1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Friendly reminder', 'Invoice INV-221 is 5 days overdue');

insert into public.events (user_id, event_type, invoice_id) values
  ('11111111-1111-1111-1111-111111111111', 'invoice_created', 'bbbbbbb1-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111', 'reminder_sent', 'bbbbbbb1-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111', 'invoice_marked_paid', 'bbbbbbb1-0000-0000-0000-000000000002');

-- One historical approved ask and one open pending ask: exactly the rows
-- the legacy three-column constraint allowed and the pending-only index
-- must continue to allow (approved history + a single pending).
insert into public.awaiting_signature (user_id, invoice_id, action_type, recommended_tone, draft_content, ai_reason, status, resolved_at) values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbb1-0000-0000-0000-000000000001', 'send_reminder', 'friendly', 'Legacy approved draft', 'First follow-up rule', 'approved', now() - interval '2 days');
insert into public.awaiting_signature (user_id, invoice_id, action_type, recommended_tone, draft_content, ai_reason, status) values
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbb1-0000-0000-0000-000000000003', 'send_reminder', 'firm', 'Legacy pending draft', 'Final notice rule', 'pending');

insert into public.autopilot_settings (user_id, enabled, approval_required) values
  ('11111111-1111-1111-1111-111111111111', true, true),
  ('22222222-2222-2222-2222-222222222222', false, true);

insert into public.autopilot_rules (user_id, name, trigger_type, trigger_days, tone, enabled, sort_order) values
  ('11111111-1111-1111-1111-111111111111', 'Friendly reminder', 'before_due', 3, 'friendly', true, 0),
  ('11111111-1111-1111-1111-111111111111', 'First follow-up', 'after_due', 5, 'friendly', true, 1),
  ('11111111-1111-1111-1111-111111111111', 'Firm reminder', 'after_due', 15, 'firm', true, 2),
  ('11111111-1111-1111-1111-111111111111', 'Final notice', 'after_due', 30, 'firm', true, 3);

insert into public.autopilot_runs (user_id, status, invoices_checked, reminders_drafted, reminders_skipped, errors, started_at, completed_at) values
  ('11111111-1111-1111-1111-111111111111', 'completed', 3, 1, 0, 0, now() - interval '1 day', now() - interval '1 day' + interval '4 seconds');
