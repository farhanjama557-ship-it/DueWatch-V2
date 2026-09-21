-- Promise-to-Pay V1 lifecycle hardening.
--
-- The original foundation included a superseded_by self-reference while also
-- enforcing one active proposed/confirmed promise per invoice. That made a
-- safe supersession transition impossible to construct. V1 deliberately
-- keeps only executable persisted states; "fulfilled" and
-- "past_due_unresolved" remain derived from payment/date evidence.

begin;

do $$
begin
  if exists (select 1 from public.promises where status = 'superseded') then
    raise exception 'Cannot remove superseded promise lifecycle while superseded rows exist';
  end if;
end
$$;

drop trigger if exists promises_validate on public.promises;
drop function if exists public.validate_promise_row();

revoke update (
  status,
  promised_amount,
  promised_date,
  source,
  note,
  superseded_by
) on public.promises from authenticated;

alter table public.promises
  drop constraint if exists promises_status_timestamps_check,
  drop constraint if exists promises_status_check,
  drop constraint if exists promises_superseded_by_fkey;

alter table public.promises
  drop column if exists superseded_by,
  drop column if exists superseded_at;

alter table public.promises
  add constraint promises_status_check
    check (status in ('proposed', 'confirmed', 'cancelled')),
  add constraint promises_status_timestamps_check
    check (
      (status = 'proposed' and confirmed_at is null and cancelled_at is null)
      or
      (status = 'confirmed' and confirmed_at is not null and cancelled_at is null)
      or
      (status = 'cancelled' and cancelled_at is not null)
    );

create or replace function public.validate_promise_row()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_balance numeric(12,2);
begin
  select * into v_invoice
  from public.invoices
  where id = new.invoice_id
    and user_id = new.user_id;

  if not found then
    raise exception 'Promise invoice must belong to the authenticated tenant';
  end if;

  if v_invoice.currency is null then
    raise exception 'Invoice currency must be set before recording a promise';
  end if;

  if new.currency is distinct from v_invoice.currency then
    raise exception 'Promise currency must match invoice currency';
  end if;

  v_balance := greatest(v_invoice.amount - v_invoice.amount_paid, 0)::numeric(12,2);
  if new.promised_amount > v_balance then
    raise exception 'Promise amount cannot exceed the current invoice balance';
  end if;

  if tg_op = 'UPDATE' then
    if (new.user_id, new.invoice_id, new.currency, new.created_at)
       is distinct from
       (old.user_id, old.invoice_id, old.currency, old.created_at) then
      raise exception 'Promise tenant, invoice, currency, and creation identity are immutable';
    end if;

    if old.status = 'cancelled' then
      raise exception 'Resolved promises are immutable';
    end if;

    if old.status = 'confirmed'
       and (
         new.promised_amount is distinct from old.promised_amount
         or new.promised_date is distinct from old.promised_date
         or new.source is distinct from old.source
       ) then
      raise exception 'Confirmed promise terms are immutable; cancel and record a new promise instead';
    end if;

    if old.status = 'proposed' and new.status = 'confirmed' then
      new.confirmed_at := clock_timestamp();
      new.cancelled_at := null;
    elsif new.status = 'cancelled' and old.status in ('proposed', 'confirmed') then
      new.cancelled_at := clock_timestamp();
    elsif new.status is distinct from old.status then
      raise exception 'Unsupported promise state transition % -> %', old.status, new.status;
    end if;
  else
    new.status := 'proposed';
    new.confirmed_at := null;
    new.cancelled_at := null;
  end if;

  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger promises_validate
  before insert or update on public.promises
  for each row execute function public.validate_promise_row();

revoke all on function public.validate_promise_row() from public, anon;
grant execute on function public.validate_promise_row() to authenticated, service_role;

grant update (
  status,
  promised_amount,
  promised_date,
  source,
  note
) on public.promises to authenticated;

commit;
