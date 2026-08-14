-- Third execution-safety review-fix pass, HIGH: the durable execution claim
-- row itself must BE the canonical execution receipt — carrying enough
-- provenance to answer "what did Duewatch decide, and why" — and that
-- provenance must exist BEFORE the external provider request is made, not
-- only after resolution. Checking a later Activity/events write's error is
-- not enough: if that write fails after a successful send, founder-facing
-- Evidence could disappear while the canonical receipt (this table) still
-- silently existed with none of that context in it.
--
-- This does NOT attempt to make the provider call and a Postgres write one
-- transaction (impossible: Resend is an external HTTP call). It instead
-- moves receipt-writing earlier: acquire_autopilot_execution_claim now
-- accepts the full canonical receipt (rule snapshot, ruleSnapshotHash,
-- factual basis, authorization evaluatedAt — user_id/invoice_id/rule_id/
-- action_type/idempotency_key/claimed_at were already real columns) and
-- persists it into `evidence` at INSERT time, before any send is attempted.
--
-- A new resolve_autopilot_execution_claim function replaces the raw
-- service_role UPDATE grant this table previously had: resolution now
-- jsonb-MERGES its evidence (provider_message_id / error) into the SAME
-- object rather than overwriting it, so the pre-send receipt is never
-- clobbered by the post-send write. This also narrows privileges: the
-- table's direct UPDATE grant to service_role is revoked, since every
-- resolution now goes exclusively through this SECURITY DEFINER function —
-- the same "inserts only via the function" discipline the original
-- migration already applied to INSERT.

drop function if exists public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text);
create or replace function public.acquire_autopilot_execution_claim(
  p_user_id uuid,
  p_invoice_id uuid,
  p_rule_id uuid,
  p_action_type text,
  p_idempotency_key text,
  -- Defaulted (not required) so the pre-existing 5-argument SQL test suite
  -- (supabase/tests/autopilot_execution_claims_test.sql) keeps working
  -- unmodified — both real callers (autopilot-scheduler,
  -- send-reminder-email) always pass this explicitly.
  p_receipt jsonb default '{}'::jsonb
) returns table(claim_id uuid, acquired boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim_id uuid;
begin
  if p_user_id is null or p_invoice_id is null or p_rule_id is null
     or p_action_type is null or trim(p_action_type) = ''
     or p_idempotency_key is null or trim(p_idempotency_key) = '' then
    raise exception 'acquire_autopilot_execution_claim requires user_id, invoice_id, rule_id, action_type, and idempotency_key';
  end if;

  -- Malformed/mismatched tenant identity fails closed: the invoice must
  -- actually belong to the claiming user. This is a trusted service-role
  -- caller, so this is defense-in-depth against a caller bug, not an
  -- external security boundary — but Phase 2A.1's own doctrine is that
  -- tenant ownership is structurally checked, never assumed from inputs.
  if not exists (
    select 1 from public.invoices where id = p_invoice_id and user_id = p_user_id
  ) then
    raise exception 'invoice % does not belong to user %', p_invoice_id, p_user_id;
  end if;

  -- The atomic core: two concurrent callers with the same identity
  -- serialize on this unique index. Exactly one INSERT wins; the loser's
  -- INSERT resolves to zero rows affected (ON CONFLICT DO NOTHING) rather
  -- than erroring, and falls through to the SELECT below to observe the
  -- winner's row deterministically once its transaction commits. The
  -- receipt is written in this SAME insert — before any send is attempted
  -- by either the winner or any loser.
  insert into public.autopilot_execution_claims (
    id, user_id, invoice_id, rule_id, action_type, idempotency_key, status, evidence, claimed_at
  ) values (
    gen_random_uuid(), p_user_id, p_invoice_id, p_rule_id, p_action_type, p_idempotency_key,
    'in_flight', coalesce(p_receipt, '{}'::jsonb), now()
  )
  on conflict (user_id, invoice_id, rule_id, action_type) do nothing
  returning id into v_claim_id;

  if v_claim_id is not null then
    return query select v_claim_id, true;
    return;
  end if;

  -- Did not win. A claim already exists for this identity — regardless of
  -- its current status (in_flight/sent/send_failed/uncertain), its mere
  -- existence is what blocks a second automatic attempt. This is the
  -- fail-closed behavior: an incomplete or uncertain prior execution is
  -- never treated as license to retry automatically.
  select id into v_claim_id
  from public.autopilot_execution_claims
  where user_id = p_user_id and invoice_id = p_invoice_id
    and rule_id = p_rule_id and action_type = p_action_type;

  return query select v_claim_id, false;
end;
$$;

revoke all on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb) from PUBLIC, anon, authenticated;
grant execute on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb) to service_role;

-- Resolution must MERGE into the existing evidence, never overwrite it —
-- the pre-send receipt (rule snapshot, factual basis, authorization) must
-- survive resolution; only the resolution-time facts (provider_message_id,
-- error text) are new information being added on top of it.
create or replace function public.resolve_autopilot_execution_claim(
  p_claim_id uuid,
  p_status text,
  p_provider_message_id text,
  p_evidence jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_claim_id is null or p_status is null then
    raise exception 'resolve_autopilot_execution_claim requires claim_id and status';
  end if;
  if p_status not in ('sent', 'send_failed', 'uncertain') then
    raise exception 'resolve_autopilot_execution_claim: invalid status %', p_status;
  end if;

  update public.autopilot_execution_claims
  set status = p_status,
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      evidence = coalesce(evidence, '{}'::jsonb) || coalesce(p_evidence, '{}'::jsonb),
      resolved_at = now()
  where id = p_claim_id;

  if not found then
    raise exception 'resolve_autopilot_execution_claim: no claim % found', p_claim_id;
  end if;
end;
$$;

revoke all on function public.resolve_autopilot_execution_claim(uuid, text, text, jsonb) from PUBLIC, anon, authenticated;
grant execute on function public.resolve_autopilot_execution_claim(uuid, text, text, jsonb) to service_role;

-- ---- privilege tightening: resolution no longer needs a raw table UPDATE
-- grant now that resolve_autopilot_execution_claim exists (SECURITY
-- DEFINER, executes as the function owner). Narrowing only — service_role
-- never had INSERT/DELETE here, and now loses direct UPDATE too.
revoke update on public.autopilot_execution_claims from service_role;

-- ---- privilege postconditions ----
do $post$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'autopilot_execution_claims'
      and grantee in ('PUBLIC', 'anon')
  ) then
    raise exception 'PUBLIC or anon retained a privilege on autopilot_execution_claims';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'autopilot_execution_claims'
      and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) then
    raise exception 'authenticated retained a non-SELECT privilege on autopilot_execution_claims';
  end if;

  if has_table_privilege('service_role', 'public.autopilot_execution_claims', 'INSERT')
     or has_table_privilege('service_role', 'public.autopilot_execution_claims', 'DELETE')
     or has_table_privilege('service_role', 'public.autopilot_execution_claims', 'UPDATE') then
    raise exception 'service_role retained INSERT, DELETE, or direct UPDATE on autopilot_execution_claims (writes must go through acquire_autopilot_execution_claim / resolve_autopilot_execution_claim only)';
  end if;

  if not has_table_privilege('service_role', 'public.autopilot_execution_claims', 'SELECT') then
    raise exception 'service_role is missing SELECT on autopilot_execution_claims';
  end if;

  if has_function_privilege('anon', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'anon or authenticated retained EXECUTE on acquire_autopilot_execution_claim';
  end if;
  if not has_function_privilege('service_role', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'service_role is missing EXECUTE on acquire_autopilot_execution_claim';
  end if;

  if has_function_privilege('anon', 'public.resolve_autopilot_execution_claim(uuid, text, text, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.resolve_autopilot_execution_claim(uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'anon or authenticated retained EXECUTE on resolve_autopilot_execution_claim';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_autopilot_execution_claim(uuid, text, text, jsonb)', 'EXECUTE') then
    raise exception 'service_role is missing EXECUTE on resolve_autopilot_execution_claim';
  end if;
end
$post$;
