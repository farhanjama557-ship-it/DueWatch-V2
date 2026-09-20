-- Reports R7 scheduling, RLS, tenant binding, lease, and completion proof.
begin;

insert into auth.users(id, email) values
  ('a7000000-0000-4000-8000-000000000001', 'r7-a@example.test'),
  ('b7000000-0000-4000-8000-000000000002', 'r7-b@example.test');

insert into public.report_schedules(
  id, user_id, name, recipient_email, cadence, weekday, day_of_month,
  local_hour, timezone, currency, active_tab, next_run_at, enabled
) values
  (
    'a7100000-0000-4000-8000-000000000001',
    'a7000000-0000-4000-8000-000000000001',
    'A weekly', 'a@example.test', 'weekly', 1, null,
    8, 'America/New_York', 'USD', 'collections',
    '2026-09-21 12:00:00+00', true
  ),
  (
    'b7100000-0000-4000-8000-000000000002',
    'b7000000-0000-4000-8000-000000000002',
    'B weekly', 'b@example.test', 'weekly', 1, null,
    8, 'America/New_York', 'USD', 'collections',
    '2026-09-28 12:00:00+00', true
  );

insert into public.report_delivery_runs(
  id, schedule_id, user_id, scheduled_for, period_start, period_end,
  currency, status, attempt_count, completed_at
) values (
  'b7200000-0000-4000-8000-000000000002',
  'b7100000-0000-4000-8000-000000000002',
  'b7000000-0000-4000-8000-000000000002',
  '2026-09-14 12:00:00+00',
  '2026-09-07', '2026-09-14', 'USD', 'sent', 1, now()
);

-- Composite schedule/user FK prevents a service-level bug from binding a
-- delivery receipt to another tenant even if RLS is bypassed.
do $tenant_fk$
begin
  begin
    insert into public.report_delivery_runs(
      schedule_id, user_id, scheduled_for, period_start, period_end,
      currency, status, attempt_count
    ) values (
      'a7100000-0000-4000-8000-000000000001',
      'b7000000-0000-4000-8000-000000000002',
      '2026-09-21 12:00:00+00',
      '2026-09-14', '2026-09-21', 'USD', 'processing', 1
    );
    raise exception 'Cross-tenant report delivery FK unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;
end
$tenant_fk$;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a7000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $rls$
declare
  v_count integer;
begin
  select count(*) into v_count from public.report_schedules;
  if v_count <> 1 then
    raise exception 'Schedule RLS leaked rows: %', v_count;
  end if;

  select count(*) into v_count from public.report_delivery_runs;
  if v_count <> 0 then
    raise exception 'Delivery-run RLS leaked rows: %', v_count;
  end if;

  update public.report_schedules
  set name = 'forged'
  where id = 'b7100000-0000-4000-8000-000000000002';
  if found then raise exception 'Cross-tenant schedule update succeeded'; end if;

  begin
    insert into public.report_delivery_runs(
      schedule_id, user_id, scheduled_for, period_start, period_end,
      status
    ) values (
      'a7100000-0000-4000-8000-000000000001',
      'a7000000-0000-4000-8000-000000000001',
      '2026-09-21 12:00:00+00',
      '2026-09-14', '2026-09-21', 'processing'
    );
    raise exception 'Authenticated browser inserted a delivery claim';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform public.claim_due_report_runs('2026-09-21 12:01:00+00', 10, 15, 5);
    raise exception 'Authenticated browser executed report claim RPC';
  exception
    when insufficient_privilege then null;
  end;
end
$rls$;

reset role;

create temporary table r7_first_claim as
select * from public.claim_due_report_runs(
  '2026-09-21 12:01:00+00'::timestamptz, 10, 15, 5
);

do $claim$
declare
  v_count integer;
  v_attempt integer;
begin
  select count(*), max(attempt_count) into v_count, v_attempt from r7_first_claim;
  if v_count <> 1 or v_attempt <> 1 then
    raise exception 'Expected one first claim at attempt 1; count %, attempt %', v_count, v_attempt;
  end if;

  if not exists (
    select 1 from r7_first_claim
    where period_start = '2026-09-14'
      and period_end = '2026-09-21'
      and user_id = 'a7000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Weekly report period or tenant claim was incorrect';
  end if;

  select count(*) into v_count
  from public.claim_due_report_runs(
    '2026-09-21 12:02:00+00'::timestamptz, 10, 15, 5
  );
  if v_count <> 0 then
    raise exception 'Active lease allowed duplicate concurrent claim';
  end if;
end
$claim$;

select public.complete_report_delivery_run(
  run_id,
  lease_token,
  'sent',
  'resend',
  'msg-r7-1',
  repeat('a', 64),
  null,
  null,
  '2026-09-28 12:00:00+00'
)
from r7_first_claim;

do $complete$
declare
  v_status text;
  v_next timestamptz;
  v_last timestamptz;
  v_token uuid;
begin
  select status, lease_token
    into v_status, v_token
  from public.report_delivery_runs
  where schedule_id = 'a7100000-0000-4000-8000-000000000001'
    and scheduled_for = '2026-09-21 12:00:00+00';

  if v_status <> 'sent' or v_token is not null then
    raise exception 'Sent completion did not close the delivery lease';
  end if;

  select next_run_at, last_run_at into v_next, v_last
  from public.report_schedules
  where id = 'a7100000-0000-4000-8000-000000000001';

  if v_next <> '2026-09-28 12:00:00+00'
     or v_last <> '2026-09-21 12:00:00+00' then
    raise exception 'Successful completion did not advance schedule atomically';
  end if;
end
$complete$;

-- Failure remains retryable with the same scheduled occurrence and a new
-- lease, while attempt_count increments. Provider idempotency uses that same
-- occurrence so an ambiguous provider result does not invent a new identity.
insert into public.report_schedules(
  id, user_id, name, recipient_email, cadence, weekday, day_of_month,
  local_hour, timezone, currency, active_tab, next_run_at, enabled
) values (
  'a7100000-0000-4000-8000-000000000003',
  'a7000000-0000-4000-8000-000000000001',
  'A retry', 'a@example.test', 'weekly', 1, null,
  8, 'America/New_York', 'USD', 'collections',
  '2026-09-21 12:00:00+00', true
);

create temporary table r7_retry_claim as
select * from public.claim_due_report_runs(
  '2026-09-21 12:03:00+00'::timestamptz, 10, 15, 5
)
where schedule_id = 'a7100000-0000-4000-8000-000000000003';

select public.complete_report_delivery_run(
  run_id,
  lease_token,
  'failed',
  'resend',
  null,
  null,
  'PROVIDER_DOWN',
  'test failure',
  null
)
from r7_retry_claim;

create temporary table r7_retry_claim_2 as
select * from public.claim_due_report_runs(
  '2026-09-21 12:04:00+00'::timestamptz, 10, 15, 5
)
where schedule_id = 'a7100000-0000-4000-8000-000000000003';

do $retry$
declare
  v_attempt integer;
  v_count integer;
begin
  select count(*), max(attempt_count) into v_count, v_attempt from r7_retry_claim_2;
  if v_count <> 1 or v_attempt <> 2 then
    raise exception 'Failed run was not retried deterministically; count %, attempt %', v_count, v_attempt;
  end if;
end
$retry$;

rollback;
