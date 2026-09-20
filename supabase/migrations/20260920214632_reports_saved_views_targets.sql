-- DueWatch Reports R6: saved report views and collection targets.
-- Read/write is founder-owned and tenant-scoped by RLS. These tables store
-- presentation preferences and explicit founder targets only; they do not
-- create canonical invoice/payment truth or execution authority.

create table if not exists public.report_saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  cadence text not null default 'Monthly',
  start_date date not null,
  end_date date not null,
  currency text,
  active_tab text not null default 'collections',
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_saved_views_name_check
    check (char_length(trim(name)) between 1 and 80),
  constraint report_saved_views_cadence_check
    check (cadence in ('Monthly', 'Quarterly', 'Yearly', 'Custom')),
  constraint report_saved_views_period_check
    check (end_date > start_date),
  constraint report_saved_views_currency_check
    check (currency is null or currency ~ '^[A-Z]{3}$'),
  constraint report_saved_views_active_tab_check
    check (active_tab in ('collections', 'aging', 'client-risk', 'promises', 'team-activity')),
  constraint report_saved_views_filters_object_check
    check (jsonb_typeof(filters) = 'object'),
  unique (user_id, name)
);

create table if not exists public.report_collection_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  currency text not null,
  target_amount numeric(12,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint report_collection_targets_period_check
    check (period_end > period_start),
  constraint report_collection_targets_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint report_collection_targets_amount_check
    check (target_amount > 0 and target_amount <= 9999999999.99),
  unique (user_id, period_start, period_end, currency)
);

create index if not exists report_saved_views_user_updated_idx
  on public.report_saved_views(user_id, updated_at desc);

create index if not exists report_collection_targets_user_period_idx
  on public.report_collection_targets(user_id, period_start desc, period_end desc);

alter table public.report_saved_views enable row level security;
alter table public.report_collection_targets enable row level security;

drop policy if exists report_saved_views_select_own on public.report_saved_views;
create policy report_saved_views_select_own on public.report_saved_views
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists report_saved_views_insert_own on public.report_saved_views;
create policy report_saved_views_insert_own on public.report_saved_views
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists report_saved_views_update_own on public.report_saved_views;
create policy report_saved_views_update_own on public.report_saved_views
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists report_saved_views_delete_own on public.report_saved_views;
create policy report_saved_views_delete_own on public.report_saved_views
  for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists report_collection_targets_select_own on public.report_collection_targets;
create policy report_collection_targets_select_own on public.report_collection_targets
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists report_collection_targets_insert_own on public.report_collection_targets;
create policy report_collection_targets_insert_own on public.report_collection_targets
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists report_collection_targets_update_own on public.report_collection_targets;
create policy report_collection_targets_update_own on public.report_collection_targets
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists report_collection_targets_delete_own on public.report_collection_targets;
create policy report_collection_targets_delete_own on public.report_collection_targets
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.report_saved_views, public.report_collection_targets from public, anon;
grant select, insert, update, delete on public.report_saved_views to authenticated;
grant select, insert, update, delete on public.report_collection_targets to authenticated;
grant select, insert, update, delete on public.report_saved_views, public.report_collection_targets to service_role;
