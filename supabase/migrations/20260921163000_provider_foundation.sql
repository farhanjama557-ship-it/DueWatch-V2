-- Provider foundation phase 1.
-- No network calls and no provider-driven ledger writes are enabled here.
-- This migration establishes persistence, tenant boundaries, and the shared
-- tenant-explicit payment primitive required by later provider reconciliation.

begin;

create schema if not exists duewatch_ops;
grant usage on schema duewatch_ops to service_role;

-- ---------------------------------------------------------------------------
-- 1. Provider connections.
-- Base table is service-role only. Browser visibility comes from the safe view
-- below, which never exposes credential or webhook-secret references.
-- ---------------------------------------------------------------------------
create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_account_id text not null,
  environment text not null,
  status text not null default 'connected',
  granted_scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  webhook_secret_ref text,
  credential_ref text,
  constraint provider_connections_provider_check
    check (provider = lower(btrim(provider)) and length(provider) between 2 and 40),
  constraint provider_connections_account_check
    check (length(btrim(provider_account_id)) between 1 and 255),
  constraint provider_connections_status_check
    check (status in ('connected','needs_reconnect','disconnected','unavailable')),
  constraint provider_connections_env_check
    check (environment in ('live','test')),
  unique (user_id, id),
  unique (user_id, provider, provider_account_id, environment)
);

-- ---------------------------------------------------------------------------
-- 2. OAuth state. Service-role only; no browser grant or policy.
-- ---------------------------------------------------------------------------
create table public.provider_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  state_token text not null unique,
  code_verifier text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint provider_oauth_states_provider_check
    check (provider = lower(btrim(provider)) and length(provider) between 2 and 40),
  constraint provider_oauth_states_state_check
    check (length(state_token) between 32 and 512),
  constraint provider_oauth_states_lifecycle_check
    check (consumed_at is null or consumed_at >= created_at)
);
create index provider_oauth_states_expiry_idx
  on public.provider_oauth_states(expires_at)
  where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 3. Raw webhook receipts. Unverified payloads stay unattributed.
-- ---------------------------------------------------------------------------
create table public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid,
  user_id uuid,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  api_version text,
  livemode boolean,
  signature_verified boolean not null,
  raw_body text not null,
  request_headers jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'pending',
  processing_error text,
  constraint provider_webhook_events_provider_check
    check (provider = lower(btrim(provider)) and length(provider) between 2 and 40),
  constraint provider_webhook_events_event_id_check
    check (length(btrim(provider_event_id)) between 1 and 255),
  constraint provider_webhook_events_status_check
    check (processing_status in ('pending','processed','parked','quarantined')),
  constraint provider_webhook_events_attribution_pair_check
    check ((connection_id is null and user_id is null) or
           (connection_id is not null and user_id is not null)),
  constraint provider_webhook_events_connection_fk
    foreign key (user_id, connection_id)
    references public.provider_connections(user_id, id)
    on delete restrict,
  unique (provider, provider_event_id, connection_id)
);
create index provider_webhook_events_processing_idx
  on public.provider_webhook_events(processing_status, received_at);

-- ---------------------------------------------------------------------------
-- 4. Normalised provider objects.
-- ---------------------------------------------------------------------------
create table public.provider_objects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  object_type text not null,
  provider_object_id text not null,
  object_state jsonb not null,
  provider_created_at timestamptz,
  observed_at timestamptz not null default now(),
  evidence_class text not null,
  unique (user_id, id),
  unique (user_id, connection_id, object_type, provider_object_id),
  constraint provider_objects_connection_fk
    foreign key (user_id, connection_id)
    references public.provider_connections(user_id, id)
    on delete cascade,
  constraint provider_objects_type_check
    check (length(btrim(object_type)) between 1 and 80),
  constraint provider_objects_object_id_check
    check (length(btrim(provider_object_id)) between 1 and 255),
  constraint provider_objects_evidence_class_check
    check (evidence_class in (
      'PROVIDER_NATIVE','PROVIDER_ALLOCATION','DOCUMENT','EMAIL',
      'CRM_CONTEXT','FOUNDER_CLAIM','DERIVED_ASSERTION'
    ))
);
create index provider_objects_connection_idx
  on public.provider_objects(user_id, connection_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- 5. Provider-object links. Browser is read-only in phase 1; later confirmation
-- uses an explicit RPC rather than table UPDATE grants.
-- ---------------------------------------------------------------------------
create table public.provider_object_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_object_id uuid not null,
  entity_type text not null,
  entity_id uuid not null,
  match_basis text not null,
  confirmed_by uuid references auth.users(id) on delete restrict,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, provider_object_id, entity_type, entity_id),
  constraint provider_object_links_object_fk
    foreign key (user_id, provider_object_id)
    references public.provider_objects(user_id, id)
    on delete cascade,
  constraint provider_object_links_confirmation_check
    check ((confirmed_by is null and confirmed_at is null) or
           (confirmed_by is not null and confirmed_at is not null)),
  constraint provider_object_links_entity_type_check
    check (entity_type in ('invoice','client','payment','email','document','crm_account','crm_contact')),
  constraint provider_object_links_match_basis_check
    check (match_basis in ('metadata','stored_id','exact_email','exact_number','confirmed','proposal'))
);
create index provider_object_links_entity_idx
  on public.provider_object_links(user_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- 6. Sync state. Completeness/freshness is explicit and browser-readable.
-- ---------------------------------------------------------------------------
create table public.provider_sync_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  resource text not null,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_complete_cursor text,
  last_error_category text,
  unique (user_id, id),
  unique (user_id, connection_id, resource),
  constraint provider_sync_state_connection_fk
    foreign key (user_id, connection_id)
    references public.provider_connections(user_id, id)
    on delete cascade,
  constraint provider_sync_state_resource_check
    check (length(btrim(resource)) between 1 and 80),
  constraint provider_sync_state_error_check
    check (last_error_category is null or last_error_category in (
      'AUTH','RATE_LIMIT','UNAVAILABLE','SCHEMA','UNKNOWN'
    ))
);

-- ---------------------------------------------------------------------------
-- 7. Reconciliation exceptions replace guessing.
-- ---------------------------------------------------------------------------
create table public.provider_reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_object_id uuid,
  reason text not null,
  candidates jsonb not null default '[]'::jsonb,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete restrict,
  unique (user_id, id),
  constraint provider_reconciliation_exceptions_object_fk
    foreign key (user_id, provider_object_id)
    references public.provider_objects(user_id, id)
    on delete restrict,
  constraint provider_reconciliation_exceptions_resolution_check
    check ((resolved_at is null and resolved_by is null) or
           (resolved_at is not null and resolved_by is not null)),
  constraint provider_reconciliation_exceptions_candidates_check
    check (jsonb_typeof(candidates) = 'array'),
  constraint provider_reconciliation_exceptions_reason_check
    check (length(btrim(reason)) between 1 and 120)
);
create index provider_reconciliation_exceptions_open_idx
  on public.provider_reconciliation_exceptions(user_id, opened_at desc)
  where resolved_at is null;

-- ---------------------------------------------------------------------------
-- RLS and grants.
-- ---------------------------------------------------------------------------
alter table public.provider_connections enable row level security;
alter table public.provider_oauth_states enable row level security;
alter table public.provider_webhook_events enable row level security;
alter table public.provider_objects enable row level security;
alter table public.provider_object_links enable row level security;
alter table public.provider_sync_state enable row level security;
alter table public.provider_reconciliation_exceptions enable row level security;

revoke all on table
  public.provider_connections,
  public.provider_oauth_states,
  public.provider_webhook_events,
  public.provider_objects,
  public.provider_object_links,
  public.provider_sync_state,
  public.provider_reconciliation_exceptions
from public, anon, authenticated;

grant all on table
  public.provider_connections,
  public.provider_oauth_states,
  public.provider_webhook_events,
  public.provider_objects,
  public.provider_object_links,
  public.provider_sync_state,
  public.provider_reconciliation_exceptions
to service_role;

grant select on table
  public.provider_objects,
  public.provider_object_links,
  public.provider_sync_state,
  public.provider_reconciliation_exceptions
to authenticated;

create policy provider_objects_select_own
  on public.provider_objects for select to authenticated
  using (user_id = (select auth.uid()));

create policy provider_object_links_select_own
  on public.provider_object_links for select to authenticated
  using (user_id = (select auth.uid()));

create policy provider_sync_state_select_own
  on public.provider_sync_state for select to authenticated
  using (user_id = (select auth.uid()));

create policy provider_reconciliation_exceptions_select_own
  on public.provider_reconciliation_exceptions for select to authenticated
  using (user_id = (select auth.uid()));

-- Safe browser view. Phase 1 deliberately never claims "current": before sync
-- semantics ship, a connected row is either never_synced or stale.
drop view if exists public.provider_connection_status;
create view public.provider_connection_status
with (security_barrier = true)
as
select
  c.id,
  c.user_id,
  c.provider,
  c.provider_account_id,
  c.environment,
  c.granted_scopes,
  c.connected_at,
  c.disconnected_at,
  c.status as stored_status,
  max(s.last_attempt_at) as last_attempt_at,
  max(s.last_success_at) as last_success_at,
  case
    when c.status = 'needs_reconnect' then 'needs_reconnect'
    when c.status = 'disconnected' then 'disconnected'
    when c.status = 'unavailable' then 'unavailable'
    when max(s.last_success_at) is null then 'never_synced'
    else 'stale'
  end as derived_status
from public.provider_connections c
left join public.provider_sync_state s
  on s.user_id = c.user_id and s.connection_id = c.id
where c.user_id = (select auth.uid())
group by
  c.id, c.user_id, c.provider, c.provider_account_id, c.environment,
  c.granted_scopes, c.connected_at, c.disconnected_at, c.status;

revoke all on public.provider_connection_status from public, anon, authenticated;
grant select on public.provider_connection_status to authenticated;

-- ---------------------------------------------------------------------------
-- Shared tenant-explicit payment body.
-- The old auth.uid()-bound unkeyed function is retired. Both browser and
-- service-role entry points now share one keyed/idempotent implementation.
-- Provider reconciliation must not invoke this until Phase 6 establishes
-- provider-origin provenance; Phase 1 only creates and proves the boundary.
-- ---------------------------------------------------------------------------
drop function if exists duewatch_ops.record_payment_unkeyed_internal(
  date, numeric, text, jsonb, text, text
);

drop function if exists duewatch_ops.record_payment_unkeyed_for_tenant_internal(
  uuid, date, numeric, text, jsonb, text, text
);
create function duewatch_ops.record_payment_unkeyed_for_tenant_internal(
  p_user_id uuid,
  p_payment_date date,
  p_total_amount numeric,
  p_currency text,
  p_allocations jsonb,
  p_method text default null,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, duewatch_ops, pg_temp
as $$
declare
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
  if p_user_id is null then raise exception 'PAYMENT_TENANT_REQUIRED'; end if;
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
    if v_invoice.user_id <> p_user_id then raise exception 'Invoice does not belong to payment tenant'; end if;
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
      update public.invoices set currency = p_currency where id = v_invoice.id;
      v_invoice.currency := p_currency;
    elsif v_invoice.currency <> p_currency then
      raise exception 'Payment and invoice currencies must match exactly';
    end if;
  end loop;

  if not found or v_count <> (
    select count(*) from public.invoices i
    where i.id in (
      select (value->>'invoice_id')::uuid from jsonb_array_elements(p_allocations)
    )
  ) then raise exception 'One or more invoices do not exist'; end if;

  insert into public.payments(
    user_id, recorded_by, payment_date, total_amount, currency, method, note, origin
  ) values (
    p_user_id, p_user_id, p_payment_date, p_total_amount, p_currency,
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
      p_user_id, 'payment_recorded', v_invoice_id,
      jsonb_build_object(
        'payment_id', v_payment_id, 'allocation_id', v_allocation_id,
        'amount', v_amount, 'currency', p_currency,
        'payment_date', p_payment_date, 'origin', 'founder_manual'
      )
    );

    if not v_was_paid and v_now_paid then
      insert into public.events(user_id, event_type, invoice_id, evidence)
      values (
        p_user_id, 'invoice_marked_paid', v_invoice_id,
        jsonb_build_object('payment_id', v_payment_id, 'allocation_id', v_allocation_id)
      );
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'allocation_id', v_allocation_id,
      'invoice_id', v_invoice_id,
      'amount', v_amount,
      'invoice_currency', (select currency from public.invoices where id = v_invoice_id),
      'invoice_amount_paid', (select amount_paid from public.invoices where id = v_invoice_id),
      'invoice_paid', v_now_paid
    ));
  end loop;

  return jsonb_build_object('payment_id', v_payment_id, 'allocations', v_results);
end;
$$;

revoke all on function duewatch_ops.record_payment_unkeyed_for_tenant_internal(
  uuid, date, numeric, text, jsonb, text, text
) from public, anon, authenticated, service_role;

drop function if exists duewatch_ops.record_payment_for_tenant(
  uuid, date, numeric, text, jsonb, text, text, text
);
create function duewatch_ops.record_payment_for_tenant(
  p_user_id uuid,
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
  v_operation_key text := btrim(coalesce(p_operation_key, ''));
  v_request jsonb;
  v_allocations jsonb;
  v_existing_request jsonb;
  v_existing_result jsonb;
  v_result jsonb;
  v_payment_id uuid;
begin
  if p_user_id is null then raise exception 'PAYMENT_TENANT_REQUIRED'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'PAYMENT_TENANT_NOT_FOUND';
  end if;
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

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_operation_key, 0)
  );

  select operation_request, operation_result
  into v_existing_request, v_existing_result
  from public.payments
  where user_id = p_user_id
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

  v_result := duewatch_ops.record_payment_unkeyed_for_tenant_internal(
    p_user_id,
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
    and user_id = p_user_id
    and operation_key is null;

  if not found then
    raise exception 'PAYMENT_OPERATION_RECEIPT_WRITE_FAILED';
  end if;

  return v_result;
end;
$$;

revoke all on function duewatch_ops.record_payment_for_tenant(
  uuid, date, numeric, text, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function duewatch_ops.record_payment_for_tenant(
  uuid, date, numeric, text, jsonb, text, text, text
) to service_role;

drop function if exists public.record_payment(
  date, numeric, text, jsonb, text, text, text
);
create function public.record_payment(
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
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  return duewatch_ops.record_payment_for_tenant(
    v_user_id,
    p_payment_date,
    p_total_amount,
    p_currency,
    p_allocations,
    p_operation_key,
    p_method,
    p_note
  );
end;
$$;

revoke all on function public.record_payment(
  date, numeric, text, jsonb, text, text, text
) from public, anon;
grant execute on function public.record_payment(
  date, numeric, text, jsonb, text, text, text
) to authenticated;

commit;
