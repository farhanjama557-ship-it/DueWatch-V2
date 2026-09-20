-- Security advisor cleanup after hosted verification.
alter function public.report_timezone_valid(text)
  set search_path = pg_catalog, public, pg_temp;

create index if not exists report_delivery_runs_schedule_user_idx
  on public.report_delivery_runs(schedule_id, user_id);
