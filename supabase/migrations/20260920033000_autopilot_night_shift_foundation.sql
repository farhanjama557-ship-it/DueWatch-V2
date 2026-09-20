-- AP6/AP7 — DW Autopilot Night Shift durable control plane.
-- Repository migration only. Applying this migration does not itself enable or
-- execute Night Shift. Existing execution authority remains in the canonical
-- reminder authority/execution boundary.

create unique index if not exists clients_user_id_id_uidx
  on public.clients (user_id, id);

create unique index if not exists invoices_user_id_id_uidx
  on public.invoices (user_id, id);

create table if not exists public.autopilot_mode_configs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  mode text not null default 'NORMAL'
    check (mode in ('NORMAL', 'NIGHT_SHIFT', 'FULL_AUTOPILOT_AWAY', 'CASH_RECOVERY', 'PROTECT', 'QUARTER_END')),
  enabled boolean not null default false,
  business_timezone text,
  founder_timezone text,
  schedule jsonb,
  cash_floor numeric(14,2) check (cash_floor is null or cash_floor >= 0),
  emergency_rules jsonb not null default '{}'::jsonb
    check (jsonb_typeof(emergency_rules) = 'object'),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.autopilot_authority_policies (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  allowed_actions text[] not null default '{}'::text[],
  allowed_channels text[] not null default '{}'::text[],
  allowed_automatic_tones text[] not null default '{}'::text[],
  max_automatic_invoice_amount numeric(14,2)
    check (max_automatic_invoice_amount is null or max_automatic_invoice_amount >= 0),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.autopilot_protected_clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null,
  enabled boolean not null default true,
  outbound_requires_approval boolean not null default true,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_id),
  foreign key (user_id, client_id)
    references public.clients (user_id, id) on delete cascade
);

create table if not exists public.autopilot_temporary_strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete restrict,
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  overrides jsonb not null default '{}'::jsonb
    check (jsonb_typeof(overrides) = 'object'),
  created_at timestamptz not null default now(),
  check (expires_at > starts_at),
  check (
    (approved_at is null and approved_by is null)
    or
    (approved_at is not null and approved_by = user_id)
  )
);

create index if not exists autopilot_temporary_strategies_user_window_idx
  on public.autopilot_temporary_strategies (user_id, starts_at, expires_at);

create table if not exists public.autopilot_shift_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null
    check (mode in ('NORMAL', 'NIGHT_SHIFT', 'FULL_AUTOPILOT_AWAY', 'CASH_RECOVERY', 'PROTECT', 'QUARTER_END')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'error', 'cancelled')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  config_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (user_id, id),
  check (ended_at is null or ended_at >= started_at)
);

create index if not exists autopilot_shift_runs_user_started_idx
  on public.autopilot_shift_runs (user_id, started_at desc);

create table if not exists public.autopilot_shift_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  shift_run_id uuid not null,
  invoice_id uuid,
  client_id uuid,
  occurred_at timestamptz not null default now(),
  observation text,
  evidence_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_refs) = 'array'),
  decision text,
  authority_proof jsonb,
  disposition text not null
    check (disposition in ('EXECUTE', 'SCHEDULE', 'NEEDS_APPROVAL', 'BLOCKED')),
  result jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result) = 'object'),
  provider_receipt jsonb,
  next_check_at timestamptz,
  foreign key (user_id, shift_run_id)
    references public.autopilot_shift_runs (user_id, id) on delete cascade,
  foreign key (user_id, invoice_id)
    references public.invoices (user_id, id) on delete restrict,
  foreign key (user_id, client_id)
    references public.clients (user_id, id) on delete restrict
);

create index if not exists autopilot_shift_log_run_time_idx
  on public.autopilot_shift_log (user_id, shift_run_id, occurred_at);

create table if not exists public.autopilot_morning_handoffs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  shift_run_id uuid not null,
  generated_at timestamptz not null default now(),
  payload jsonb not null
    check (jsonb_typeof(payload) = 'object'),
  unique (user_id, shift_run_id),
  foreign key (user_id, shift_run_id)
    references public.autopilot_shift_runs (user_id, id) on delete cascade
);

alter table public.autopilot_mode_configs enable row level security;
alter table public.autopilot_authority_policies enable row level security;
alter table public.autopilot_protected_clients enable row level security;
alter table public.autopilot_temporary_strategies enable row level security;
alter table public.autopilot_shift_runs enable row level security;
alter table public.autopilot_shift_log enable row level security;
alter table public.autopilot_morning_handoffs enable row level security;

drop policy if exists "autopilot_mode_configs_own" on public.autopilot_mode_configs;
create policy "autopilot_mode_configs_own" on public.autopilot_mode_configs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "autopilot_authority_policies_own" on public.autopilot_authority_policies;
create policy "autopilot_authority_policies_own" on public.autopilot_authority_policies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "autopilot_protected_clients_own" on public.autopilot_protected_clients;
create policy "autopilot_protected_clients_own" on public.autopilot_protected_clients
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "autopilot_temporary_strategies_own" on public.autopilot_temporary_strategies;
create policy "autopilot_temporary_strategies_own" on public.autopilot_temporary_strategies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "autopilot_shift_runs_own" on public.autopilot_shift_runs;
create policy "autopilot_shift_runs_own" on public.autopilot_shift_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "autopilot_shift_log_own" on public.autopilot_shift_log;
create policy "autopilot_shift_log_own" on public.autopilot_shift_log
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "autopilot_morning_handoffs_own" on public.autopilot_morning_handoffs;
create policy "autopilot_morning_handoffs_own" on public.autopilot_morning_handoffs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
