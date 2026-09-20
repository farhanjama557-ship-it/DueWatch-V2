-- DueWatch Reports R7: recurring report schedules and durable delivery runs.
-- Browser users may manage their own schedule definitions. Delivery-run rows
-- are service-owned execution receipts; authenticated users may read their
-- own receipts but cannot create or mutate delivery claims.

create or replace function public.report_timezone_valid(p_timezone text)
returns boolean
language sql
stable
as $reports_timezone$
  select exists (
    select 1
    from pg_catalog.pg_timezone_names
    where name = p_timezone
  );
$reports_timezone$;

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
  deleted_at timestamptz,
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
    check (
      char_length(trim(timezone)) between 1 and 80
      and public.report_timezone_valid(timezone)
    ),
  constraint report_schedules_currency_check
    check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint report_schedules_active_tab_check
    check (active_tab in ('collections', 'aging', 'client-risk', 'promises', 'team-activity')),
  constraint report_schedules_filters_object_check
    check (jsonb_typeof(filters) = 'object'),
  constraint report_schedules_format_check
    check (delivery_format = 'csv'),
  constraint report_schedules_period_mode_check
    check (period_mode = 'previous_complete_period'),
  unique (id, user_id)
);

create table if not exists public.report_delivery_runs (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null,
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
  attempt_count integer not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint report_delivery_runs_schedule_tenant_fk
    foreign key (schedule_id, user_id)
    references public.report_schedules(id, user_id)
    on delete restrict,
  constraint report_delivery_runs_period_check check (period_end > period_start),
  constraint report_delivery_runs_currency_check check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint report_delivery_runs_status_check check (status in ('processing', 'sent', 'failed', 'skipped')),
  constraint report_delivery_runs_attempt_check check (attempt_count between 0 and 20),
  unique (schedule_id, scheduled_for)
);

create index if not exists report_schedules_due_idx
  on public.report_schedules(enabled, next_run_at)
  where enabled = true;

create index if not exists report_schedules_user_idx
  on public.report_schedules(user_id, updated_at desc);

create index if not exists report_delivery_runs_user_idx
  on public.report_delivery_runs(user_id, created_at desc);

create index if not exists report_delivery_runs_lease_idx
  on public.report_delivery_runs(status, lease_expires_at)
  where status = 'processing';

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

drop policy if exists report_delivery_runs_select_own on public.report_delivery_runs;
create policy report_delivery_runs_select_own on public.report_delivery_runs
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.report_schedules, public.report_delivery_runs from public, anon;
grant select, insert, update on public.report_schedules to authenticated;
grant select on public.report_delivery_runs to authenticated;
grant select, insert, update, delete on public.report_schedules, public.report_delivery_runs to service_role;

create or replace function public.claim_due_report_runs(
  p_now timestamptz default clock_timestamp(),
  p_limit integer default 10,
  p_lease_minutes integer default 15,
  p_max_attempts integer default 5
)
returns table (
  run_id uuid,
  lease_token uuid,
  schedule_id uuid,
  user_id uuid,
  scheduled_for timestamptz,
  period_start date,
  period_end date,
  name text,
  recipient_email text,
  cadence text,
  weekday smallint,
  day_of_month smallint,
  local_hour smallint,
  timezone text,
  currency text,
  active_tab text,
  filters jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_schedule public.report_schedules%rowtype;
  v_run public.report_delivery_runs%rowtype;
  v_local_date date;
  v_period_start date;
  v_period_end date;
  v_lease_token uuid;
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit must be between 1 and 100';
  end if;
  if p_lease_minutes < 1 or p_lease_minutes > 60 then
    raise exception 'p_lease_minutes must be between 1 and 60';
  end if;
  if p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'p_max_attempts must be between 1 and 20';
  end if;

  for v_schedule in
    select s.*
    from public.report_schedules s
    where s.enabled = true
      and s.deleted_at is null
      and s.next_run_at <= p_now
    order by s.next_run_at, s.id
    for update skip locked
    limit p_limit
  loop
    v_local_date := (v_schedule.next_run_at at time zone v_schedule.timezone)::date;
    if v_schedule.cadence = 'weekly' then
      v_period_start := v_local_date - 7;
      v_period_end := v_local_date;
    else
      v_period_start := date_trunc('month', v_local_date - interval '1 month')::date;
      v_period_end := date_trunc('month', v_local_date)::date;
    end if;

    v_lease_token := gen_random_uuid();

    insert into public.report_delivery_runs(
      schedule_id,
      user_id,
      scheduled_for,
      period_start,
      period_end,
      currency,
      status,
      attempt_count,
      lease_token,
      lease_expires_at,
      started_at,
      completed_at,
      error_code,
      error_detail
    ) values (
      v_schedule.id,
      v_schedule.user_id,
      v_schedule.next_run_at,
      v_period_start,
      v_period_end,
      v_schedule.currency,
      'processing',
      1,
      v_lease_token,
      p_now + make_interval(mins => p_lease_minutes),
      p_now,
      null,
      null,
      null
    )
    on conflict (schedule_id, scheduled_for) do update
      set status = 'processing',
          attempt_count = public.report_delivery_runs.attempt_count + 1,
          lease_token = excluded.lease_token,
          lease_expires_at = excluded.lease_expires_at,
          started_at = excluded.started_at,
          completed_at = null,
          error_code = null,
          error_detail = null
      where
        (
          public.report_delivery_runs.status = 'failed'
          or (
            public.report_delivery_runs.status = 'processing'
            and public.report_delivery_runs.lease_expires_at <= p_now
          )
        )
        and public.report_delivery_runs.attempt_count < p_max_attempts
    returning * into v_run;

    if not found then
      continue;
    end if;

    run_id := v_run.id;
    lease_token := v_run.lease_token;
    schedule_id := v_schedule.id;
    user_id := v_schedule.user_id;
    scheduled_for := v_schedule.next_run_at;
    period_start := v_run.period_start;
    period_end := v_run.period_end;
    name := v_schedule.name;
    recipient_email := v_schedule.recipient_email;
    cadence := v_schedule.cadence;
    weekday := v_schedule.weekday;
    day_of_month := v_schedule.day_of_month;
    local_hour := v_schedule.local_hour;
    timezone := v_schedule.timezone;
    currency := v_schedule.currency;
    active_tab := v_schedule.active_tab;
    filters := v_schedule.filters;
    attempt_count := v_run.attempt_count;
    return next;
  end loop;
end;
$$;

create or replace function public.complete_report_delivery_run(
  p_run_id uuid,
  p_lease_token uuid,
  p_status text,
  p_provider text default null,
  p_provider_message_id text default null,
  p_artifact_sha256 text default null,
  p_error_code text default null,
  p_error_detail text default null,
  p_next_run_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.report_delivery_runs%rowtype;
begin
  if p_run_id is null or p_lease_token is null then
    raise exception 'Run id and lease token are required';
  end if;
  if p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'Unsupported terminal report delivery status';
  end if;

  select * into v_run
  from public.report_delivery_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'Report delivery run not found';
  end if;
  if v_run.status <> 'processing' then
    raise exception 'Report delivery run is already terminal';
  end if;
  if v_run.lease_token is distinct from p_lease_token then
    raise exception 'Report delivery lease was lost';
  end if;

  if p_status = 'sent' then
    if p_next_run_at is null or p_next_run_at <= v_run.scheduled_for then
      raise exception 'A sent report requires a valid next run';
    end if;

    update public.report_schedules
    set next_run_at = p_next_run_at,
        last_run_at = v_run.scheduled_for,
        updated_at = clock_timestamp()
    where id = v_run.schedule_id
      and user_id = v_run.user_id;
  end if;

  update public.report_delivery_runs
  set status = p_status,
      provider = p_provider,
      provider_message_id = p_provider_message_id,
      artifact_sha256 = p_artifact_sha256,
      error_code = p_error_code,
      error_detail = case
        when p_error_detail is null then null
        else left(p_error_detail, 2000)
      end,
      lease_token = null,
      lease_expires_at = null,
      completed_at = clock_timestamp()
  where id = p_run_id;

  return jsonb_build_object(
    'run_id', p_run_id,
    'schedule_id', v_run.schedule_id,
    'status', p_status,
    'scheduled_for', v_run.scheduled_for,
    'next_run_at', p_next_run_at
  );
end;
$$;

revoke all on function public.claim_due_report_runs(timestamptz, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_report_runs(timestamptz, integer, integer, integer)
  to service_role;

revoke all on function public.complete_report_delivery_run(
  uuid, uuid, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_report_delivery_run(
  uuid, uuid, text, text, text, text, text, text, timestamptz
) to service_role;
