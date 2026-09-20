-- Protect server-authored operational evidence from browser mutation.

-- Autopilot scheduler receipts are server-authored.
revoke insert, update, delete on public.autopilot_runs from authenticated;
grant select on public.autopilot_runs to authenticated;

-- Reminder rows now project from the hardened send-reminder-email boundary.
revoke insert, update, delete on public.reminders from authenticated;
grant select on public.reminders to authenticated;

-- Awaiting-signature rows are created/resolved by server execution boundaries.
-- The only founder-side mutation left is a narrowly-scoped skip RPC below.
revoke insert, update, delete on public.awaiting_signature from authenticated;
grant select on public.awaiting_signature to authenticated;

create or replace function public.skip_awaiting_signature(
  p_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_row public.awaiting_signature%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_id is null then raise exception 'APPROVAL_ID_REQUIRED'; end if;
  if length(coalesce(p_reason, '')) > 500 then
    raise exception 'SKIP_REASON_TOO_LONG';
  end if;

  select * into v_row
  from public.awaiting_signature
  where id = p_id
  for update;

  if not found or v_row.user_id <> v_user_id then
    raise exception 'APPROVAL_NOT_FOUND' using errcode = '42501';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'APPROVAL_ALREADY_RESOLVED';
  end if;

  update public.awaiting_signature
  set status = 'skipped',
      founder_note = nullif(btrim(p_reason), ''),
      resolved_at = now()
  where id = p_id and user_id = v_user_id and status = 'pending';

  if not found then
    raise exception 'APPROVAL_STATE_CHANGED';
  end if;
end;
$$;

revoke all on function public.skip_awaiting_signature(uuid, text)
  from public, anon;
grant execute on function public.skip_awaiting_signature(uuid, text)
  to authenticated, service_role;

-- Events may contain money/action evidence. Browser sessions may append only
-- benign founder/UI facts; provider/action/payment outcomes remain server-only.
revoke update, delete on public.events from authenticated;
grant select, insert on public.events to authenticated;

drop policy if exists events_all_own on public.events;
drop policy if exists events_select_own on public.events;
drop policy if exists events_insert_safe_own on public.events;

create policy events_select_own on public.events
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy events_insert_safe_own on public.events
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and event_type in (
      'invoice_created',
      'reminder_opened',
      'reminder_skipped',
      'invoice_marked_paid'
    )
  );

do $postconditions$
begin
  if has_table_privilege('authenticated', 'public.autopilot_runs', 'INSERT')
     or has_table_privilege('authenticated', 'public.autopilot_runs', 'UPDATE')
     or has_table_privilege('authenticated', 'public.autopilot_runs', 'DELETE') then
    raise exception 'authenticated retained write access to autopilot_runs';
  end if;

  if has_table_privilege('authenticated', 'public.reminders', 'INSERT')
     or has_table_privilege('authenticated', 'public.reminders', 'UPDATE')
     or has_table_privilege('authenticated', 'public.reminders', 'DELETE') then
    raise exception 'authenticated retained direct write access to reminders';
  end if;

  if has_table_privilege('authenticated', 'public.awaiting_signature', 'INSERT')
     or has_table_privilege('authenticated', 'public.awaiting_signature', 'UPDATE')
     or has_table_privilege('authenticated', 'public.awaiting_signature', 'DELETE') then
    raise exception 'authenticated retained direct write access to awaiting_signature';
  end if;

  if has_table_privilege('authenticated', 'public.events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.events', 'DELETE') then
    raise exception 'authenticated retained mutation access to historical events';
  end if;
end
$postconditions$;
