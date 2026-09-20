-- DueWatch full-app security hardening.
-- Scope: privilege minimization, RLS drift cleanup, server-side rate limiting,
-- external-action execution receipts, and function search_path hardening.

create schema if not exists duewatch_security;
revoke all on schema duewatch_security from public, anon, authenticated;
grant usage on schema duewatch_security to service_role;

-- ---------------------------------------------------------------------
-- Server-side fixed-window rate limits. This schema is intentionally not
-- exposed through the Data API. Only service_role can execute the wrapper.
-- ---------------------------------------------------------------------
create table if not exists duewatch_security.rate_limit_buckets (
  subject_id uuid not null,
  scope text not null,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (subject_id, scope)
);

revoke all on duewatch_security.rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on duewatch_security.rate_limit_buckets to service_role;

create or replace function public.consume_request_rate_limit(
  p_user_id uuid,
  p_scope text,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz default now()
) returns table(
  allowed boolean,
  remaining integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, duewatch_security, public, pg_temp
as $$
declare
  v_bucket duewatch_security.rate_limit_buckets%rowtype;
  v_reset timestamptz;
begin
  if p_user_id is null then
    raise exception 'RATE_LIMIT_USER_REQUIRED';
  end if;
  if p_scope is null or btrim(p_scope) = '' or length(p_scope) > 120 then
    raise exception 'RATE_LIMIT_SCOPE_INVALID';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'RATE_LIMIT_LIMIT_INVALID';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 2678400 then
    raise exception 'RATE_LIMIT_WINDOW_INVALID';
  end if;

  select * into v_bucket
  from duewatch_security.rate_limit_buckets
  where subject_id = p_user_id and scope = p_scope
  for update;

  if not found then
    insert into duewatch_security.rate_limit_buckets(
      subject_id, scope, window_started_at, request_count, updated_at
    ) values (
      p_user_id, p_scope, p_now, 1, p_now
    )
    returning * into v_bucket;

    return query
      select true, greatest(p_limit - 1, 0), p_now + make_interval(secs => p_window_seconds);
    return;
  end if;

  v_reset := v_bucket.window_started_at + make_interval(secs => p_window_seconds);

  if p_now >= v_reset then
    update duewatch_security.rate_limit_buckets
    set window_started_at = p_now,
        request_count = 1,
        updated_at = p_now
    where subject_id = p_user_id and scope = p_scope;

    return query
      select true, greatest(p_limit - 1, 0), p_now + make_interval(secs => p_window_seconds);
    return;
  end if;

  if v_bucket.request_count >= p_limit then
    return query select false, 0, v_reset;
    return;
  end if;

  update duewatch_security.rate_limit_buckets
  set request_count = request_count + 1,
      updated_at = p_now
  where subject_id = p_user_id and scope = p_scope
  returning * into v_bucket;

  return query
    select true, greatest(p_limit - v_bucket.request_count, 0), v_reset;
end;
$$;

revoke all on function public.consume_request_rate_limit(uuid, text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_request_rate_limit(uuid, text, integer, integer, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------
-- Generic canonical receipt for non-Autopilot external side effects.
-- Autopilot keeps using its stricter rule-scoped execution-claim ledger.
-- ---------------------------------------------------------------------
create unique index if not exists invoices_user_id_id_uidx
  on public.invoices(user_id, id);

create table if not exists public.external_action_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid,
  action_type text not null,
  idempotency_key text not null,
  message_hash text,
  status text not null default 'in_flight'
    check (status in ('in_flight','sent','send_failed','uncertain')),
  provider text,
  provider_message_id text,
  evidence jsonb not null default '{}'::jsonb,
  claimed_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (user_id, action_type, idempotency_key),
  unique (user_id, id),
  foreign key (user_id, invoice_id)
    references public.invoices(user_id, id)
    on delete restrict
);

create index if not exists external_action_claims_user_created_idx
  on public.external_action_claims(user_id, claimed_at desc);
create index if not exists external_action_claims_invoice_idx
  on public.external_action_claims(user_id, invoice_id, claimed_at desc);

alter table public.external_action_claims enable row level security;

drop policy if exists external_action_claims_select_own on public.external_action_claims;
create policy external_action_claims_select_own
  on public.external_action_claims
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.external_action_claims from public, anon, authenticated, service_role;
grant select on public.external_action_claims to authenticated, service_role;

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

  -- If the same exact message previously ended in an uncertain state,
  -- do not silently create a fresh attempt under a new time bucket.
  if p_message_hash is not null and exists (
    select 1
    from public.external_action_claims
    where user_id = p_user_id
      and invoice_id = p_invoice_id
      and action_type = p_action_type
      and message_hash = p_message_hash
      and status = 'uncertain'
  ) then
    select id, status into v_id, v_status
    from public.external_action_claims
    where user_id = p_user_id
      and invoice_id = p_invoice_id
      and action_type = p_action_type
      and message_hash = p_message_hash
      and status = 'uncertain'
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

  select id, status into v_id, v_status
  from public.external_action_claims
  where user_id = p_user_id
    and action_type = p_action_type
    and idempotency_key = p_idempotency_key;

  return query select v_id, false, v_status;
end;
$$;

create or replace function public.resolve_external_action_claim(
  p_claim_id uuid,
  p_status text,
  p_provider text default null,
  p_provider_message_id text default null,
  p_evidence jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_claim_id is null then raise exception 'EXTERNAL_ACTION_CLAIM_REQUIRED'; end if;
  if p_status not in ('sent','send_failed','uncertain') then
    raise exception 'EXTERNAL_ACTION_STATUS_INVALID';
  end if;

  update public.external_action_claims
  set status = p_status,
      provider = coalesce(p_provider, provider),
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      evidence = coalesce(evidence, '{}'::jsonb) || coalesce(p_evidence, '{}'::jsonb),
      resolved_at = now()
  where id = p_claim_id and status = 'in_flight';

  if not found then
    raise exception 'EXTERNAL_ACTION_CLAIM_NOT_IN_FLIGHT';
  end if;
end;
$$;

revoke all on function public.acquire_external_action_claim(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.resolve_external_action_claim(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.acquire_external_action_claim(uuid, uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.resolve_external_action_claim(uuid, text, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------
-- Function exposure/search_path hardening.
-- ---------------------------------------------------------------------
alter function public.normalize_client_text(text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.normalize_client_email(text)
  set search_path = pg_catalog, public, pg_temp;
alter function public.normalize_client_phone(text)
  set search_path = pg_catalog, public, pg_temp;

revoke all on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;

-- ---------------------------------------------------------------------
-- Remove anonymous table access from application tables and dangerous
-- table-level privileges from authenticated users. RLS is defense-in-depth,
-- not the only boundary.
-- ---------------------------------------------------------------------
do $privileges$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles','clients','invoices','line_items','reminders','events',
    'awaiting_signature','autopilot_runs','autopilot_settings','autopilot_rules',
    'client_source_identities','client_dedup_runs','client_merge_candidates',
    'client_merge_audit','import_runs','import_batches','import_rows','import_events',
    'autopilot_execution_claims','payments','payment_allocations',
    'dw_intelligence_runs','dw_evidence_items','dw_memory_claims',
    'dw_memory_evidence_links','dw_memory_tombstones','dw_tombstone_evidence_links',
    'dw_proof_events','ask_dw_conversations','report_saved_views',
    'report_collection_targets','report_schedules','report_delivery_runs',
    'external_action_claims'
  ]
  loop
    if to_regclass('public.' || v_table) is not null then
      execute format('revoke all privileges on table public.%I from anon', v_table);
      execute format('revoke truncate, references, trigger on table public.%I from authenticated', v_table);
    end if;
  end loop;
end
$privileges$;

-- Preserve browser capabilities the app intentionally needs.
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.invoices to authenticated;
grant select, insert, update, delete on public.line_items to authenticated;
grant select, insert, update, delete on public.reminders to authenticated;
grant select, insert, update, delete on public.events to authenticated;
grant select, insert, update, delete on public.awaiting_signature to authenticated;
grant select, insert, update, delete on public.autopilot_runs to authenticated;
grant select, insert, update, delete on public.autopilot_settings to authenticated;
grant select, insert, update, delete on public.autopilot_rules to authenticated;

-- ---------------------------------------------------------------------
-- Remove duplicate legacy RLS policies and recreate core policies with
-- explicit authenticated role + init-plan-friendly auth.uid() usage.
-- ---------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists clients_all on public.clients;
drop policy if exists clients_all_own on public.clients;
create policy clients_all_own on public.clients
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists invoices_all on public.invoices;
drop policy if exists invoices_all_own on public.invoices;
create policy invoices_all_own on public.invoices
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists line_items_all on public.line_items;
drop policy if exists line_items_all_own on public.line_items;
create policy line_items_all_own on public.line_items
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists reminders_all_own on public.reminders;
create policy reminders_all_own on public.reminders
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists events_all_own on public.events;
create policy events_all_own on public.events
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists awaiting_signature_own on public.awaiting_signature;
create policy awaiting_signature_own on public.awaiting_signature
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists autopilot_runs_own on public.autopilot_runs;
create policy autopilot_runs_own on public.autopilot_runs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

do $optional_core_policies$
begin
  if to_regclass('public.autopilot_settings') is not null then
    execute 'drop policy if exists autopilot_settings_own on public.autopilot_settings';
    execute 'create policy autopilot_settings_own on public.autopilot_settings for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
  end if;
  if to_regclass('public.autopilot_rules') is not null then
    execute 'drop policy if exists autopilot_rules_own on public.autopilot_rules';
    execute 'create policy autopilot_rules_own on public.autopilot_rules for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
  end if;
  if to_regclass('public.autopilot_execution_claims') is not null then
    execute 'drop policy if exists autopilot_execution_claims_select_own on public.autopilot_execution_claims';
    execute 'create policy autopilot_execution_claims_select_own on public.autopilot_execution_claims for select to authenticated using ((select auth.uid()) = user_id)';
  end if;
end
$optional_core_policies$;

-- Postconditions that must fail the migration if the security boundary
-- is not actually in the expected state.
do $postconditions$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles','clients','invoices','line_items','reminders','events',
    'awaiting_signature','autopilot_runs','autopilot_settings','autopilot_rules',
    'import_runs','import_rows','import_events','payments','payment_allocations',
    'ask_dw_conversations','external_action_claims'
  ]
  loop
    if to_regclass('public.' || v_table) is not null and exists (
      select 1
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = v_table
        and grantee = 'anon'
    ) then
      raise exception 'anon retained table privileges on %', v_table;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE') then
    raise exception 'handle_new_user remained directly executable';
  end if;

  if has_function_privilege('authenticated',
       'public.consume_request_rate_limit(uuid,text,integer,integer,timestamptz)',
       'EXECUTE') then
    raise exception 'authenticated can execute server-only rate limiter';
  end if;

  if has_function_privilege('authenticated',
       'public.acquire_external_action_claim(uuid,uuid,text,text,text,jsonb)',
       'EXECUTE') then
    raise exception 'authenticated can acquire server-only external action claims';
  end if;
end
$postconditions$;
