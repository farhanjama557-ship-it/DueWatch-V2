-- Ask DW M2C — durable reference/workflow conversation state.
--
-- Stores only the governed M1D case-state envelope. It is not a transcript
-- store, financial ledger, authority snapshot, or execution queue.

begin;

create schema if not exists duewatch_ops;

create table if not exists public.ask_dw_conversations (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id text not null,
  schema_version text not null check (schema_version = 'ASK_DW_CASE_STATE_V0'),
  state_version integer not null check (state_version >= 0),
  status text not null check (status in ('ACTIVE', 'EXPIRED')),
  state jsonb not null,
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, conversation_id),
  constraint ask_dw_conversations_conversation_id_check
    check (length(btrim(conversation_id)) between 1 and 200),
  constraint ask_dw_conversations_state_object_check
    check (jsonb_typeof(state) = 'object')
);

create index if not exists ask_dw_conversations_user_updated_idx
  on public.ask_dw_conversations(user_id, updated_at desc);

create or replace function duewatch_ops.assert_ask_dw_case_state_safe(
  p_value jsonb,
  p_path text default 'state'
) returns void
language plpgsql
security invoker
set search_path = pg_catalog, public, duewatch_ops, pg_temp
as $$
declare
  v_key text;
  v_nested jsonb;
  v_index integer := 0;
  v_forbidden text[] := array[
    'amount','amount_paid','balance','paid','currency','due_date','inv_date',
    'invoice_date','canonicalfacts','canonical_facts','rawtoolresponse',
    'raw_tool_response','tooloutput','tool_output','authority',
    'authoritysnapshot','authority_snapshot','authorized',
    'canactautomatically','permissions',
    'financialexecutionauthorized','financial_execution_authorized',
    'canonicalmutationauthorized','canonical_mutation_authorized',
    'writesperformed','writes_performed',
    'executionauthority','execution_authority',
    'businessauthority','business_authority',
    'authorityactual','authority_actual',
    'authoritygranted','authority_granted',
    'canexecute','can_execute','canwrite','can_write',
    'cansend','can_send','sendauthorized','send_authorized',
    'mutationauthorized','mutation_authorized'
  ];
begin
  if p_value is null then
    return;
  end if;

  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_nested in select key, value from jsonb_each(p_value)
    loop
      if lower(v_key) = any(v_forbidden) then
        raise exception using
          errcode = '22023',
          message = 'ASK_DW_FORBIDDEN_DURABLE_KEY',
          detail = p_path || '.' || v_key;
      end if;

      -- M1D action records deliberately carry executionAuthorized:false.
      -- False is a guard; any other persisted value is rejected.
      if lower(v_key) = 'executionauthorized' and v_nested <> 'false'::jsonb then
        raise exception using
          errcode = '22023',
          message = 'ASK_DW_EXECUTION_AUTHORITY_NOT_PERSISTABLE',
          detail = p_path || '.' || v_key;
      end if;

      perform duewatch_ops.assert_ask_dw_case_state_safe(
        v_nested,
        p_path || '.' || v_key
      );
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_nested in select value from jsonb_array_elements(p_value)
    loop
      perform duewatch_ops.assert_ask_dw_case_state_safe(
        v_nested,
        p_path || '[' || v_index::text || ']'
      );
      v_index := v_index + 1;
    end loop;
  end if;
end
$$;

revoke execute on function duewatch_ops.assert_ask_dw_case_state_safe(jsonb, text)
  from public, anon, authenticated, service_role;

alter table public.ask_dw_conversations enable row level security;

drop policy if exists "ask_dw_conversations_select_own"
  on public.ask_dw_conversations;
create policy "ask_dw_conversations_select_own"
  on public.ask_dw_conversations
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

-- Do not depend on hosted Supabase default ACLs.
revoke all privileges on public.ask_dw_conversations
  from PUBLIC, anon, authenticated, service_role;
grant select on public.ask_dw_conversations to authenticated;
grant select on public.ask_dw_conversations to service_role;

create or replace function public.persist_ask_dw_conversation_state(
  p_conversation_id text,
  p_expected_version integer,
  p_state jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, duewatch_ops, pg_temp
as $$
declare
  v_user_id uuid;
  v_state_version_numeric numeric;
  v_state_version integer;
  v_status text;
  v_expires_at timestamptz;
  v_current public.ask_dw_conversations%rowtype;
  v_inserted boolean := false;
  v_persisted_at timestamptz;
begin
  v_user_id := (select auth.uid());

  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'ASK_DW_AUTHENTICATION_REQUIRED';
  end if;

  if p_conversation_id is null
     or length(btrim(p_conversation_id)) < 1
     or length(btrim(p_conversation_id)) > 200 then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CONVERSATION_ID_INVALID';
  end if;

  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_OBJECT_REQUIRED';
  end if;

  if octet_length(convert_to(p_state::text, 'UTF8')) > 262144 then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_TOO_LARGE';
  end if;

  perform duewatch_ops.assert_ask_dw_case_state_safe(p_state, 'state');

  if p_state->>'schemaVersion' <> 'ASK_DW_CASE_STATE_V0' then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_SCHEMA_UNSUPPORTED';
  end if;

  if p_state->>'tenantId' <> v_user_id::text then
    raise exception using
      errcode = '42501',
      message = 'ASK_DW_CASE_STATE_TENANT_MISMATCH';
  end if;

  if p_state->>'conversationId' <> btrim(p_conversation_id) then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_CONVERSATION_MISMATCH';
  end if;

  if jsonb_typeof(p_state->'version') <> 'number' then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_VERSION_INVALID';
  end if;

  begin
    v_state_version_numeric := (p_state->>'version')::numeric;
  exception when others then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_VERSION_INVALID';
  end;

  if v_state_version_numeric < 0
     or v_state_version_numeric > 2147483647
     or v_state_version_numeric <> trunc(v_state_version_numeric) then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_VERSION_INVALID';
  end if;
  v_state_version := v_state_version_numeric::integer;

  v_status := p_state->>'status';
  if v_status not in ('ACTIVE', 'EXPIRED') then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_STATUS_INVALID';
  end if;

  if jsonb_typeof(p_state->'cases') <> 'object'
     or coalesce(p_state->>'activeCaseId', '') = ''
     or not ((p_state->'cases') ? (p_state->>'activeCaseId')) then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_ACTIVE_CASE_INVALID';
  end if;

  if p_state #>> '{boundaries,canonicalFinancialTruthStored}' is distinct from 'false'
     or p_state #>> '{boundaries,rawToolOutputsStored}' is distinct from 'false'
     or p_state #>> '{boundaries,businessAuthorityStored}' is distinct from 'false'
     or p_state #>> '{boundaries,confirmationNeverEqualsExecution}' is distinct from 'true'
     or p_state #>> '{boundaries,freshStateRequiredBeforeExecution}' is distinct from 'true'
     or p_state #>> '{boundaries,authorityRecheckRequiredBeforeExecution}' is distinct from 'true' then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_BOUNDARY_INVALID';
  end if;

  if nullif(btrim(coalesce(p_state->>'createdAt', '')), '') is null
     or nullif(btrim(coalesce(p_state->>'updatedAt', '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_TIMESTAMP_REQUIRED';
  end if;

  begin
    perform (p_state->>'createdAt')::timestamptz;
    perform (p_state->>'updatedAt')::timestamptz;
    if p_state->>'expiresAt' is not null then
      v_expires_at := (p_state->>'expiresAt')::timestamptz;
    else
      v_expires_at := null;
    end if;
  exception when others then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_TIMESTAMP_INVALID';
  end;

  if p_expected_version is null then
    insert into public.ask_dw_conversations(
      user_id, conversation_id, schema_version, state_version,
      status, state, expires_at
    ) values (
      v_user_id, btrim(p_conversation_id), 'ASK_DW_CASE_STATE_V0',
      v_state_version, v_status, p_state, v_expires_at
    )
    on conflict (user_id, conversation_id) do nothing
    returning true, updated_at into v_inserted, v_persisted_at;

    if v_inserted then
      return jsonb_build_object(
        'conversation_id', btrim(p_conversation_id),
        'state_version', v_state_version,
        'outcome', 'CREATED',
        'idempotent_replay', false,
        'persisted_at', v_persisted_at
      );
    end if;

    select * into v_current
    from public.ask_dw_conversations
    where user_id = v_user_id
      and conversation_id = btrim(p_conversation_id)
    for update;

    if found
       and v_current.state_version = v_state_version
       and v_current.state = p_state then
      return jsonb_build_object(
        'conversation_id', btrim(p_conversation_id),
        'state_version', v_current.state_version,
        'outcome', 'IDEMPOTENT_REPLAY',
        'idempotent_replay', true,
        'persisted_at', v_current.updated_at
      );
    end if;

    raise exception using
      errcode = '40001',
      message = 'ASK_DW_CONVERSATION_ALREADY_EXISTS';
  end if;

  if p_expected_version < 0 then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_EXPECTED_VERSION_INVALID';
  end if;

  select * into v_current
  from public.ask_dw_conversations
  where user_id = v_user_id
    and conversation_id = btrim(p_conversation_id)
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'ASK_DW_CONVERSATION_NOT_FOUND';
  end if;

  -- Exact retry after a successful commit is idempotent, even if the
  -- conversation crossed its TTL after that commit.
  if v_current.state_version = v_state_version
     and v_current.state = p_state then
    return jsonb_build_object(
      'conversation_id', btrim(p_conversation_id),
      'state_version', v_current.state_version,
      'outcome', 'IDEMPOTENT_REPLAY',
      'idempotent_replay', true,
      'persisted_at', v_current.updated_at
    );
  end if;

  if v_current.status = 'EXPIRED'
     or (v_current.expires_at is not null and v_current.expires_at <= clock_timestamp()) then
    raise exception using
      errcode = 'P0001',
      message = 'ASK_DW_CONVERSATION_EXPIRED';
  end if;

  if v_expires_at is distinct from v_current.expires_at then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CONVERSATION_EXPIRY_CHANGED';
  end if;

  if p_state->>'createdAt' is distinct from v_current.state->>'createdAt' then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CONVERSATION_CREATED_AT_CHANGED';
  end if;

  if v_current.state_version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = 'ASK_DW_CONVERSATION_STALE';
  end if;

  if v_state_version <= p_expected_version then
    raise exception using
      errcode = '22023',
      message = 'ASK_DW_CASE_STATE_VERSION_NOT_ADVANCED';
  end if;

  update public.ask_dw_conversations
  set schema_version = 'ASK_DW_CASE_STATE_V0',
      state_version = v_state_version,
      status = v_status,
      state = p_state,
      expires_at = v_expires_at,
      updated_at = clock_timestamp()
  where user_id = v_user_id
    and conversation_id = btrim(p_conversation_id)
  returning updated_at into v_persisted_at;

  return jsonb_build_object(
    'conversation_id', btrim(p_conversation_id),
    'state_version', v_state_version,
    'outcome', 'UPDATED',
    'idempotent_replay', false,
    'persisted_at', v_persisted_at
  );
end
$$;

revoke execute on function public.persist_ask_dw_conversation_state(text, integer, jsonb)
  from public, anon, service_role;
grant execute on function public.persist_ask_dw_conversation_state(text, integer, jsonb)
  to authenticated;

commit;
