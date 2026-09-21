-- Astra audit reconciliation hardening.
-- Closes durable idempotency, approval/policy serialization, Promise lifecycle,
-- unresolved manual-send replay, and tenant-owned event relationship gaps.

begin;

-- ---------------------------------------------------------------------------
-- Payment recording: stable tenant-scoped operation identity.
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists operation_key text,
  add column if not exists operation_request jsonb,
  add column if not exists operation_result jsonb;

create unique index if not exists payments_user_operation_key_uniq
  on public.payments(user_id, operation_key)
  where operation_key is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payments_operation_key_shape'
      and conrelid = 'public.payments'::regclass
  ) then
    alter table public.payments
      add constraint payments_operation_key_shape
      check (
        operation_key is null
        or (length(btrim(operation_key)) between 1 and 200 and operation_key = btrim(operation_key))
      );
  end if;
end
$$;

-- The previously shipped six-argument implementation remains the single
-- payment mutation primitive, but is no longer browser-callable. The new
-- wrapper below serializes one user operation, validates payload replay, and
-- persists the exact original response.
alter function public.record_payment(date, numeric, text, jsonb, text, text)
  rename to record_payment_unkeyed_internal;
alter function public.record_payment_unkeyed_internal(date, numeric, text, jsonb, text, text)
  set schema duewatch_ops;

revoke all on function duewatch_ops.record_payment_unkeyed_internal(date, numeric, text, jsonb, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.record_payment(
  p_payment_date date,
  p_total_amount numeric,
  p_currency text,
  p_allocations jsonb,
  p_operation_key text,
  p_method text default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_operation_key text := btrim(coalesce(p_operation_key, ''));
  v_request jsonb;
  v_allocations jsonb;
  v_existing_request jsonb;
  v_existing_result jsonb;
  v_result jsonb;
  v_payment_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if v_operation_key = '' or length(v_operation_key) > 200 then
    raise exception 'PAYMENT_OPERATION_KEY_REQUIRED';
  end if;

  begin
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'invoice_id', value->>'invoice_id',
          'amount', (value->>'amount')::numeric(12,2)
        )
        order by value->>'invoice_id'
      ),
      '[]'::jsonb
    )
    into v_allocations
    from jsonb_array_elements(p_allocations);
  exception when others then
    raise exception 'Every allocation requires a valid invoice ID and positive two-decimal amount';
  end;

  v_request := jsonb_build_object(
    'payment_date', p_payment_date,
    'total_amount', p_total_amount::numeric(12,2),
    'currency', p_currency,
    'allocations', v_allocations,
    'method', nullif(btrim(p_method), ''),
    'note', nullif(btrim(p_note), '')
  );

  -- Same tenant + same operation key is one serialized operation even when
  -- two browser retries arrive concurrently.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || ':' || v_operation_key, 0)
  );

  select operation_request, operation_result
  into v_existing_request, v_existing_result
  from public.payments
  where user_id = v_user_id
    and operation_key = v_operation_key
  for update;

  if found then
    if v_existing_request is distinct from v_request then
      raise exception 'PAYMENT_OPERATION_CONFLICT';
    end if;
    if v_existing_result is null then
      raise exception 'PAYMENT_OPERATION_RESULT_UNAVAILABLE';
    end if;
    return v_existing_result;
  end if;

  v_result := duewatch_ops.record_payment_unkeyed_internal(
    p_payment_date,
    p_total_amount,
    p_currency,
    p_allocations,
    p_method,
    p_note
  );

  v_payment_id := nullif(v_result->>'payment_id', '')::uuid;
  if v_payment_id is null then
    raise exception 'PAYMENT_OPERATION_RESULT_INVALID';
  end if;

  update public.payments
  set operation_key = v_operation_key,
      operation_request = v_request,
      operation_result = v_result
  where id = v_payment_id
    and user_id = v_user_id
    and operation_key is null;

  if not found then
    raise exception 'PAYMENT_OPERATION_RECEIPT_WRITE_FAILED';
  end if;

  return v_result;
end;
$$;

revoke all on function public.record_payment(date, numeric, text, jsonb, text, text, text)
  from public, anon;
grant execute on function public.record_payment(date, numeric, text, jsonb, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Promise lifecycle: settlement can never make cancellation impossible.
-- ---------------------------------------------------------------------------
drop trigger if exists promises_validate on public.promises;
drop function if exists public.validate_promise_row();

create or replace function public.validate_promise_row()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_balance numeric(12,2);
  v_requires_balance_check boolean := false;
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

  if tg_op = 'INSERT' then
    v_requires_balance_check := true;
    new.status := 'proposed';
    new.confirmed_at := null;
    new.cancelled_at := null;
  else
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
      v_requires_balance_check := true;
      new.confirmed_at := clock_timestamp();
      new.cancelled_at := null;
    elsif old.status = 'proposed'
       and new.status = 'proposed'
       and new.promised_amount is distinct from old.promised_amount then
      v_requires_balance_check := true;
    elsif new.status = 'cancelled' and old.status in ('proposed', 'confirmed') then
      -- Cancellation resolves historical commitment state. It must remain
      -- possible after partial/full settlement, so no current-balance gate.
      new.cancelled_at := clock_timestamp();
    elsif new.status is distinct from old.status then
      raise exception 'Unsupported promise state transition % -> %', old.status, new.status;
    end if;
  end if;

  if v_requires_balance_check and new.promised_amount > v_balance then
    raise exception 'Promise amount cannot exceed the current invoice balance';
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

create or replace function public.replace_promise(
  p_existing_id uuid,
  p_promised_amount numeric,
  p_promised_date date,
  p_source text default 'founder_manual',
  p_note text default null
) returns public.promises
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.promises%rowtype;
  v_new public.promises%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_existing
  from public.promises
  where id = p_existing_id
    and user_id = v_user_id
  for update;

  if not found then raise exception 'PROMISE_NOT_FOUND' using errcode = '42501'; end if;
  if v_existing.status not in ('proposed', 'confirmed') then
    raise exception 'PROMISE_ALREADY_RESOLVED';
  end if;

  update public.promises
  set status = 'cancelled'
  where id = v_existing.id
    and user_id = v_user_id
    and status in ('proposed', 'confirmed');

  if not found then raise exception 'PROMISE_STATE_CHANGED'; end if;

  insert into public.promises(
    user_id, invoice_id, promised_amount, promised_date, currency, source, note
  ) values (
    v_user_id,
    v_existing.invoice_id,
    p_promised_amount,
    p_promised_date,
    v_existing.currency,
    coalesce(nullif(btrim(p_source), ''), 'founder_manual'),
    nullif(btrim(p_note), '')
  )
  returning * into v_new;

  return v_new;
end;
$$;

revoke all on function public.replace_promise(uuid, numeric, date, text, text)
  from public, anon;
grant execute on function public.replace_promise(uuid, numeric, date, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Autopilot: atomically bind policy + approval state to dispatch acquisition.
-- ---------------------------------------------------------------------------
create or replace function public.acquire_guarded_autopilot_execution_claim(
  p_user_id uuid,
  p_invoice_id uuid,
  p_rule_id uuid,
  p_action_type text,
  p_idempotency_key text,
  p_receipt jsonb,
  p_expected_rule_snapshot jsonb,
  p_expected_approval_required boolean,
  p_approval_id uuid default null
) returns table(
  claim_id uuid,
  acquired boolean,
  existing_status text,
  stale_reason text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_claim_id uuid;
  v_existing_status text;
  v_settings record;
  v_rule record;
  v_actual_rule_snapshot jsonb;
  v_approval public.awaiting_signature%rowtype;
begin
  if p_user_id is null or p_invoice_id is null or p_rule_id is null
     or p_action_type is null or btrim(p_action_type) = ''
     or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or p_expected_rule_snapshot is null
     or p_expected_approval_required is null then
    raise exception 'AUTOPILOT_GUARDED_CLAIM_IDENTITY_REQUIRED';
  end if;

  if not exists (
    select 1 from public.invoices where id = p_invoice_id and user_id = p_user_id
  ) then
    raise exception 'AUTOPILOT_GUARDED_CLAIM_TENANT_MISMATCH';
  end if;

  -- Row locks serialize policy mutation with authority acquisition. A policy
  -- update that wins first is observed below and stales the claim. A policy
  -- update that waits behind this function occurs only after authority has
  -- been atomically acquired.
  select enabled, approval_required
  into v_settings
  from public.autopilot_settings
  where user_id = p_user_id
  for share;

  if not found or v_settings.enabled is distinct from true
     or v_settings.approval_required is distinct from p_expected_approval_required then
    return query select null::uuid, false, null::text, 'settings_changed'::text;
    return;
  end if;

  select id, trigger_type, trigger_days, tone, enabled, sort_order
  into v_rule
  from public.autopilot_rules
  where id = p_rule_id
    and user_id = p_user_id
  for share;

  if not found then
    return query select null::uuid, false, null::text, 'rule_missing'::text;
    return;
  end if;

  v_actual_rule_snapshot := jsonb_build_object(
    'id', v_rule.id,
    'trigger_type', v_rule.trigger_type,
    'trigger_days', v_rule.trigger_days,
    'tone', v_rule.tone,
    'enabled', v_rule.enabled,
    'sort_order', v_rule.sort_order
  );

  if v_actual_rule_snapshot is distinct from p_expected_rule_snapshot then
    return query select null::uuid, false, null::text, 'rule_changed'::text;
    return;
  end if;

  if p_approval_id is not null then
    if p_expected_approval_required is distinct from true then
      return query select null::uuid, false, null::text, 'approval_policy_changed'::text;
      return;
    end if;

    select * into v_approval
    from public.awaiting_signature
    where id = p_approval_id
    for update;

    if not found
       or v_approval.user_id is distinct from p_user_id
       or v_approval.invoice_id is distinct from p_invoice_id
       or v_approval.status is distinct from 'pending' then
      return query select null::uuid, false, null::text, 'approval_state_changed'::text;
      return;
    end if;

    if coalesce(v_approval.ai_context->'ruleSnapshot', 'null'::jsonb)
         is distinct from p_expected_rule_snapshot then
      return query select null::uuid, false, null::text, 'approval_rule_changed'::text;
      return;
    end if;
  elsif p_expected_approval_required is distinct from false then
    return query select null::uuid, false, null::text, 'approval_required'::text;
    return;
  end if;

  insert into public.autopilot_execution_claims(
    id, user_id, invoice_id, rule_id, action_type, idempotency_key,
    status, evidence, claimed_at
  ) values (
    gen_random_uuid(), p_user_id, p_invoice_id, p_rule_id, p_action_type,
    p_idempotency_key, 'in_flight', coalesce(p_receipt, '{}'::jsonb), now()
  )
  on conflict (user_id, invoice_id, rule_id, action_type) do nothing
  returning id into v_claim_id;

  if v_claim_id is null then
    select id, status into v_claim_id, v_existing_status
    from public.autopilot_execution_claims
    where user_id = p_user_id
      and invoice_id = p_invoice_id
      and rule_id = p_rule_id
      and action_type = p_action_type;

    return query select v_claim_id, false, v_existing_status, null::text;
    return;
  end if;

  if p_approval_id is not null then
    update public.awaiting_signature
    set status = 'dispatching',
        resolved_at = null
    where id = p_approval_id
      and user_id = p_user_id
      and invoice_id = p_invoice_id
      and status = 'pending';

    if not found then
      raise exception 'AUTOPILOT_APPROVAL_CONSUME_RACE';
    end if;
  end if;

  return query select v_claim_id, true, null::text, null::text;
end;
$$;

revoke all on function public.acquire_guarded_autopilot_execution_claim(
  uuid, uuid, uuid, text, text, jsonb, jsonb, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.acquire_guarded_autopilot_execution_claim(
  uuid, uuid, uuid, text, text, jsonb, jsonb, boolean, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Founder manual reminders: stable operation identity + unresolved guard.
-- ---------------------------------------------------------------------------
create or replace function public.acquire_external_action_claim(
  p_user_id uuid,
  p_invoice_id uuid,
  p_action_type text,
  p_idempotency_key text,
  p_message_hash text default null,
  p_receipt jsonb default '{}'::jsonb
) returns table(
  claim_id uuid,
  acquired boolean,
  existing_status text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
  v_status text;
  v_existing_hash text;
begin
  if p_user_id is null or p_invoice_id is null then
    raise exception 'EXTERNAL_ACTION_IDENTITY_REQUIRED';
  end if;
  if p_action_type is null or btrim(p_action_type) = '' or length(p_action_type) > 80 then
    raise exception 'EXTERNAL_ACTION_TYPE_INVALID';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 200 then
    raise exception 'EXTERNAL_ACTION_IDEMPOTENCY_INVALID';
  end if;
  if p_message_hash is not null and length(p_message_hash) > 128 then
    raise exception 'EXTERNAL_ACTION_HASH_INVALID';
  end if;

  if not exists (
    select 1 from public.invoices
    where id = p_invoice_id and user_id = p_user_id
  ) then
    raise exception 'EXTERNAL_ACTION_TENANT_MISMATCH';
  end if;

  -- An unresolved provider attempt stays unresolved forever until reconciled;
  -- changing operation IDs or merely waiting may not create another send.
  if p_message_hash is not null and exists (
    select 1
    from public.external_action_claims
    where user_id = p_user_id
      and invoice_id = p_invoice_id
      and action_type = p_action_type
      and message_hash = p_message_hash
      and status in ('in_flight', 'uncertain')
  ) then
    select id, status into v_id, v_status
    from public.external_action_claims
    where user_id = p_user_id
      and invoice_id = p_invoice_id
      and action_type = p_action_type
      and message_hash = p_message_hash
      and status in ('in_flight', 'uncertain')
    order by claimed_at desc
    limit 1;
    return query select v_id, false, v_status;
    return;
  end if;

  insert into public.external_action_claims(
    user_id, invoice_id, action_type, idempotency_key,
    message_hash, evidence, status, claimed_at
  ) values (
    p_user_id, p_invoice_id, p_action_type, p_idempotency_key,
    p_message_hash, coalesce(p_receipt, '{}'::jsonb), 'in_flight', now()
  )
  on conflict (user_id, action_type, idempotency_key) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true, null::text;
    return;
  end if;

  select id, status, message_hash into v_id, v_status, v_existing_hash
  from public.external_action_claims
  where user_id = p_user_id
    and action_type = p_action_type
    and idempotency_key = p_idempotency_key;

  if v_existing_hash is distinct from p_message_hash then
    raise exception 'EXTERNAL_ACTION_OPERATION_CONFLICT';
  end if;

  return query select v_id, false, v_status;
end;
$$;

revoke all on function public.acquire_external_action_claim(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.acquire_external_action_claim(uuid, uuid, text, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Event references must stay inside the event tenant.
-- ---------------------------------------------------------------------------
create or replace function public.validate_event_relationships()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.invoice_id is not null and not exists (
    select 1 from public.invoices
    where id = new.invoice_id and user_id = new.user_id
  ) then
    raise exception 'EVENT_INVOICE_TENANT_MISMATCH';
  end if;

  if new.previous_action_id is not null and not exists (
    select 1 from public.events
    where id = new.previous_action_id and user_id = new.user_id
  ) then
    raise exception 'EVENT_PREVIOUS_ACTION_TENANT_MISMATCH';
  end if;

  return new;
end;
$$;

drop trigger if exists events_validate_relationships on public.events;
create trigger events_validate_relationships
  before insert or update of user_id, invoice_id, previous_action_id
  on public.events
  for each row execute function public.validate_event_relationships();

revoke all on function public.validate_event_relationships() from public, anon;

commit;
