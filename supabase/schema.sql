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
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  invoice_number text,
  status text not null default 'draft',
  issue_date date,
  due_date date,
  amount numeric(12, 2) not null default 0,
  notes text,
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
