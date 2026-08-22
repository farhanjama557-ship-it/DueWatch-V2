-- Phase 2, Slice 1: Promise-to-Pay core lifecycle (happy path only).
--
-- SCOPE: Detected -> Proposed -> founder confirms -> Confirmed. "Due Soon"
-- and "Due Today" are Slice 4 presentation states computed from a confirmed
-- row's promised_date vs. today -- this migration never stores them.
--
-- EXPLICITLY OUT OF SCOPE (do not read this migration as implementing any
-- of the following -- they are later slices, tracked separately):
-- - Detected: there is no detector here. Every 'proposed' row in this slice
--   originates from an explicit founder-recorded conversation (p_source),
--   never an inferred one.
-- - Broken, Fulfilled, Cancelled, Disputed, Rejected, or any supersession
--   chain (old -> Superseded, new -> governs).
-- - Any dunning-suppression / Autopilot hold tied to a promise. No shared
--   Autopilot hold primitive exists yet (only the unrelated, already-shipped
--   invoices.autopilot_paused boolean) -- this migration does not invent a
--   Promise-to-Pay-specific stand-in for one.
--
-- GOVERNING INVARIANT -- durable representation, decided once here so later
-- slices don't have to re-derive it:
-- A promise's status stays 'confirmed' for as long as it durably governs its
-- invoice. Due Soon / Due Today / Broken are presentation computed from that
-- same confirmed row (the last two are Slice 2/4 concerns); only a later
-- slice's genuinely terminal, founder- or evidence-driven transition
-- (Fulfilled, Cancelled, Superseded, Rejected) ever moves a row's status away
-- from 'confirmed'. Therefore `governing == status = 'confirmed'` is correct
-- and forward-compatible: when a future slice adds a real terminal status,
-- the row leaving 'confirmed' is exactly what frees the partial unique index
-- below to let a superseding promise become the new governing one.
--
-- CURRENCY: a promise's currency is an immutable snapshot of its invoice's
-- currency at proposal time -- never independently chosen, never converted.
-- Both RPCs below derive it server-side from the invoice and re-validate it
-- has not drifted; there is no client-facing currency parameter.
--
-- TENANT FK: promises use the same composite (user_id, invoice_id) ->
-- invoices(user_id, id) pattern already established by
-- 20260803021842_enforce_invoice_client_tenant_ownership.sql for
-- invoices -> clients, targeting the existing invoices_user_id_id_uidx
-- (20260803150000_import_persistence_core.sql). Deletion is RESTRICT, not
-- CASCADE, on every FK here -- a promise is an audit/evidence record and
-- must never be silently deleted by deleting the invoice or user it's about.

begin;

-- Idempotent -- 20260816120000_payments_foundation.sql already creates this
-- schema on current main, but the targeted (checkpoint-only) CI verifier
-- does not apply that migration, so this migration must not assume the
-- schema already exists.
create schema if not exists duewatch_ops;

create table if not exists public.promises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  invoice_id uuid not null,
  status text not null default 'proposed' check (status in ('proposed', 'confirmed')),
  promised_amount numeric(12, 2) not null check (promised_amount > 0),
  promised_date date,
  currency text not null check (currency = upper(currency) and currency ~ '^[A-Z]{3}$'),
  source text not null check (source in ('email', 'phone', 'text', 'person', 'reply')),
  note text,
  confirmed_by uuid references auth.users(id) on delete restrict,
  confirmed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint promises_user_id_invoice_id_fkey
    foreign key (user_id, invoice_id) references public.invoices (user_id, id) on delete restrict,
  constraint promises_confirmed_shape_check check (
    (status = 'proposed' and confirmed_by is null and confirmed_at is null)
    or
    (status = 'confirmed' and confirmed_by is not null and confirmed_at is not null
     and promised_date is not null)
  )
);

comment on column public.promises.currency is
  'Immutable snapshot of invoices.currency at proposal time -- never independently chosen, never converted.';
comment on column public.promises.confirmed_at is
  'Current-state query metadata only, written atomically with the matching promise_events row. Never a competing evidence source -- read promise_events for the canonical historical/evidence record.';

create index if not exists promises_user_invoice_idx on public.promises(user_id, invoice_id);

-- The DB-level guarantee that only one promise governs an invoice at a time,
-- independent of RPC or application logic. Multiple 'proposed' rows per
-- invoice are allowed (the review queue); only one may hold 'confirmed'.
create unique index if not exists promises_one_governing_per_invoice
  on public.promises (invoice_id) where status = 'confirmed';

-- Canonical historical/evidence record. public.promises is the canonical
-- CURRENT-STATE record; this table is append-only and is the only place a
-- founder-facing claim about "when" should ever be derived from.
create table if not exists public.promise_events (
  id uuid primary key default gen_random_uuid(),
  promise_id uuid not null references public.promises(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null check (event_type in ('proposed', 'confirmed')),
  actor_id uuid references auth.users(id) on delete restrict,
  detail jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists promise_events_promise_id_idx on public.promise_events(promise_id, created_at);

-- Once confirmed, a promise's terms are immutable. Status transitions happen
-- only via the RPCs below (which use security definer and are not blocked by
-- this trigger on themselves since they perform the same update this trigger
-- inspects -- the trigger only ever rejects a change to an ALREADY-confirmed
-- row's terms, never the proposed->confirmed transition itself).
create or replace function duewatch_ops.guard_promise_immutability()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
begin
  if old.status = 'confirmed' then
    if (new.promised_amount, new.promised_date, new.currency, new.invoice_id, new.user_id)
       is distinct from
       (old.promised_amount, old.promised_date, old.currency, old.invoice_id, old.user_id) then
      raise exception 'Confirmed promise terms are immutable';
    end if;
  end if;
  if new.status = 'confirmed' and (new.promised_date is null or new.currency is null) then
    raise exception 'A promise cannot be confirmed without a promised date and currency';
  end if;
  return new;
end;
$$;

drop trigger if exists promises_guard_immutability on public.promises;
create trigger promises_guard_immutability
  before update on public.promises
  for each row execute function duewatch_ops.guard_promise_immutability();
revoke all on function duewatch_ops.guard_promise_immutability() from public, anon, authenticated;

-- Evidence events are append-only, mirroring
-- duewatch_ops.reject_payment_allocation_mutation()'s immutable-ledger
-- pattern in 20260816120000_payments_foundation.sql.
create or replace function duewatch_ops.reject_promise_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
begin
  raise exception 'Promise events are immutable';
end;
$$;

drop trigger if exists promise_events_immutable on public.promise_events;
create trigger promise_events_immutable
  before update or delete on public.promise_events
  for each row execute function duewatch_ops.reject_promise_event_mutation();
revoke all on function duewatch_ops.reject_promise_event_mutation() from public, anon, authenticated;

alter table public.promises enable row level security;
alter table public.promise_events enable row level security;

drop policy if exists promises_select_own on public.promises;
create policy promises_select_own on public.promises
  for select using (auth.uid() = user_id);

drop policy if exists promise_events_select_own on public.promise_events;
create policy promise_events_select_own on public.promise_events
  for select using (auth.uid() = user_id);

-- No direct insert/update/delete policies: every write goes through the
-- hardened RPCs below. Explicitly revoke from service_role too, then grant
-- select back -- do not rely on whatever this Postgres instance's default
-- privileges happen to be for service_role; state the intended grant
-- explicitly so it holds regardless of environment.
revoke all on public.promises, public.promise_events from public, anon, authenticated, service_role;
grant select on public.promises, public.promise_events to authenticated;
grant select on public.promises, public.promise_events to service_role;

-- Records a founder-recorded conversation as a review-queue candidate. Does
-- not touch the invoice and does not require the invoice to have no other
-- proposals -- multiple proposals per invoice are the review queue.
create or replace function public.propose_promise(
  p_invoice_id uuid,
  p_promised_amount numeric,
  p_promised_date date,
  p_source text,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice public.invoices%rowtype;
  v_promise_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_invoice_id is null then raise exception 'An invoice is required'; end if;
  if p_promised_amount is null or p_promised_amount <= 0 then
    raise exception 'Promised amount must be positive';
  end if;
  if p_promised_amount <> round(p_promised_amount, 2) then
    raise exception 'Promised amount has more than two decimal places';
  end if;
  if p_source is null or p_source not in ('email', 'phone', 'text', 'person', 'reply') then
    raise exception 'A recognized evidence source is required';
  end if;
  if length(coalesce(p_note, '')) > 2000 then raise exception 'Note is too long'; end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found or v_invoice.user_id <> v_user_id then
    raise exception 'Invoice does not belong to authenticated tenant';
  end if;
  if v_invoice.currency is null then
    raise exception 'This invoice needs an explicit currency before a promise can be proposed';
  end if;

  insert into public.promises(
    user_id, invoice_id, status, promised_amount, promised_date, currency, source, note
  ) values (
    v_user_id, p_invoice_id, 'proposed', p_promised_amount, p_promised_date,
    v_invoice.currency, p_source, nullif(trim(p_note), '')
  ) returning id into v_promise_id;

  insert into public.promise_events(promise_id, user_id, event_type, actor_id, detail)
  values (
    v_promise_id, v_user_id, 'proposed', v_user_id,
    jsonb_build_object(
      'invoice_id', p_invoice_id, 'promised_amount', p_promised_amount,
      'promised_date', p_promised_date, 'currency', v_invoice.currency, 'source', p_source
    )
  );

  return jsonb_build_object('promise_id', v_promise_id, 'status', 'proposed');
end;
$$;

-- The one moment a proposal's amount/date can still be adjusted before
-- locking -- the founder confirms with the final agreed terms. Relies on
-- promises_one_governing_per_invoice to fail loudly if another promise
-- already governs this invoice.
create or replace function public.confirm_promise(
  p_promise_id uuid,
  p_promised_amount numeric,
  p_promised_date date
) returns jsonb
language plpgsql
security definer
set search_path = public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_promise public.promises%rowtype;
  v_invoice public.invoices%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_promise_id is null then raise exception 'A promise is required'; end if;
  if p_promised_amount is null or p_promised_amount <= 0 then
    raise exception 'Promised amount must be positive';
  end if;
  if p_promised_amount <> round(p_promised_amount, 2) then
    raise exception 'Promised amount has more than two decimal places';
  end if;
  if p_promised_date is null then raise exception 'A promised date is required to confirm' ; end if;

  -- Deterministic lock order (promise, then invoice) since both this RPC
  -- and no other RPC in this migration ever locks them in the reverse
  -- order -- there is no deadlock risk to order against yet, but the same
  -- discipline as record_payment/reverse_payment is kept for consistency.
  select * into v_promise from public.promises where id = p_promise_id for update;
  if not found or v_promise.user_id <> v_user_id then
    raise exception 'Promise does not belong to authenticated tenant';
  end if;
  if v_promise.status <> 'proposed' then
    raise exception 'Only a proposed promise can be confirmed';
  end if;

  select * into v_invoice from public.invoices where id = v_promise.invoice_id for update;
  if not found or v_invoice.user_id <> v_user_id then
    raise exception 'Invoice does not belong to authenticated tenant';
  end if;
  if v_invoice.currency is distinct from v_promise.currency then
    raise exception 'Invoice currency has changed since this promise was proposed';
  end if;

  begin
    update public.promises
    set status = 'confirmed',
        promised_amount = p_promised_amount,
        promised_date = p_promised_date,
        confirmed_by = v_user_id,
        confirmed_at = clock_timestamp()
    where id = p_promise_id;
  exception when unique_violation then
    raise exception 'Another promise already governs this invoice';
  end;

  insert into public.promise_events(promise_id, user_id, event_type, actor_id, detail)
  values (
    p_promise_id, v_user_id, 'confirmed', v_user_id,
    jsonb_build_object(
      'invoice_id', v_promise.invoice_id, 'promised_amount', p_promised_amount,
      'promised_date', p_promised_date, 'currency', v_promise.currency
    )
  );

  return jsonb_build_object('promise_id', p_promise_id, 'status', 'confirmed');
end;
$$;

-- Explicitly revoke first -- do not rely on whatever this Postgres
-- instance's default function-execute privileges happen to be for
-- public/anon/service_role; state the intended grant explicitly (only
-- authenticated may call these) so it holds regardless of environment.
revoke execute on function public.propose_promise(uuid, numeric, date, text, text)
  from public, anon, service_role;
revoke execute on function public.confirm_promise(uuid, numeric, date)
  from public, anon, service_role;
grant execute on function public.propose_promise(uuid, numeric, date, text, text) to authenticated;
grant execute on function public.confirm_promise(uuid, numeric, date) to authenticated;

commit;
