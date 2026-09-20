-- Reports R6 saved views + targets RLS proof. Disposable local Supabase only.
begin;

insert into auth.users(id, email) values
  ('a6000000-0000-4000-8000-000000000001', 'reports-a@example.test'),
  ('b6000000-0000-4000-8000-000000000002', 'reports-b@example.test');

insert into public.report_saved_views(
  id, user_id, name, cadence, start_date, end_date, currency, active_tab
) values
  ('a6100000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001',
   'A monthly', 'Monthly', '2026-09-01', '2026-10-01', 'USD', 'collections'),
  ('b6100000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-000000000002',
   'B monthly', 'Monthly', '2026-09-01', '2026-10-01', 'USD', 'collections');

insert into public.report_collection_targets(
  id, user_id, period_start, period_end, currency, target_amount
) values
  ('a6200000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001',
   '2026-09-01', '2026-10-01', 'USD', 400000),
  ('b6200000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-000000000002',
   '2026-09-01', '2026-10-01', 'USD', 300000);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a6000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $test$
declare
  v_count integer;
begin
  select count(*) into v_count from public.report_saved_views;
  if v_count <> 1 then
    raise exception 'RLS leaked saved views: visible rows %', v_count;
  end if;

  select count(*) into v_count from public.report_collection_targets;
  if v_count <> 1 then
    raise exception 'RLS leaked collection targets: visible rows %', v_count;
  end if;

  update public.report_saved_views
  set name = 'should-not-change'
  where id = 'b6100000-0000-4000-8000-000000000002';
  if found then raise exception 'Cross-tenant saved-view update succeeded'; end if;

  delete from public.report_collection_targets
  where id = 'b6200000-0000-4000-8000-000000000002';
  if found then raise exception 'Cross-tenant target delete succeeded'; end if;

  begin
    insert into public.report_saved_views(
      user_id, name, cadence, start_date, end_date, currency, active_tab
    ) values (
      'b6000000-0000-4000-8000-000000000002', 'forged', 'Monthly',
      '2026-09-01', '2026-10-01', 'USD', 'collections'
    );
    raise exception 'Cross-tenant saved-view insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.report_collection_targets(
      user_id, period_start, period_end, currency, target_amount
    ) values (
      'b6000000-0000-4000-8000-000000000002',
      '2026-09-01', '2026-10-01', 'USD', 1
    );
    raise exception 'Cross-tenant target insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end
$test$;

insert into public.report_saved_views(
  user_id, name, cadence, start_date, end_date, currency, active_tab
) values (
  'a6000000-0000-4000-8000-000000000001', 'A custom', 'Custom',
  '2026-09-05', '2026-09-21', 'USD', 'aging'
);

insert into public.report_collection_targets(
  user_id, period_start, period_end, currency, target_amount
) values (
  'a6000000-0000-4000-8000-000000000001',
  '2026-10-01', '2026-11-01', 'USD', 450000
);

do $own$
begin
  if not exists (
    select 1 from public.report_saved_views
    where user_id = 'a6000000-0000-4000-8000-000000000001'
      and name = 'A custom'
  ) then raise exception 'Own saved-view insert failed'; end if;

  if not exists (
    select 1 from public.report_collection_targets
    where user_id = 'a6000000-0000-4000-8000-000000000001'
      and target_amount = 450000
  ) then raise exception 'Own target insert failed'; end if;
end
$own$;

rollback;
