-- Phase 2, Slice 1: immutable payment identity, explicit invoice allocations,
-- deterministic reversals, and lossless preservation of legacy aggregates.
--
-- This migration deliberately does not create Promise-to-Pay state. In
-- particular, every legacy row remains origin=legacy_carry_forward and is
-- therefore structurally distinguishable from founder-entered payment proof.

begin;

create schema if not exists duewatch_ops;

-- A durable, private snapshot proves that the backfill preserved the exact
-- aggregates it found. It is also the source for the migration report below.
create table if not exists duewatch_ops.payment_migration_invoice_snapshot (
  invoice_id uuid primary key,
  user_id uuid not null,
  original_amount numeric(12, 2) not null,
  original_amount_paid numeric(12, 2) not null,
  original_paid boolean not null,
  captured_at timestamptz not null default clock_timestamp()
);
revoke all on duewatch_ops.payment_migration_invoice_snapshot from public, anon, authenticated;

create table if not exists duewatch_ops.payment_migration_audit (
  id smallint primary key check (id = 1),
  generated_at timestamptz not null,
  invoices_with_preexisting_amount_paid bigint not null,
  reconstructed_invoices bigint not null,
  reconstructed_payment_rows bigint not null,
  carry_forward_invoices bigint not null,
  carry_forward_payment_rows bigint not null,
  amount_paid_mismatches bigint not null,
  inconsistent_paid_flags bigint not null,
  unknown_payment_dates bigint not null,
  unknown_currencies bigint not null
);
revoke all on duewatch_ops.payment_migration_audit from public, anon, authenticated;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recorded_by uuid references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp(),
  payment_date date,
  total_amount numeric(12, 2) not null check (total_amount > 0),
  currency text,
  method text,
  note text,
  origin text not null check (origin in ('founder_manual', 'legacy_carry_forward')),
  source_event_id uuid references public.events(id) on delete restrict,
  legacy_invoice_id uuid references public.invoices(id) on delete restrict,
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id) on delete restrict,
  reversal_reason text,
  created_at timestamptz not null default clock_timestamp(),
  constraint payments_currency_format check (
    currency is null or (currency = upper(currency) and currency ~ '^[A-Z]{3}$')
  ),
  constraint payments_origin_facts_check check (
    (
      origin = 'founder_manual'
      and payment_date is not null
      and currency is not null
      and recorded_by is not null
      and recorded_by = user_id
      and source_event_id is null
      and legacy_invoice_id is null
    )
    or
    (
      origin = 'legacy_carry_forward'
      and recorded_by is null
      and ((source_event_id is not null)::integer + (legacy_invoice_id is not null)::integer = 1)
    )
  ),
  constraint payments_reversal_facts_check check (
    (reversed_at is null and reversed_by is null and reversal_reason is null)
    or
    (reversed_at is not null and reversed_by = user_id and nullif(trim(reversal_reason), '') is not null)
  )
);

comment on column public.payments.recorded_at is
  'System fact: when Duewatch stored the payment.';
comment on column public.payments.payment_date is
  'Founder/accounting fact: real-world payment date. Null only for legacy evidence where the date is unsupported.';
comment on column public.payments.origin is
  'legacy_carry_forward is preservation-only and must never qualify as Promise-to-Pay fulfillment evidence.';

create index if not exists payments_user_payment_date_idx
  on public.payments(user_id, payment_date desc);
create unique index if not exists payments_source_event_uidx
  on public.payments(source_event_id) where source_event_id is not null;
create unique index if not exists payments_legacy_invoice_uidx
  on public.payments(legacy_invoice_id) where legacy_invoice_id is not null;

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  amount numeric(12, 2) not null check (amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique(payment_id, invoice_id)
);

create index if not exists payment_allocations_invoice_id_idx
  on public.payment_allocations(invoice_id);

create or replace function duewatch_ops.validate_payment_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
begin
  if new.source_event_id is not null and not exists (
    select 1 from public.events e where e.id = new.source_event_id and e.user_id = new.user_id
  ) then raise exception 'Payment source event must belong to the same tenant'; end if;
  if new.legacy_invoice_id is not null and not exists (
    select 1 from public.invoices i where i.id = new.legacy_invoice_id and i.user_id = new.user_id
  ) then raise exception 'Legacy payment invoice must belong to the same tenant'; end if;
  return new;
end;
$$;

drop trigger if exists payments_validate_provenance on public.payments;
create trigger payments_validate_provenance
  before insert or update of user_id, source_event_id, legacy_invoice_id on public.payments
  for each row execute function duewatch_ops.validate_payment_provenance();
revoke all on function duewatch_ops.validate_payment_provenance() from public, anon, authenticated;

-- Every allocation derives ownership from its payment. This trigger is the
-- tenant/currency boundary even for a role that bypasses RLS.
create or replace function duewatch_ops.validate_payment_allocation()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_other_allocated numeric(12, 2);
begin
  if tg_op = 'UPDATE'
     and (new.payment_id, new.invoice_id) is distinct from (old.payment_id, old.invoice_id) then
    raise exception 'Payment allocation identity is immutable';
  end if;

  select * into v_payment
  from public.payments
  where id = new.payment_id
  for update;
  if not found then
    raise exception 'Payment does not exist';
  end if;
  if v_payment.reversed_at is not null then
    raise exception 'Cannot allocate a reversed payment';
  end if;

  select * into v_invoice
  from public.invoices
  where id = new.invoice_id
  for update;
  if not found then
    raise exception 'Invoice does not exist';
  end if;
  if v_invoice.user_id <> v_payment.user_id then
    raise exception 'Payment and invoice must belong to the same tenant';
  end if;
  if v_invoice.currency is distinct from v_payment.currency then
    raise exception 'Payment and invoice currencies must match exactly';
  end if;

  select coalesce(sum(a.amount), 0)::numeric(12, 2)
  into v_other_allocated
  from public.payment_allocations a
  where a.payment_id = new.payment_id
    and (tg_op <> 'UPDATE' or a.id <> old.id);

  if v_other_allocated + new.amount > v_payment.total_amount then
    raise exception 'Allocation total exceeds payment total';
  end if;
  -- New founder-entered payments may never create an overpayment. Historical
  -- origin='legacy_carry_forward' rows are intentionally exempt so migration
  -- can preserve pre-ledger DueWatch aggregates exactly, including positive
  -- overpayments that the old UI itself allowed.
  if v_payment.origin = 'founder_manual'
     and v_invoice.amount_paid + new.amount > v_invoice.amount then
    raise exception 'Allocation would overpay invoice';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_allocations_validate on public.payment_allocations;
create trigger payment_allocations_validate
  before insert or update on public.payment_allocations
  for each row execute function duewatch_ops.validate_payment_allocation();
revoke all on function duewatch_ops.validate_payment_allocation() from public, anon, authenticated;

-- The application never edits or deletes allocations. This is defense in
-- depth for owner-side mistakes and keeps ledger facts append-only.
create or replace function duewatch_ops.reject_payment_allocation_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
begin
  raise exception 'Payment allocations are immutable';
end;
$$;

drop trigger if exists payment_allocations_immutable on public.payment_allocations;
create trigger payment_allocations_immutable
  before update or delete on public.payment_allocations
  for each row execute function duewatch_ops.reject_payment_allocation_mutation();
revoke all on function duewatch_ops.reject_payment_allocation_mutation() from public, anon, authenticated;

-- A deferred check permits payment + allocations to be inserted in one
-- transaction while proving at commit that no unallocated remainder exists.
create or replace function duewatch_ops.assert_payment_fully_allocated()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_payment_id uuid;
  v_total numeric(12, 2);
  v_allocated numeric(12, 2);
begin
  if tg_table_name = 'payments' then
    v_payment_id := coalesce(new.id, old.id);
  else
    v_payment_id := coalesce(new.payment_id, old.payment_id);
  end if;
  select total_amount into v_total from public.payments where id = v_payment_id;
  if not found then
    return null;
  end if;
  select coalesce(sum(amount), 0)::numeric(12, 2)
  into v_allocated
  from public.payment_allocations
  where payment_id = v_payment_id;
  if v_allocated <> v_total then
    raise exception 'Payment must be fully and explicitly allocated (payment %, total %, allocated %)',
      v_payment_id, v_total, v_allocated;
  end if;
  return null;
end;
$$;

drop trigger if exists payments_fully_allocated on public.payments;
create constraint trigger payments_fully_allocated
  after insert or update of total_amount on public.payments
  deferrable initially deferred
  for each row execute function duewatch_ops.assert_payment_fully_allocated();

drop trigger if exists payment_allocations_fully_allocated on public.payment_allocations;
create constraint trigger payment_allocations_fully_allocated
  after insert or update or delete on public.payment_allocations
  deferrable initially deferred
  for each row execute function duewatch_ops.assert_payment_fully_allocated();
revoke all on function duewatch_ops.assert_payment_fully_allocated() from public, anon, authenticated;

-- Existing invoices remain readable through amount_paid/paid, but browser and
-- service-role callers cannot mutate those aggregates directly after this
-- migration. SECURITY DEFINER payment/import functions still execute as their
-- owner and are independently validated here.
create or replace function duewatch_ops.guard_invoice_payment_aggregates()
returns trigger
language plpgsql
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_has_allocations boolean;
begin
  if new.amount_paid < 0 or new.amount_paid > new.amount then
    raise exception 'Invoice amount_paid must remain between zero and amount';
  end if;

  if tg_op = 'INSERT' then
    if current_user in ('authenticated', 'anon', 'service_role')
       and (new.amount_paid <> 0 or new.paid) then
      raise exception 'Invoice payment aggregates may only be initialized by a hardened database function';
    end if;
    if (new.amount_paid > 0 or new.paid)
       and new.paid is distinct from (new.amount > 0 and new.amount_paid = new.amount) then
      raise exception 'Invoice paid flag is inconsistent with amount_paid';
    end if;
    return new;
  end if;

  if current_user in ('authenticated', 'anon', 'service_role')
     and (new.amount_paid, new.paid) is distinct from (old.amount_paid, old.paid) then
    raise exception 'Invoice payment aggregates may only be changed by payment RPCs';
  end if;

  if (new.amount, new.currency) is distinct from (old.amount, old.currency) then
    select exists(
      select 1 from public.payment_allocations where invoice_id = old.id
    ) into v_has_allocations;
    if v_has_allocations then
      raise exception 'Invoice amount and currency are immutable after a payment allocation exists';
    end if;
  end if;

  if (new.amount_paid, new.paid, new.amount) is distinct from (old.amount_paid, old.paid, old.amount)
     and new.paid is distinct from (new.amount > 0 and new.amount_paid = new.amount) then
    raise exception 'Invoice paid flag is inconsistent with amount_paid';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_guard_payment_aggregates on public.invoices;
create trigger invoices_guard_payment_aggregates
  before insert or update of amount, amount_paid, paid, currency on public.invoices
  for each row execute function duewatch_ops.guard_invoice_payment_aggregates();
revoke all on function duewatch_ops.guard_invoice_payment_aggregates() from public, anon, authenticated;

-- Import persistence can create an invoice with a supported aggregate but no
-- historical payment identity. Capture that aggregate immediately as one
-- preservation-only legacy row; do not invent actor, date, or currency.
create or replace function duewatch_ops.capture_inserted_invoice_payment_aggregate()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_payment_id uuid;
begin
  if new.amount_paid <= 0 then
    return new;
  end if;
  insert into public.payments(
    user_id, recorded_by, recorded_at, payment_date, total_amount, currency,
    method, note, origin, legacy_invoice_id
  ) values (
    new.user_id, null, clock_timestamp(), new.payment_date, new.amount_paid,
    new.currency, null, null, 'legacy_carry_forward', new.id
  )
  on conflict (legacy_invoice_id) where legacy_invoice_id is not null do nothing
  returning id into v_payment_id;

  if v_payment_id is not null then
    insert into public.payment_allocations(payment_id, invoice_id, amount)
    values (v_payment_id, new.id, new.amount_paid);
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_capture_initial_payment_aggregate on public.invoices;
create trigger invoices_capture_initial_payment_aggregate
  after insert on public.invoices
  for each row execute function duewatch_ops.capture_inserted_invoice_payment_aggregate();
revoke all on function duewatch_ops.capture_inserted_invoice_payment_aggregate() from public, anon, authenticated;

-- Hardened founder write. There is intentionally no user_id argument: tenant
-- identity comes only from auth.uid(). The full total must be allocated.
create or replace function public.record_payment(
  p_payment_date date,
  p_total_amount numeric,
  p_currency text,
  p_allocations jsonb,
  p_method text default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment_id uuid;
  v_item jsonb;
  v_invoice public.invoices%rowtype;
  v_invoice_id uuid;
  v_amount numeric(12, 2);
  v_allocated numeric(12, 2) := 0;
  v_count integer := 0;
  v_allocation_id uuid;
  v_was_paid boolean;
  v_now_paid boolean;
  v_results jsonb := '[]'::jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_payment_date is null then raise exception 'Payment date is required'; end if;
  if p_payment_date > current_date then raise exception 'Payment date cannot be in the future'; end if;
  if p_total_amount is null or p_total_amount <= 0 then raise exception 'Payment total must be positive'; end if;
  if p_total_amount <> round(p_total_amount, 2) then raise exception 'Payment total has more than two decimal places'; end if;
  if p_currency is null or p_currency <> upper(trim(p_currency)) or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'A normalized three-letter currency is required';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'At least one explicit allocation is required';
  end if;
  if jsonb_array_length(p_allocations) > 100 then raise exception 'Too many allocations'; end if;
  if length(coalesce(p_method, '')) > 120 or length(coalesce(p_note, '')) > 2000 then
    raise exception 'Payment method or note is too long';
  end if;

  begin
    for v_item in select value from jsonb_array_elements(p_allocations) loop
      if coalesce(v_item->>'invoice_id', '') = '' or coalesce(v_item->>'amount', '') = '' then
        raise exception 'invalid';
      end if;
      v_invoice_id := (v_item->>'invoice_id')::uuid;
      v_amount := (v_item->>'amount')::numeric(12, 2);
      if v_amount <= 0 or (v_item->>'amount')::numeric <> v_amount then raise exception 'invalid'; end if;
      v_allocated := v_allocated + v_amount;
      v_count := v_count + 1;
    end loop;
  exception when others then
    raise exception 'Every allocation requires a valid invoice ID and positive two-decimal amount';
  end;

  if v_count <> (
    select count(distinct (value->>'invoice_id')) from jsonb_array_elements(p_allocations)
  ) then raise exception 'Each invoice may be allocated only once per payment'; end if;
  if v_allocated <> p_total_amount then
    raise exception 'Explicit allocation total must equal payment total';
  end if;

  -- Deterministic lock order prevents deadlocks for multi-invoice payments.
  for v_invoice in
    select i.*
    from public.invoices i
    join (
      select (value->>'invoice_id')::uuid as invoice_id
      from jsonb_array_elements(p_allocations)
    ) requested on requested.invoice_id = i.id
    order by i.id
    for update of i
  loop
    if v_invoice.user_id <> v_user_id then raise exception 'Invoice does not belong to authenticated tenant'; end if;
    if v_invoice.amount_paid < 0 or v_invoice.amount_paid > v_invoice.amount then
      raise exception 'Invoice has an invalid existing payment aggregate';
    end if;
    if v_invoice.paid is distinct from (v_invoice.amount > 0 and v_invoice.amount_paid = v_invoice.amount) then
      raise exception 'Invoice has an inconsistent existing paid flag';
    end if;
    if v_invoice.currency is null then
      if v_invoice.amount_paid <> 0 or exists (
        select 1 from public.payment_allocations a where a.invoice_id = v_invoice.id
      ) then
        raise exception 'Invoice has payment history with an unknown currency and requires review';
      end if;
      -- The founder supplied p_currency explicitly for this payment. Initializing
      -- a previously-unpaid legacy invoice here is supported fact, not a default.
      update public.invoices set currency = p_currency where id = v_invoice.id;
      v_invoice.currency := p_currency;
    elsif v_invoice.currency <> p_currency then
      raise exception 'Payment and invoice currencies must match exactly';
    end if;
  end loop;
  if not found or v_count <> (
    select count(*) from public.invoices i
    where i.id in (select (value->>'invoice_id')::uuid from jsonb_array_elements(p_allocations))
  ) then raise exception 'One or more invoices do not exist'; end if;

  insert into public.payments(
    user_id, recorded_by, payment_date, total_amount, currency, method, note, origin
  ) values (
    v_user_id, v_user_id, p_payment_date, p_total_amount, p_currency,
    nullif(trim(p_method), ''), nullif(trim(p_note), ''), 'founder_manual'
  ) returning id into v_payment_id;

  for v_item in select value from jsonb_array_elements(p_allocations) loop
    v_invoice_id := (v_item->>'invoice_id')::uuid;
    v_amount := (v_item->>'amount')::numeric(12, 2);
    select paid into v_was_paid from public.invoices where id = v_invoice_id;

    insert into public.payment_allocations(payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, v_amount)
    returning id into v_allocation_id;

    update public.invoices
    set amount_paid = amount_paid + v_amount,
        paid = (amount > 0 and amount_paid + v_amount = amount)
    where id = v_invoice_id
    returning paid into v_now_paid;

    insert into public.events(user_id, event_type, invoice_id, evidence)
    values (
      v_user_id, 'payment_recorded', v_invoice_id,
      jsonb_build_object(
        'payment_id', v_payment_id, 'allocation_id', v_allocation_id,
        'amount', v_amount, 'currency', p_currency,
        'payment_date', p_payment_date, 'origin', 'founder_manual'
      )
    );
    if not v_was_paid and v_now_paid then
      insert into public.events(user_id, event_type, invoice_id, evidence)
      values (
        v_user_id, 'invoice_marked_paid', v_invoice_id,
        jsonb_build_object('payment_id', v_payment_id, 'allocation_id', v_allocation_id)
      );
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'allocation_id', v_allocation_id, 'invoice_id', v_invoice_id,
      'amount', v_amount,
      'invoice_currency', (select currency from public.invoices where id = v_invoice_id),
      'invoice_amount_paid', (select amount_paid from public.invoices where id = v_invoice_id),
      'invoice_paid', v_now_paid
    ));
  end loop;

  return jsonb_build_object('payment_id', v_payment_id, 'allocations', v_results);
end;
$$;

create or replace function public.reverse_payment(
  p_payment_id uuid,
  p_reversal_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_allocation record;
  v_reversed_at timestamptz := clock_timestamp();
  v_results jsonb := '[]'::jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_payment_id is null then raise exception 'Payment ID is required'; end if;
  if nullif(trim(p_reversal_reason), '') is null then raise exception 'Reversal reason is required'; end if;
  if length(p_reversal_reason) > 1000 then raise exception 'Reversal reason is too long'; end if;

  select * into v_payment
  from public.payments
  where id = p_payment_id
  for update;
  if not found or v_payment.user_id <> v_user_id then raise exception 'Payment not found for authenticated tenant'; end if;
  if v_payment.reversed_at is not null then raise exception 'Payment has already been reversed'; end if;

  -- Lock all affected invoices in UUID order before changing any aggregate.
  perform i.id
  from public.invoices i
  join public.payment_allocations a on a.invoice_id = i.id
  where a.payment_id = p_payment_id
  order by i.id
  for update of i;

  for v_allocation in
    select a.id, a.invoice_id, a.amount, i.amount_paid, i.amount
    from public.payment_allocations a
    join public.invoices i on i.id = a.invoice_id
    where a.payment_id = p_payment_id
    order by i.id
  loop
    if v_allocation.amount_paid < v_allocation.amount then
      raise exception 'Invoice aggregate cannot safely reverse this payment';
    end if;
  end loop;

  update public.payments
  set reversed_at = v_reversed_at,
      reversed_by = v_user_id,
      reversal_reason = trim(p_reversal_reason)
  where id = p_payment_id;

  for v_allocation in
    select a.id, a.invoice_id, a.amount
    from public.payment_allocations a
    where a.payment_id = p_payment_id
    order by a.invoice_id
  loop
    update public.invoices
    set amount_paid = amount_paid - v_allocation.amount,
        paid = (amount > 0 and amount_paid - v_allocation.amount = amount)
    where id = v_allocation.invoice_id;

    insert into public.events(user_id, event_type, invoice_id, evidence)
    values (
      v_user_id, 'payment_reversed', v_allocation.invoice_id,
      jsonb_build_object(
        'payment_id', p_payment_id, 'allocation_id', v_allocation.id,
        'amount', v_allocation.amount, 'currency', v_payment.currency,
        'reversal_reason', trim(p_reversal_reason)
      )
    );
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'invoice_id', v_allocation.invoice_id,
      'invoice_amount_paid', (select amount_paid from public.invoices where id = v_allocation.invoice_id),
      'invoice_paid', (select paid from public.invoices where id = v_allocation.invoice_id)
    ));
  end loop;

  return jsonb_build_object(
    'payment_id', p_payment_id, 'reversed_at', v_reversed_at, 'invoices', v_results
  );
end;
$$;

-- Reads are tenant-scoped by RLS; writes are RPC-only.
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;

drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists payment_allocations_select_own on public.payment_allocations;
create policy payment_allocations_select_own on public.payment_allocations
  for select to authenticated
  using (exists (
    select 1 from public.payments p
    where p.id = payment_id and p.user_id = (select auth.uid())
  ));

revoke all on public.payments, public.payment_allocations from public, anon, authenticated;
grant select on public.payments, public.payment_allocations to authenticated;
grant select on public.payments, public.payment_allocations to service_role;

revoke all on function public.record_payment(date, numeric, text, jsonb, text, text)
  from public, anon;
grant execute on function public.record_payment(date, numeric, text, jsonb, text, text)
  to authenticated;
revoke all on function public.reverse_payment(uuid, text) from public, anon;
grant execute on function public.reverse_payment(uuid, text) to authenticated;

-- Reject genuinely impossible negative legacy aggregates rather than losing
-- or normalizing them. Positive amount_paid > amount is NOT rejected here:
-- the pre-ledger DueWatch Record Payment UI historically accepted any
-- positive payment amount, stored `newPaid = amount_paid + payment`, and
-- marked the invoice paid when `newPaid >= amount`. Production therefore
-- contains truthful legacy overpayment states created by DueWatch itself.
--
-- The migration preserves those exact aggregates as
-- origin='legacy_carry_forward'. Runtime founder_manual payments remain
-- unable to overpay because validate_payment_allocation() below enforces
-- invoice.amount_paid + allocation <= invoice.amount for founder_manual
-- rows. This is a legacy-preservation exception, not new payment authority.
do $preflight$
declare
  v_invalid bigint;
begin
  select count(*) into v_invalid
  from public.invoices
  where amount < 0 or amount_paid < 0;
  if v_invalid > 0 then
    raise exception 'Payments migration blocked: % invoice aggregates contain a negative invoice amount or amount_paid', v_invalid;
  end if;
end
$preflight$;

insert into duewatch_ops.payment_migration_invoice_snapshot(
  invoice_id, user_id, original_amount, original_amount_paid, original_paid
)
select id, user_id, amount, amount_paid, paid
from public.invoices
on conflict (invoice_id) do nothing;

-- Deterministic reconstruction: a valid payment_recorded amount is preferred.
-- invoice_marked_paid is used only when no payment_recorded event exists at
-- all for that invoice. If supported candidate value exceeds the preserved
-- aggregate, none of those candidates are reconstructed and the entire amount
-- remains one carry-forward, avoiding event + carry-forward double counting.
with valid_candidates as (
  select
    e.id as event_id, e.invoice_id, e.user_id, e.created_at,
    (trim(e.evidence->>'amount'))::numeric as amount,
    e.event_type,
    i.currency
  from public.events e
  join public.invoices i on i.id = e.invoice_id and i.user_id = e.user_id
  join duewatch_ops.payment_migration_invoice_snapshot s on s.invoice_id = i.id
  where s.original_amount_paid > 0
    and e.event_type in ('payment_recorded', 'invoice_marked_paid')
    and coalesce(trim(e.evidence->>'amount'), '') ~ '^\d+(\.\d{1,2})?$'
    and (trim(e.evidence->>'amount'))::numeric > 0
    and (trim(e.evidence->>'amount'))::numeric <= 9999999999.99
), preferred_candidates as (
  select c.*
  from valid_candidates c
  where c.event_type = 'payment_recorded'
     or (
       c.event_type = 'invoice_marked_paid'
       and not exists (
         select 1 from public.events pe
         where pe.invoice_id = c.invoice_id and pe.event_type = 'payment_recorded'
       )
     )
), safe_invoices as (
  select c.invoice_id
  from preferred_candidates c
  join duewatch_ops.payment_migration_invoice_snapshot s on s.invoice_id = c.invoice_id
  group by c.invoice_id, s.original_amount_paid
  having sum(c.amount) <= s.original_amount_paid
)
insert into public.payments(
  user_id, recorded_by, recorded_at, payment_date, total_amount, currency,
  method, note, origin, source_event_id
)
select
  c.user_id, null, c.created_at, null, c.amount, c.currency,
  null, null, 'legacy_carry_forward', c.event_id
from preferred_candidates c
join safe_invoices s on s.invoice_id = c.invoice_id
on conflict (source_event_id) where source_event_id is not null do nothing;

insert into public.payment_allocations(payment_id, invoice_id, amount)
select p.id, e.invoice_id, p.total_amount
from public.payments p
join public.events e on e.id = p.source_event_id
where p.origin = 'legacy_carry_forward'
  and p.source_event_id is not null
  and not exists (
    select 1 from public.payment_allocations a where a.payment_id = p.id
  );

with residuals as (
  select
    s.invoice_id, s.user_id, s.original_amount_paid,
    (s.original_amount_paid - coalesce(sum(a.amount), 0))::numeric(12, 2) as residual,
    count(*) filter (where p.source_event_id is not null) as reconstructed_count
  from duewatch_ops.payment_migration_invoice_snapshot s
  left join public.payment_allocations a on a.invoice_id = s.invoice_id
  left join public.payments p on p.id = a.payment_id and p.origin = 'legacy_carry_forward'
  group by s.invoice_id, s.user_id, s.original_amount_paid
)
insert into public.payments(
  user_id, recorded_by, recorded_at, payment_date, total_amount, currency,
  method, note, origin, legacy_invoice_id
)
select
  r.user_id, null, clock_timestamp(),
  case when r.reconstructed_count = 0 then i.payment_date else null end,
  r.residual, i.currency, null, null, 'legacy_carry_forward', r.invoice_id
from residuals r
join public.invoices i on i.id = r.invoice_id
where r.residual > 0
on conflict (legacy_invoice_id) where legacy_invoice_id is not null do nothing;

insert into public.payment_allocations(payment_id, invoice_id, amount)
select p.id, p.legacy_invoice_id, p.total_amount
from public.payments p
where p.origin = 'legacy_carry_forward'
  and p.legacy_invoice_id is not null
  and not exists (
    select 1 from public.payment_allocations a where a.payment_id = p.id
  );

insert into duewatch_ops.payment_migration_audit(
  id, generated_at, invoices_with_preexisting_amount_paid,
  reconstructed_invoices, reconstructed_payment_rows,
  carry_forward_invoices, carry_forward_payment_rows,
  amount_paid_mismatches, inconsistent_paid_flags,
  unknown_payment_dates, unknown_currencies
)
select
  1, clock_timestamp(),
  count(distinct s.invoice_id) filter (where s.original_amount_paid > 0),
  count(distinct s.invoice_id) filter (where p.source_event_id is not null),
  count(distinct p.id) filter (where p.source_event_id is not null),
  count(distinct s.invoice_id) filter (where p.legacy_invoice_id is not null),
  count(distinct p.id) filter (where p.legacy_invoice_id is not null),
  count(distinct s.invoice_id) filter (
    where s.original_amount_paid <> coalesce((
      select sum(a2.amount)
      from public.payment_allocations a2
      join public.payments p2 on p2.id = a2.payment_id
      where a2.invoice_id = s.invoice_id and p2.reversed_at is null
    ), 0)
  ),
  count(*) filter (
    where s.original_paid is distinct from (s.original_amount > 0 and s.original_amount_paid >= s.original_amount)
  ),
  count(distinct p.id) filter (where p.payment_date is null),
  count(distinct p.id) filter (where p.currency is null)
from duewatch_ops.payment_migration_invoice_snapshot s
left join public.payment_allocations a on a.invoice_id = s.invoice_id
left join public.payments p on p.id = a.payment_id and p.origin = 'legacy_carry_forward'
on conflict (id) do update set
  generated_at = excluded.generated_at,
  invoices_with_preexisting_amount_paid = excluded.invoices_with_preexisting_amount_paid,
  reconstructed_invoices = excluded.reconstructed_invoices,
  reconstructed_payment_rows = excluded.reconstructed_payment_rows,
  carry_forward_invoices = excluded.carry_forward_invoices,
  carry_forward_payment_rows = excluded.carry_forward_payment_rows,
  amount_paid_mismatches = excluded.amount_paid_mismatches,
  inconsistent_paid_flags = excluded.inconsistent_paid_flags,
  unknown_payment_dates = excluded.unknown_payment_dates,
  unknown_currencies = excluded.unknown_currencies;

do $postflight$
declare
  v_mismatches bigint;
begin
  select amount_paid_mismatches into v_mismatches
  from duewatch_ops.payment_migration_audit where id = 1;
  if v_mismatches <> 0 then
    raise exception 'Payments migration invariant failed: % pre/post amount_paid mismatches', v_mismatches;
  end if;
end
$postflight$;

commit;
