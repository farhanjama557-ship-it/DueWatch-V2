-- DueWatch Reports R7: recurring report schedules and durable delivery runs.
-- Browser users may manage their own schedule definitions. Delivery-run rows
-- are service-owned execution receipts; authenticated users may read their
-- own receipts but cannot create or mutate delivery claims.

create table if not exists public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  recipient_email text not null,
  cadence text not null,
  weekday smallint,
  day_of_month smallint,
  local_hour smallint not null default 8,
  timezone text not null default 'UTC',
  currency text,
  active_tab text not null default 'collections',
  filters jsonb not null default '{}'::jsonb,
  delivery_format text not null default 'csv',
  period_mode text not null default 'previous_complete_period',
  next_run_at timestamptz not null,
  enabled boolean not null default true,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_schedules_name_check
    check (char_length(trim(name)) between 1 and 80),
  constraint report_schedules_email_check
    check (position('@' in recipient_email) > 1 and char_length(recipient_email) <= 320),
  constraint report_schedules_cadence_check
    check (cadence in ('weekly', 'monthly')),
  constraint report_schedules_weekday_check
    check (
      (cadence = 'weekly' and weekday between 0 and 6 and day_of_month is null)
      or
      (cadence = 'monthly' and day_of_month between 1 and 28 and weekday is null)
    ),
  constraint report_schedules_hour_check
    check (local_hour between 0 and 23),
  constraint report_schedules_timezone_check
    check (char_length(trim(timezone)) between 1 and 80),
  constraint report_schedules_currency_check
    check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint report_schedules_active_tab_check
    check (active_tab in ('collections', 'aging', 'client-risk', 'promises', 'team-activity')),
  constraint report_schedules_filters_object_check
    check (jsonb_typeof(filters) = 'object'),
  constraint report_schedules_format_check
    check (delivery_format = 'csv'),
  constraint report_schedules_period_mode_check
    check (period_mode = 'previous_complete_period')
);

create table if not exists public.report_delivery_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.report_schedules(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scheduled_for timestamptz not null,
  period_start date not null,
  period_end date not null,
  currency text,
  status text not null default 'processing',
  provider text,
  provider_message_id text,
  error_code text,
  error_detail text,
  artifact_sha256 text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint report_delivery_runs_period_check check (period_end > period_start),
  constraint report_delivery_runs_currency_check check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint report_delivery_runs_status_check check (status in ('processing', 'sent', 'failed', 'skipped')),
  unique (schedule_id, scheduled_for)
);

create index if not exists report_schedules_due_idx
  on public.report_schedules(enabled, next_run_at)
  where enabled = true;

create index if not exists report_schedules_user_idx
  on public.report_schedules(user_id, updated_at desc);

create index if not exists report_delivery_runs_user_idx
  on public.report_delivery_runs(user_id, created_at desc);

alter table public.report_schedules enable row level security;
alter table public.report_delivery_runs enable row level security;

drop policy if exists report_schedules_select_own on public.report_schedules;
create policy report_schedules_select_own on public.report_schedules
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists report_schedules_insert_own on public.report_schedules;
create policy report_schedules_insert_own on public.report_schedules
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists report_schedules_update_own on public.report_schedules;
create policy report_schedules_update_own on public.report_schedules
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists report_schedules_delete_own on public.report_schedules;
create policy report_schedules_delete_own on public.report_schedules
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists report_delivery_runs_select_own on public.report_delivery_runs;
create policy report_delivery_runs_select_own on public.report_delivery_runs
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.report_schedules, public.report_delivery_runs from public, anon;
grant select, insert, update, delete on public.report_schedules to authenticated;
grant select on public.report_delivery_runs to authenticated;
grant select, insert, update, delete on public.report_schedules, public.report_delivery_runs to service_role;
