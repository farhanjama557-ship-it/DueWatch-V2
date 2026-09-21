-- DueWatch workspace preferences.
-- Presentation and notification preferences only. This table does not grant
-- Autopilot execution authority; approval authority remains in
-- public.autopilot_settings.

begin;

create table if not exists public.workspace_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_name text,
  timezone text,
  date_format text not null default 'MM/DD/YYYY',
  weekly_digest boolean not null default true,
  overdue_summary boolean not null default true,
  product_updates boolean not null default true,
  promise_notifications boolean not null default true,
  escalation_alerts boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workspace_preferences_name_check
    check (workspace_name is null or char_length(trim(workspace_name)) between 1 and 80),
  constraint workspace_preferences_timezone_check
    check (timezone is null or char_length(trim(timezone)) between 1 and 80),
  constraint workspace_preferences_date_format_check
    check (date_format in ('MM/DD/YYYY','DD/MM/YYYY','YYYY-MM-DD'))
);

alter table public.workspace_preferences enable row level security;

drop policy if exists workspace_preferences_select_own on public.workspace_preferences;
create policy workspace_preferences_select_own on public.workspace_preferences
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists workspace_preferences_insert_own on public.workspace_preferences;
create policy workspace_preferences_insert_own on public.workspace_preferences
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists workspace_preferences_update_own on public.workspace_preferences;
create policy workspace_preferences_update_own on public.workspace_preferences
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.workspace_preferences from public, anon, authenticated;
grant select, insert, update on public.workspace_preferences to authenticated;
grant select, insert, update, delete on public.workspace_preferences to service_role;

commit;
