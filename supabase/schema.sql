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
