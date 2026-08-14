-- Post-2A.1 execution safety checkpoint: Autopilot at-most-once auto-send.
--
-- LOAD-BEARING INVARIANT: before Duewatch makes any external automatic
-- reminder-send request, it must first atomically acquire a durable,
-- uniquely constrained execution claim for the exact
-- (user_id, invoice_id, rule_id, action_type) identity. Only the caller
-- that wins the claim may make the external send request. This proves
-- AT-MOST-ONCE automatic execution — not exactly-once delivery (Resend
-- delivery itself is outside Duewatch's control).
--
-- Why not reuse an existing table:
--   - awaiting_signature has unique(user_id, invoice_id, status), scoped to
--     the review-queue lifecycle (pending/approved/rejected/...). It is not
--     an execution ledger for auto-sent reminders: the auto-send code path
--     in autopilot-scheduler/index.ts never writes a row there at all, so
--     it cannot record "this rule already auto-sent to this invoice."
--   - events has no unique boundary on (user_id, invoice_id, rule_id,
--     action_type) — it's an append-only activity log, and reminder_sent
--     rows are written AFTER the Resend call, not before, so it cannot
--     serve as the pre-send claim gate the invariant requires.
--   - autopilot_runs is one row per scheduler cycle, not per
--     invoice/rule/action; it has no relevant uniqueness dimension at all.
--
-- Design: reuses the exact atomic-claim pattern already proven in this
-- repo for start_import_run (Phase 1.5B, Blocker 8) — a table with a
-- composite unique constraint on the true identity, and a SECURITY DEFINER
-- function that does INSERT ... ON CONFLICT DO NOTHING RETURNING id, so
-- concurrent callers serialize on the unique index instead of racing a
-- SELECT-then-INSERT. Exactly one caller acquires the claim; every other
-- caller (concurrent or a later scheduler run, regardless of the existing
-- row's status) gets acquired = false and must not attempt the external
-- send. rule_id, action_type, and the caller-supplied deterministic
-- idempotency_key are NOT randomness/time/run-id/snapshot-hash-based —
-- editing the same rule's tone/trigger_days, or running the scheduler
-- again, never manufactures a fresh identity.

create table if not exists public.autopilot_execution_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  -- rule_id intentionally has NO foreign key. autopilot_rules is a real,
  -- RLS-enabled hosted table (see src/lib/autopilot.js's header comment:
  -- "Real columns (already created, RLS enabled)") but its DDL has never
  -- been tracked in this repo's migrations or schema.sql, so a disposable
  -- local Postgres/Supabase instance has no autopilot_rules table to
  -- reference. The (user_id, invoice_id, rule_id, action_type) unique
  -- constraint below is the real execution-identity boundary; it does not
  -- depend on rule_id being FK-valid.
  rule_id uuid not null,
  action_type text not null,
  -- The exact deterministic string sent to the provider as the
  -- Idempotency-Key header (see supabase/functions/_shared/executionClaim.js).
  -- Stored as evidence of what was actually sent, never re-derived here.
  idempotency_key text not null,
  status text not null default 'in_flight',
  provider text not null default 'resend',
  provider_message_id text,
  -- Debug/audit evidence only (e.g. provider error text, rule name at
  -- claim time) — like nextActionAuthority.js's rule snapshot hash, this
  -- is evidence, never itself treated as authorization or identity.
  evidence jsonb not null default '{}',
  claimed_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint autopilot_execution_claims_status_check
    check (status in ('in_flight', 'sent', 'send_failed', 'uncertain')),
  -- The load-bearing constraint: at most one claim row can ever exist for
  -- this identity, for the lifetime of the table. No scheduler run id, no
  -- date/time, no random uuid, no rule snapshot hash is part of it.
  unique (user_id, invoice_id, rule_id, action_type)
);

create index if not exists autopilot_execution_claims_user_idx
  on public.autopilot_execution_claims (user_id, claimed_at desc);

alter table public.autopilot_execution_claims enable row level security;

-- Founders may read their own execution claims (future recovery UI reads
-- this table); they can never insert/update/delete it directly — every
-- write goes through the service-role scheduler, and every insert goes
-- through acquire_autopilot_execution_claim specifically.
drop policy if exists "autopilot_execution_claims_select_own" on public.autopilot_execution_claims;
create policy "autopilot_execution_claims_select_own" on public.autopilot_execution_claims
  for select using (auth.uid() = user_id);

-- ---- privileges (explicit revoke-then-grant, matching the Phase 1.5B
-- privilege-baseline convention — never rely on Postgres's default PUBLIC
-- EXECUTE/table-owner-default grants) ----
revoke all privileges on public.autopilot_execution_claims from PUBLIC, anon, authenticated, service_role;
revoke all privileges (
  id, user_id, invoice_id, rule_id, action_type, idempotency_key,
  status, provider, provider_message_id, evidence, claimed_at, resolved_at
) on public.autopilot_execution_claims from PUBLIC, anon, authenticated, service_role;

grant select on public.autopilot_execution_claims to authenticated;
grant select on public.autopilot_execution_claims to service_role;
-- The scheduler resolves an already-acquired claim (status/provider
-- evidence) directly via the service-role client; it never inserts or
-- deletes a row directly — inserts only ever happen inside
-- acquire_autopilot_execution_claim (SECURITY DEFINER, executes as the
-- function owner, not as service_role), and rows are never deleted.
grant update (status, provider_message_id, evidence, resolved_at)
  on public.autopilot_execution_claims to service_role;

-- ---- atomic claim acquisition ----
-- Called only by the trusted server-side scheduler (service_role). Never
-- exposed to anon/authenticated: this is not a browser-callable RPC.
drop function if exists public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text);
create or replace function public.acquire_autopilot_execution_claim(
  p_user_id uuid,
  p_invoice_id uuid,
  p_rule_id uuid,
  p_action_type text,
  p_idempotency_key text
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
  -- winner's row deterministically once its transaction commits.
  insert into public.autopilot_execution_claims (
    id, user_id, invoice_id, rule_id, action_type, idempotency_key, status, claimed_at
  ) values (
    gen_random_uuid(), p_user_id, p_invoice_id, p_rule_id, p_action_type, p_idempotency_key, 'in_flight', now()
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

revoke all on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text) from PUBLIC, anon, authenticated;
grant execute on function public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text) to service_role;

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
     or has_table_privilege('service_role', 'public.autopilot_execution_claims', 'DELETE') then
    raise exception 'service_role retained INSERT or DELETE on autopilot_execution_claims (inserts must go through acquire_autopilot_execution_claim only)';
  end if;

  if not has_table_privilege('service_role', 'public.autopilot_execution_claims', 'SELECT') then
    raise exception 'service_role is missing SELECT on autopilot_execution_claims';
  end if;

  if has_function_privilege('anon', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text)', 'EXECUTE') then
    raise exception 'anon or authenticated retained EXECUTE on acquire_autopilot_execution_claim';
  end if;

  if not has_function_privilege('service_role', 'public.acquire_autopilot_execution_claim(uuid, uuid, uuid, text, text)', 'EXECUTE') then
    raise exception 'service_role is missing EXECUTE on acquire_autopilot_execution_claim';
  end if;
end
$post$;
