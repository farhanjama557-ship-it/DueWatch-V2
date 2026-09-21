-- DueWatch Promise-to-Pay foundation.
--
-- Promise facts are founder/customer commitments, not payment facts. This table
-- stores proposed/confirmed/cancelled/superseded promise identity only.
-- Fulfilled/broken are derived by the application from the immutable payment
-- ledger + promised date; they are deliberately not writable statuses here.

begin;

create table if not exists public.promises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'cancelled', 'superseded')),
  promised_amount numeric(12,2) not null
    check (promised_amount > 0 and promised_amount <= 9999999999.99),
  promised_date date not null,
  currency text not null
    check (currency = upper(currency) and currency ~ '^[A-Z]{3}$'),
  source text not null default 'founder_manual'
    check (char_length(trim(source)) between 1 and 80),
  note text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  superseded_at timestamptz,
  superseded_by uuid references public.promises(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint promises_status_timestamps_check check (
    (status = 'proposed' and confirmed_at is null and cancelled_at is null and superseded_at is null)
    or
    (status = 'confirmed' and confirmed_at is not null and cancelled_at is null and superseded_at is null)
    or
    (status = 'cancelled' and cancelled_at is not null and superseded_at is null)
    or
    (status = 'superseded' and superseded_at is not null and superseded_by is not null)
  )
);

create index if not exists promises_user_date_idx
  on public.promises(user_id, promised_date, created_at);

create index if not exists promises_invoice_created_idx
  on public.promises(invoice_id, created_at desc);

create unique index if not exists promises_one_active_per_invoice_uidx
  on public.promises(invoice_id)
  where status in ('proposed', 'confirmed');

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

    if old.status in ('cancelled', 'superseded') then
      raise exception 'Resolved promises are immutable';
    end if;

    if old.status = 'confirmed'
       and (
         new.promised_amount is distinct from old.promised_amount
         or new.promised_date is distinct from old.promised_date
         or new.source is distinct from old.source
       ) then
      raise exception 'Confirmed promise terms are immutable; supersede the promise instead';
    end if;

    if old.status = 'proposed' and new.status = 'confirmed' then
      new.confirmed_at := clock_timestamp();
      new.cancelled_at := null;
      new.superseded_at := null;
      new.superseded_by := null;
    elsif new.status = 'cancelled' and old.status in ('proposed', 'confirmed') then
      new.cancelled_at := clock_timestamp();
      new.superseded_at := null;
      new.superseded_by := null;
    elsif new.status = 'superseded' and old.status in ('proposed', 'confirmed') then
      if new.superseded_by is null or new.superseded_by = old.id then
        raise exception 'Superseded promise requires a different replacement promise';
      end if;
      new.superseded_at := clock_timestamp();
      new.cancelled_at := null;
    elsif new.status is distinct from old.status then
      raise exception 'Unsupported promise state transition % -> %', old.status, new.status;
    end if;
  else
    new.status := 'proposed';
    new.confirmed_at := null;
    new.cancelled_at := null;
    new.superseded_at := null;
    new.superseded_by := null;
  end if;

  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists promises_validate on public.promises;
create trigger promises_validate
  before insert or update on public.promises
  for each row execute function public.validate_promise_row();

alter table public.promises enable row level security;

drop policy if exists promises_select_own on public.promises;
create policy promises_select_own on public.promises
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists promises_insert_own on public.promises;
create policy promises_insert_own on public.promises
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists promises_update_own on public.promises;
create policy promises_update_own on public.promises
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.promises from public, anon, authenticated;
grant select on public.promises to authenticated;
grant insert (user_id, invoice_id, promised_amount, promised_date, currency, source, note)
  on public.promises to authenticated;
grant update (status, promised_amount, promised_date, source, note, superseded_by)
  on public.promises to authenticated;
grant select, insert, update on public.promises to service_role;

revoke all on function public.validate_promise_row() from public, anon;
grant execute on function public.validate_promise_row() to authenticated, service_role;

commit;
